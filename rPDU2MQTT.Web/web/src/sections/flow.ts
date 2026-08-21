// The Sankey: the energy hierarchy drawn as ribbons for one metric at one moment.
import { api, btn, el, ensure, formatNum, svgEl, attachZoom, activate, toast, instanceSelector, withInstance, navLink } from '../helpers.js';
import { liveWhileActive, realtimeLive } from '../realtime.js';
import { setBaseline, refreshDirty } from '../dirty.js';
import { state } from '../state.js';
import { exportData } from '../overrides.js';
import { isAdditiveMetric, metricLabel } from '../flow-vocabulary.js';
import { historyControl, historyQuery, historyNote } from '../history-control.js';
import { withheldBanner, contradictionBanner, contradictionShare } from '../flow-banners.js';
import { focusPath, clearFocus, focusTag, tagToggles, activeTag, showNodeCard, moveNodeCard, hideNodeCard } from '../flow-focus.js';
import { applyHideEmptyPref, applyUnmeasuredPref, collapseGraph, explodeExpandedGroups, ensureGroupState, groupToggles, flowGroups } from '../flow-view.js';
import { flowCandidates, renderNodeManager, syncNodeModal, wouldLoop } from './nodes.js';
import { renderNodeEditor } from './node-editor.js';

// The vocabulary — metrics, node kinds, modes, source types, Modbus shapes — is in flow-vocabulary.ts.

// Editing a node — the form, the topic picker, the Modbus explorer, the rename — is in node-editor.ts.

// Bring an EnergyFlow config up to the current shape in place (idempotent).
export function migrateEnergyFlow(flow: any) {
  const links = ensure(flow, 'Links', []);
  const legacy = ensure(flow, 'Parents', {});
  if (Object.keys(legacy).length) {
    Object.entries(legacy).forEach(([child, parent]) => { if (parent && child && !links.some((l: any) => l.From === parent && l.To === child)) links.push({ From: parent, To: child }); });
    Object.keys(legacy).forEach(k => delete legacy[k]);
  }
  ensure(flow, 'Nodes', []).forEach((n: any) => {
    if (n.Mqtt && n.Mqtt.length) { n.Sources = (n.Sources || []).concat(n.Mqtt.map((s: any) => ({ Type: 'mqtt', ...s }))); delete n.Mqtt; }
    if (n.Value != null && (!n.Mode || n.Mode === 'auto')) n.Mode = 'static';
  });
}

// Save the whole config (both tabs edit the shared EnergyFlow object; either Save persists everything).
export async function saveConfig(onSaved: () => void) {
  const payload = exportData();
  const r = await api('/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  const ok = r.ok && r.body.ok;
  toast(r.body.message || (ok ? 'Saved.' : 'Save failed.'), ok);
  // This writes the same document the shell's save bar tracks, so re-baseline here too.
  if (ok) { setBaseline(payload); onSaved(); }
}

const CONTRADICTION_SHARE = 0.25;

export function addFlowSection(nav: any, sections: any) {
  const link = navLink(nav, "Flow", "⇄");
  // Both tabs edit the shared EnergyFlow object, so their nav entries carry its unsaved-edit count.
  link.dataset.section = "EnergyFlow";
  const sec = document.createElement('div'); sec.className = 'section'; sections.appendChild(sec);
  const h = document.createElement('h2'); h.textContent = 'Energy Flow'; sec.appendChild(h);
  const d = document.createElement('div'); d.className = 'desc';
  d.textContent = 'Live power flow (from the latest poll). Outlet→PDU is auto-derived; add upstream nodes (panels, breakers, a “Total”) and drag to set each node’s feeder to model the full hierarchy. Link width is proportional to the measurement.';
  sec.appendChild(d);

  const bar = document.createElement('div'); bar.className = 'ld-toolbar';
  const refresh = btn('Refresh');
  const instSel = instanceSelector(() => load());
  // Which measurement the flow is drawn by — link widths follow it.
  const metricSel = el('select', { title: 'Draw the flow by this measurement.' }) as HTMLSelectElement;
  [['realpower', 'Power (W)'], ['energytoday', 'Energy today (kWh)'], ['energy', 'Energy, lifetime (kWh)'],
   ['apparentpower', 'Apparent (VA)'], ['current', 'Current (A)']]
    .forEach(([v, t]) => metricSel.appendChild(el('option', { value: v, text: t })));
  const count = document.createElement('span'); count.className = 'ld-count';
  // What window "today" actually means, next to the selector that chose it.
  const animKey = 'rpdu2mqtt.flow.animate';
  const animateFlow = () => localStorage.getItem(animKey) === '1';

  const dayNote = el('span', { class: 'ld-count' }) as HTMLElement;
  dayNote.style.cssText = 'margin-left:8px';
  const showDayNote = async () => {
    dayNote.textContent = '';
    dayNote.removeAttribute('title');
    if (metricSel.value !== 'energytoday') return;
    let p: any;
    try { p = (await api('/api/time')).body?.period; } catch { return; }
    if (!p) return;
    if (!p.tracked) {
      dayNote.textContent = '· daily totals are not being tracked';
      dayNote.style.color = 'var(--warn, #d08700)';
      dayNote.title = 'Set EnergyFlow.Aggregation.TrackPeriods to on. Without it nothing re-bases the counters, and this view has no data to draw.';
      return;
    }
    const hrs = Math.floor(p.secondsUntilRollover / 3600), mins = Math.round(p.secondsUntilRollover % 3600 / 60);
    dayNote.textContent = `· day ${p.key} in ${p.zone}, rolls in ${hrs ? hrs + 'h ' : ''}${mins}m`;
    dayNote.style.color = p.configured && p.resolved ? '' : 'var(--warn, #d08700)';
    dayNote.title = !p.resolved
      ? `The configured zone "${p.configured}" did not resolve on the server; it is using ${p.zone} instead.`
      : p.configured
        ? `Every figure below covers ${p.key} in ${p.zone}, starting ${String(p.startHour).padStart(2, '0')}:00. Server time there is now ${String(p.time).replace('T', ' ').slice(0, 16)}.`
        : `No period time zone is configured, so the server's own zone (${p.zone}) is used — in a container that is usually UTC, which is unlikely to be the day you mean. Set EnergyFlow.Aggregation.PeriodTimeZone.`;
  };
  metricSel.onchange = () => { load(); showDayNote(); };
  bar.appendChild(refresh); bar.appendChild(el('label', { class: 'ld-inst' }, 'Show ', metricSel)); bar.appendChild(instSel.wrap); bar.appendChild(count); bar.appendChild(dayNote); sec.appendChild(bar);
  // Picking a whole day asks an energy question — power at 23:59:59 of a day gone by says almost nothing —
  let hadDay = false;
  const hist = historyControl((what: any) => {
    // Only on the way out of live.
    const leftLive = what === 'day' && !hadDay && !!hist.day();
    hadDay = !!hist.day();
    // Only the daily total can be added across days, so asking for a span asks for that metric.
    if ((leftLive && !hist.time() && metricSel.value === 'realpower') || (what === 'span' && hist.span() > 1)) {
      if (metricSel.value !== 'energytoday') metricSel.value = 'energytoday';
      showDayNote();
    }
    load();
  });
  sec.appendChild(hist.row);
  const wrap = document.createElement('div'); sec.appendChild(wrap);

  // Each job below the diagram gets its own page under Energy Flow, so the Flow page is the diagram.
  const subPage = (label: string, icon: string, desc: string) => {
    const l = navLink(nav, label, icon);
    l.classList.add('nav-child');
    // These edit the same EnergyFlow document as the Flow and Nodes pages, so they carry its edit count.
    l.dataset.section = 'EnergyFlow';
    const s = document.createElement('div'); s.className = 'section'; sections.appendChild(s);
    s.appendChild(el('h2', { text: label }));
    s.appendChild(el('div', { class: 'desc', text: desc }));
    const body = document.createElement('div'); s.appendChild(body);
    return { link: l, sec: s, body };
  };

  const treePage = subPage('Roll-up', '∑',
    'What each node rolls up, per metric: measured leaves report their source, aggregates sum their children, residuals take the remainder.');
  const treePanel = treePage.body;
  const edPage = subPage('Hierarchy', '⑃',
    'How the nodes are wired together. Energy flows left → right.');
  const ed: any = edPage.body;
  const settingsPage = subPage('Settings', '⚙',
    'Everything that governs the energy roll-up and its export. These were scattered across the pages they affected.');
  let lastGraph: any = null;
  // Bindings the server is dropping on purpose.
  let withheldSources: any[] = [];

  // Collapsing/expanding a group must move both graphs together (they share the collapse state).
  const redrawBoth = () => { if (lastGraph) draw(lastGraph); renderTree(); };

  // Each configured node's rolled-up value.
  const renderTree = async () => {
    treePanel.innerHTML = '';
    let r: any; try { r = await api('/api/flow/tree'); } catch { r = { body: { ok: false } }; }
    if (!r.body || !r.body.ok) {
      const dd = document.createElement('div'); dd.className = 'desc';
      dd.textContent = 'Node tree unavailable' + (r.body && r.body.message ? ': ' + r.body.message : ' (single-node cluster or nothing provisioned yet).');
      treePanel.appendChild(dd); return;
    }
    const nodes = r.body.nodes || [];
    if (!nodes.length) {
      const dd = document.createElement('div'); dd.className = 'desc';
      dd.textContent = 'No node values yet — add energy-flow nodes and feed a source; they are rolled up here.';
      treePanel.appendChild(dd); return;
    }

    ensureGroupState();
    const toggles = groupToggles(redrawBoth, false);
    if (toggles) treePanel.appendChild(toggles);

    const t = document.createElement('table'); t.className = 'ld';
    const hr = document.createElement('tr'); ['Node', 'Rolled-up values'].forEach(x => { const th = document.createElement('th'); th.textContent = x; hr.appendChild(th); });
    const thead = document.createElement('thead'); thead.appendChild(hr); t.appendChild(thead);
    const tb = document.createElement('tbody');

    const metricsText = (metrics: any[]) => (metrics || []).map((m: any) => m.metric + ': ' + formatNum(m.value)).join(', ');
    const byNode: any = {}; nodes.forEach((n: any) => { byNode[n.node] = n; });

    const row = (label: string, metrics: any[], opts?: { indent?: boolean; head?: boolean }) => {
      const tr = document.createElement('tr');
      const c1 = document.createElement('td'); c1.textContent = label;
      if (opts?.indent) c1.style.paddingLeft = '24px';
      if (opts?.head) c1.style.fontWeight = '600';
      const c2 = document.createElement('td'); c2.style.cssText = 'color:var(--muted);font-size:12px;';
      c2.textContent = metricsText(metrics);
      tr.appendChild(c1); tr.appendChild(c2); tb.appendChild(tr);
    };

    // Sum a group's members per metric — only members that actually have a value.
    const groupMetrics = (g: any) => {
      const sums: Record<string, number> = {};
      (g.Members || []).forEach((m: string) => (byNode[m]?.metrics || []).forEach((mm: any) => { sums[mm.metric] = (sums[mm.metric] || 0) + mm.value; }));
      return Object.entries(sums).map(([metric, value]) => ({ metric, value }));
    };

    // Members are shown under their group (summed when collapsed, listed when expanded), never twice.
    const allMembers = new Set<string>();
    flowGroups().forEach((g: any) => (g.Members || []).forEach((m: string) => allMembers.add(m)));

    nodes.forEach((n: any) => { if (!allMembers.has(n.node)) row(n.node, n.metrics); });

    flowGroups().forEach((g: any) => {
      row((g.Label || g.Id) + '  (group)', groupMetrics(g), { head: true });
      if (!collapsedGroups.has(g.Id))
        (g.Members || []).forEach((m: string) => { if (byNode[m]) row(byNode[m].node, byNode[m].metrics, { indent: true }); });
    });

    t.appendChild(tb); treePanel.appendChild(t);
  };

  // Layered Sankey: columns = longest path from a root (energy flows left->right, parent->child).
  const draw = (graph: any) => {
    wrap.innerHTML = '';
    ensureGroupState();
    // Fold collapsed groups into single nodes before laying out; the toggle strip re-draws on change.
    const collapsed = collapseGraph((graph.nodes || []).slice(), (graph.links || []).slice());
    // ...then substitute the members for the anchor on any group left expanded.
    const expanded = explodeExpandedGroups(collapsed.nodes, collapsed.links);
    // ...then honour the unmetered-remainder view switch...
    const shown = applyUnmeasuredPref(expanded.nodes, expanded.links);
    // ...and finally drop the branches carrying nothing, if that switch is on.
    const folded = applyHideEmptyPref(shown.nodes, shown.links);
    const toggles = groupToggles(redrawBoth);
    if (toggles) wrap.appendChild(toggles);
    const links = folded.links;
    const nodes = folded.nodes;
    if (!links.length) { wrap.innerHTML = '<div class="desc" style="color:var(--muted)">No measured power flow to display. Define an EnergyFlow hierarchy, or check that outlets report power.</div>'; count.textContent = ''; return; }

    const units = graph.units || '';
    // Which metric is actually on screen.
    const lifetimeEnergy = String(graph.metric || metricSel.value || '').toLowerCase() === 'energy';
    const incoming: any = {}, outgoing: any = {};
    nodes.forEach((n: any) => { incoming[n.id] = []; outgoing[n.id] = []; });
    links.forEach((l: any) => { (outgoing[l.source] = outgoing[l.source] || []).push(l); (incoming[l.target] = incoming[l.target] || []).push(l); });
    // The server decides a node's value and, crucially, whether one is known at all.
    const byId: any = {};
    nodes.forEach((n: any) => { byId[n.id] = n; });
    const known = (id: string) => byId[id] && byId[id].value != null;
    const nodeValue = (id: string) => known(id) ? byId[id].value : 0;

    // Column index = longest path from a root (a node with no incoming links).
    const colMemo: any = {};
    const col = (id: string, seen?: Set<string>): number => {
      if (colMemo[id] != null) return colMemo[id];
      seen = seen || new Set();
      if (seen.has(id)) return 0;
      seen.add(id);
      const ins = incoming[id] || [];
      const c = ins.length ? Math.max(...ins.map((l: any) => col(l.source, seen) + 1)) : 0;
      seen.delete(id);
      return colMemo[id] = c;
    };
    nodes.forEach((n: any) => col(n.id));

    // Then pull every node as far RIGHT as its nearest child allows, so it lands next to what it powers.
    nodes.slice().sort((a: any, b: any) => colMemo[b.id] - colMemo[a.id]).forEach((n: any) => {
      const outs = outgoing[n.id] || [];
      if (outs.length) colMemo[n.id] = Math.max(0, Math.min(...outs.map((l: any) => colMemo[l.target])) - 1);
    });
    // Never leave an empty left margin if every node pulled off column 0.
    const minCol = Math.min(...nodes.map((n: any) => colMemo[n.id]));
    if (minCol > 0) nodes.forEach((n: any) => { colMemo[n.id] -= minCol; });

    const maxCol = Math.max(0, ...nodes.map((n: any) => colMemo[n.id]));

    const cols: any[] = [];
    nodes.forEach((n: any) => { const c = colMemo[n.id]; (cols[c] = cols[c] || []).push(n); });


    const W = 960, padTop = 22, gap = 8, nodeW = 12, usableH = 520;
    // Labels sit to the right of each node, so reserve a right gutter for them and only a small left pad.
    const leftPad = 16, rightGutter = 232;
    // What the node has to be tall enough to carry: its own reading.
    const throughput = (id: string) => {
      let inSum = 0, outSum = 0;
      (incoming[id] || []).forEach((l: any) => { if (l.known !== false) inSum += l.value || 0; });
      (outgoing[id] || []).forEach((l: any) => { if (l.known !== false) outSum += l.value || 0; });
      return Math.max(nodeValue(id) || 0, inSum, outSum);
    };

    const maxTotal = Math.max(1, ...cols.map(cn => cn.reduce((s: number, n: any) => s + throughput(n.id), 0)));
    const pxPerUnit = usableH / maxTotal;
    const colX = (c: number) => leftPad + (maxCol > 0 ? c * ((W - leftPad - rightGutter - nodeW) / maxCol) : 0);

    const pos: any = {};
    // Every node's label needs a full text line, whatever its bar height.
    const labelRow = 15;
    // A link's pull on the layout.
    const wFloor = maxTotal / 1000;
    const linkW = (l: any) => Math.max(l.value || 0, wFloor);
    // Barycenter of the feeders that are already positioned (forward pass) …
    const bary = (id: string) => { let w = 0, s = 0; (incoming[id] || []).forEach((l: any) => { const sp = pos[l.source]; if (sp) { s += (sp.y + sp.h / 2) * linkW(l); w += linkW(l); } }); return w ? s / w : Infinity; };
    // … and of what it feeds (backward pass), so a source column can be pulled level with its targets.
    const obary = (id: string) => { let w = 0, s = 0; (outgoing[id] || []).forEach((l: any) => { const tp = pos[l.target]; if (tp) { s += (tp.y + tp.h / 2) * linkW(l); w += linkW(l); } }); return w ? s / w : Infinity; };

    // Stack one column top-to-bottom in its current order; returns the y it ended at.
    const placeColumn = (cn: any[], c: number) => {
      let y = padTop;
      cn.forEach((n: any) => {
        // Bar height is proportional to what actually passes THROUGH the node, not to its own reading.
        const h = known(n.id) ? Math.max(2, throughput(n.id) * pxPerUnit) : 3;
        const rowH = Math.max(h, labelRow);
        pos[n.id] = { x: colX(c), y: y + (rowH - h) / 2, h, outOff: 0, inOff: 0 };
        y += rowH + gap;
      });
      return y;
    };

    // The unmetered remainder sits below its measured SIBLINGS (#366) — the ones fed by the same node, not
    // every measured node in the column. Sorting it below the whole column is what put PDU-1's remainder
    // underneath PDU-2's devices, so its ribbon had to cross every one of them to get there. The feeder
    // barycenter therefore leads: it groups each parent's children together, and the remainder settles at
    // the bottom of its own group.
    const remainder = (id: string) => (id || '').includes('#unmeasured') ? 1 : 0;

    // Forward: roots stack by size, downstream columns follow their feeders (groups children, avoids crossings).
    cols.forEach((cn, c) => {
      if (c === 0) cn.sort((a: any, b: any) => remainder(a.id) - remainder(b.id) || nodeValue(b.id) - nodeValue(a.id));
      else cn.sort((a: any, b: any) => (bary(a.id) - bary(b.id)) || (remainder(a.id) - remainder(b.id)) || (nodeValue(b.id) - nodeValue(a.id)));
      placeColumn(cn, c);
    });
    // Backward: right-to-left, order each column by what it feeds.
    for (let c = cols.length - 2; c >= 0; c--) {
      if (!cols[c]) continue;
      cols[c].sort((a: any, b: any) => (obary(a.id) - obary(b.id)) || (remainder(a.id) - remainder(b.id)) || (nodeValue(b.id) - nodeValue(a.id)));
      placeColumn(cols[c], c);
    }
    // Re-place left-to-right in the settled order so every column shares one top edge and the offsets reset.
    let bottom = padTop;
    cols.forEach((cn, c) => { bottom = Math.max(bottom, placeColumn(cn, c)); });

    // Then slide each column bodily down to meet what it feeds.
    /// Where each ribbon actually meets each bar, in the order they are drawn.
    ///
    /// A ribbon leaves a bar at `y + outOff` and arrives at `y + inOff`, both accumulating from the TOP of
    /// the bar. Relaxing a column toward its neighbours' bar CENTRES therefore aims at a point no ribbon
    /// touches: a 3,012 W panel whose drawn children total 875 W carries all of them in the top sixth of
    /// its bar, and its children get pulled to the middle of a bar they never reach.
    const attachments = () => {
      const at = new Map<any, { from: number; to: number }>();
      const outOff: Record<string, number> = {}, inOff: Record<string, number> = {};
      [...links]
        .sort((a: any, b: any) =>
          (pos[a.target]?.y ?? 0) - (pos[b.target]?.y ?? 0) ||
          (pos[a.source]?.y ?? 0) - (pos[b.source]?.y ?? 0))
        .forEach((l: any) => {
          const sp = pos[l.source], tp = pos[l.target];
          if (!sp || !tp) return;
          const h = l.known === false || l.value * pxPerUnit < 1.5 ? 1.5 : l.value * pxPerUnit;
          const so = outOff[l.source] || 0, to = inOff[l.target] || 0;
          at.set(l, { from: sp.y + so + h / 2, to: tp.y + to + h / 2 });
          outOff[l.source] = so + h;
          inOff[l.target] = to + h;
        });
      return at;
    };

    const relaxOrder = [...Array(cols.length).keys()].reverse().concat([...Array(cols.length).keys()]);
    for (const c of relaxOrder) {
      const cn = cols[c];
      if (!cn || !cn.length) continue;
      const at = attachments();
      let w = 0, s = 0;
      cn.forEach((n: any) => {
        // Both sides, not just what it feeds, and each side measured where the ribbon lands.
        (outgoing[n.id] || []).forEach((l: any) => {
          const a = at.get(l);
          if (!a) return;
          s += (a.to - a.from) * linkW(l);
          w += linkW(l);
        });
        (incoming[n.id] || []).forEach((l: any) => {
          const a = at.get(l);
          if (!a) return;
          s += (a.from - a.to) * linkW(l);
          w += linkW(l);
        });
      });
      if (!w) continue;
      // Never above the top margin, and never so far down that the column leaves the canvas.
      const top = Math.min(...cn.map((n: any) => pos[n.id].y));
      const foot = Math.max(...cn.map((n: any) => pos[n.id].y + pos[n.id].h));
      const shift = Math.max(padTop - top, Math.min(s / w, Math.max(padTop, bottom) - foot));

      // Only rescue a column that has genuinely come adrift; leave a well-placed one alone.
      const reach = Math.max(8, (foot - top) / 2);
      if (Math.abs(shift) < reach) continue;
      cn.forEach((n: any) => { pos[n.id].y += shift; });
    }

    // Fit the viewBox to the tallest column (stacking gaps push it past usableH), so nothing clips.
    const totalH = Math.ceil(Math.max(padTop + usableH, bottom)) + padTop;
    const svg = svgEl('svg', { viewBox: `0 0 ${W} ${totalH}`, width: W, height: totalH, style: 'display:block' });
    const colors = ['#49f', '#4f9', '#fa4', '#f49', '#9f4', '#4ff', '#f94', '#a9f'];
    // Clicking the empty canvas is the natural "never mind"; a redraw starts unfocused either way.
    svg.addEventListener('click', () => clearFocus(svg));
    focusedNode = null;

    // Ribbons (filled bezier bands).
    let flowClipSeq = 0;
    links.sort((a: any, b: any) =>
      (pos[a.target]?.y ?? 0) - (pos[b.target]?.y ?? 0) ||
      (pos[a.source]?.y ?? 0) - (pos[b.source]?.y ?? 0)
    ).forEach((l: any) => {
      const s = pos[l.source], t = pos[l.target];
      if (!s || !t) return;
      // An unknown link draws as a hairline: the wiring is real, the quantity isn't known.
      const unknownLink = l.known === false;
      const idleLink = !unknownLink && l.value * pxPerUnit < 1.5;
      const h = (unknownLink || idleLink) ? 1.5 : l.value * pxPerUnit;
      const x1 = s.x + nodeW, x2 = t.x, xc = (x1 + x2) / 2;
      const sTop = s.y + s.outOff, tTop = t.y + t.inOff;
      const color = colors[colMemo[l.source] % colors.length];
      const ribbonPath = `M${x1},${sTop} C${xc},${sTop} ${xc},${tTop} ${x2},${tTop} L${x2},${tTop + h} C${xc},${tTop + h} ${xc},${sTop + h} ${x1},${sTop + h} Z`;
      svg.appendChild(svgEl('path', {
        d: ribbonPath,
        fill: unknownLink ? 'var(--muted)' : color,
        // A hairline at ribbon opacity is invisible; lift it so an idle branch still reads as connected.
        'fill-opacity': unknownLink ? '0.35' : idleLink ? '0.55' : '0.3',
        // Endpoints in the markup so focusing a supply path is a CSS class flip, not a repaint.
        'data-src': l.source, 'data-dst': l.target,
      }));

      // A stream drawn along the ribbon's centre line.
      if (animateFlow() && !unknownLink && !idleLink) {
        // The stream is the band, not a line drawn down the middle of it.
        const clipId = `fs${flowClipSeq++}`;
        const clip = svgEl('clipPath', { id: clipId });
        clip.appendChild(svgEl('path', { d: ribbonPath }));
        svg.appendChild(clip);

        // Lanes of thin particles, not one stroke as tall as the band.
        const lanes = Math.max(1, Math.min(6, Math.round(h / 16)));
        const laneW = Math.max(1.5, Math.min(3.5, (h / lanes) * 0.4));
        // Faster where the flow is denser, clamped either side so nothing crawls or strobes.
        const intensity = l.value / Math.max(1, maxTotal);
        const duration = Math.max(0.9, Math.min(6, 3.2 - intensity * 9));

        for (let i = 0; i < lanes; i++) {
          const f = (i + 0.5) / lanes;                       // this lane's position across the band
          const sY = sTop + h * f, tY = tTop + h * f;
          const stream = svgEl('path', {
            d: `M${x1},${sY} C${xc},${sY} ${xc},${tY} ${x2},${tY}`,
            fill: 'none', stroke: color, 'stroke-opacity': lanes > 1 ? '0.42' : '0.5',
            'stroke-width': laneW,
            'stroke-linecap': 'round',
            'stroke-dasharray': '9 31',
            'clip-path': `url(#${clipId})`,
            class: 'flow-stream',
            'data-src': l.source, 'data-dst': l.target,
          });
          stream.style.animationDuration = `${duration.toFixed(2)}s`;
          // Stagger the lanes so they read as a current rather than as one blinking comb.
          stream.style.animationDelay = `${(-duration * (i / Math.max(1, lanes))).toFixed(2)}s`;
          svg.appendChild(stream);
        }
      }

      s.outOff += h; t.inOff += h;
    });

    // A group reads like a node: click the group node to toggle it.
    const memberGroup: Record<string, any> = {};
    const groupById: Record<string, any> = {};
    flowGroups().forEach((g: any) => { groupById[g.Id] = g; (g.Members || []).forEach((m: string) => { memberGroup[m] = g; }); });

    // Nodes + labels, to the right of each node and vertically centered, with a bg halo over ribbons.
    const contradicted: { id: string, label: string, share: number }[] = [];
    nodes.forEach((n: any) => {
      const p = pos[n.id]; if (!p) return;
      const unknownNode = !known(n.id);
      const rect = svgEl('rect', {
        x: p.x, y: p.y, width: nodeW, height: p.h, rx: 2,
        fill: unknownNode ? 'var(--muted)' : colors[colMemo[n.id] % colors.length],
        'fill-opacity': unknownNode ? '0.45' : '1',
        'data-node': n.id,
      });
      svg.appendChild(rect);
      const lab = svgEl('text', {
        x: p.x + nodeW + 6, y: p.y + p.h / 2, fill: 'var(--fg)', 'font-size': '11', 'font-weight': n.kind === 'outlet' ? '400' : '600',
        'dominant-baseline': 'middle', 'paint-order': 'stroke', stroke: 'var(--panel2)', 'stroke-width': '3', 'stroke-linejoin': 'round',
        'data-node': n.id,
      });
      // A <title> must not be a child of <text>: its text node would become part of the <text> element's content.
      const labGroup = svgEl('g', {});
      const explain = (text: string) => {
        const t = svgEl('title');
        t.textContent = text;
        labGroup.appendChild(t);
      };
      // An inferred figure is never dressed as a measured one.
      const inferredNode = n.derivation === 'inferred';
      lab.textContent = unknownNode ? `${n.label} · no data`
        : `${n.label} · ${formatNum(nodeValue(n.id))} ${units}${inferredNode ? ' · inferred' : ''}`;
      if (unknownNode) {
        lab.setAttribute('fill', 'var(--muted)');
        lab.setAttribute('font-style', 'italic');
        explain('Nothing measures this node, and no single path determines it. Bind a live source to it, or mark one of its feeders as "residual" to say where the remainder comes from.');
      }
      // More leaves this node than arrives at it — not a state the hardware can be in.
      else if (inferredNode) {
        lab.setAttribute('font-style', 'italic');
        lab.setAttribute('fill-opacity', '0.85');
        explain('Nothing measures this node. The figure is what conservation requires: the load '
          + 'downstream is really being drawn, and the hierarchy you drew leaves exactly one path it could '
          + 'have arrived by. It is only as true as that hierarchy. Bind a source to measure it, or turn off '
          + '"Infer from a single supply path" under Energy roll-up to show no data instead.');
      }
      else if (n.imbalance != null) {
        lab.textContent += ' ⚠';
        const reading = nodeValue(n.id);
        // Past the line the node is named in a banner above the chart; the number is still shown.
        const share = lifetimeEnergy ? null : contradictionShare(n, reading);
        if (share != null && share >= CONTRADICTION_SHARE) {
          lab.setAttribute('fill', 'var(--warn, #d08700)');
          lab.setAttribute('class', 'flow-contradicted');
          contradicted.push({ id: n.id, label: n.label, share });
        }
        // Two different discrepancies wear the same marker, and they need different sentences.
        explain(n.derivation === 'measured'
          ? `This node reports ${formatNum(reading)} ${units}, but ${formatNum(reading + n.imbalance)} ${units} `
            + `passes through it — ${formatNum(n.imbalance)} ${units} more than it accounts for. Its sensor is `
            + 'probably measuring one leg rather than the whole node (an inverter bound to its AC-load output '
            + 'while it also charges a battery), or a source is scaled wrongly. The bar is drawn to the '
            + 'throughput so the ribbons fit; the label is the reading.'
          : `This node passes ${formatNum(reading)} ${units} to what it feeds, but only `
            + `${formatNum(reading - n.imbalance)} ${units} arrives from its feeders — a shortfall of `
            + `${formatNum(n.imbalance)} ${units}, which no supply accounts for.`
            + (metricSel.value === 'energy'
              ? ' On lifetime energy this is expected: these counters started at different times and cannot be compared. Switch to "Energy today", where every figure covers the same window.'
              : ' Check that the feeders into this node are all wired and reporting.'));
      }
      labGroup.appendChild(lab);
      svg.appendChild(labGroup);

        // Hovering a node explains it: what it is, what it reads, what feeds it and what it feeds.
      const card = () => {
        const rows: any[] = [];
        rows.push(el('div', { class: 'nh-title', text: n.label }));
        rows.push(el('div', { class: 'nh-sub', text: `${n.kind || 'node'} · ${n.id}` }));
        rows.push(el('div', { class: 'nh-value' + (unknownNode ? ' nh-unknown' : '') },
          unknownNode ? 'no data' : `${formatNum(nodeValue(n.id))} ${units}`.trim(),
          el('span', { class: 'nh-metric', text: ' ' + metricLabel(metricSel.value).toLowerCase() })));
        // Provenance sits with the value, not in a legend somewhere else.
        if (!unknownNode && n.derivation && n.derivation !== 'measured')
          rows.push(el('div', { class: n.derivation === 'inferred' ? 'nh-warn' : 'desc', style: { margin: '2px 0 0' } },
            n.derivation === 'inferred'
              ? 'inferred — nothing measures this; conservation leaves one path it could have come by'
              : 'summed from what it feeds'));
        if (n.imbalance != null)
          rows.push(el('div', { class: 'nh-warn', text: `${formatNum(n.imbalance)} ${units} more leaves than arrives` }));
        // A sensor on one leg of a bidirectional device.
        if (n.throughput != null)
          rows.push(el('div', { class: 'desc', style: { margin: '2px 0 0' },
            text: `its sensor covers this leg; ${formatNum(n.throughput)} ${units} passes through the node` }));

        const side = (title: string, ls: any[], other: (l: any) => string) => {
          if (!ls.length) return;
          rows.push(el('div', { class: 'nh-head', text: title }));
          ls.forEach((l: any) => rows.push(el('div', { class: 'nh-row' },
            el('span', { class: 'nh-name', text: byId[other(l)]?.label || other(l) }),
            el('span', { class: 'nh-num', text: l.known === false ? '—' : `${formatNum(l.value)} ${units}`.trim() }))));
        };
        side('Fed by', incoming[n.id] || [], (l: any) => l.source);
        side('Feeds', outgoing[n.id] || [], (l: any) => l.target);

        // What the node is bound to, so a wrong topic or register is visible from the diagram itself.
        const cfg = (state.data?.EnergyFlow?.Nodes || []).find((x: any) => x.Id === n.id);
        const bound = (cfg?.Sources || []).concat(cfg?.Mqtt ? cfg.Mqtt.map((m: any) => ({ Type: 'mqtt', ...m })) : []);
        if (bound.length) {
          rows.push(el('div', { class: 'nh-head', text: 'Bound sources' }));
          bound.forEach((s: any) => rows.push(el('div', { class: 'nh-row' },
            el('span', { class: 'nh-name', text: metricLabel(s.Metric) }),
            el('span', { class: 'nh-src', text: s.Type === 'modbus' ? `${s.Connection || 'modbus'} reg ${s.Register}` : (s.Topic || '') }))));
        } else if (cfg) {
          rows.push(el('div', { class: 'nh-head', text: cfg.Value != null ? 'Fixed value' : 'No source bound' }));
        }
        return rows;
      };
      [rect, lab].forEach((elm: any) => {
        elm.addEventListener('mouseenter', (e: any) => showNodeCard(sec, e, card()));
        elm.addEventListener('mousemove', (e: any) => moveNodeCard(e));
        elm.addEventListener('mouseleave', hideNodeCard);
      });

      // Click to trace where this node's supply comes from: everything upstream stays lit, the rest dims.
      if (!(n.group || memberGroup[n.id] || groupById[n.id])) {
        [rect, lab].forEach((elm: any) => {
          elm.style.cursor = 'pointer';
          elm.addEventListener('click', (e: any) => { e.stopPropagation?.(); focusPath(svg, incoming, n.id); });
        });
      }

    // Group node (collapsed), an anchor node (expanded), or a member: make the node the expand/collapse control.
      const grp = n.group ? n : (memberGroup[n.id] || groupById[n.id]);
      if (grp) {
        const gid = n.group ? n.id : grp.Id;
        const toggle = () => { collapsedGroups.has(gid) ? collapsedGroups.delete(gid) : collapsedGroups.add(gid); redrawBoth(); };
        [rect, lab].forEach(elm => { elm.style.cursor = 'pointer'; elm.addEventListener('click', toggle); });
        const hint = svgEl('title');
        hint.textContent = n.group ? `“${n.label}” groups ${(grp.Members || []).length} node(s) — click to expand`
          : grp.Id === n.id ? `Group of ${(grp.Members || []).length} node(s) — click to collapse`
          : `In group “${grp.Label || grp.Id}” — click to collapse`;
        rect.appendChild(hint);
        if (n.group) lab.textContent = '▸ ' + lab.textContent;   // an affordance that this node opens up
      }
    });

    // Surface the unknowns rather than leaving them to be spotted.
    const unknownCount = nodes.filter((n: any) => !known(n.id)).length;
    count.textContent = `${nodes.length} node(s) · ${links.length} link(s)`
      + (unknownCount ? ` · ${unknownCount} with no data` : '');
    count.title = unknownCount
      ? 'Nothing measures these nodes, and no single path determines them. Bind a source, or mark a feeder "residual" to say where the remainder comes from — values are never invented for them.'
      : '';
    // Tag chips, above the banners: they change what is emphasised, not what is being reported.
    const taggedById = new Map<string, any>(nodes.map((n: any) => [n.id, n]));
    const applyTag = (tag: string | null) => {
      if (tag) focusTag(svg, taggedById, tag); else clearFocus(svg);
      const fresh = tagToggles(nodes, svg, applyTag);
      if (fresh && tagRow.parentNode) { tagRow.replaceWith(fresh); tagRow = fresh; }
    };
    let tagRow = tagToggles(nodes, svg, applyTag) as any;
    if (tagRow) {
      wrap.appendChild(tagRow);
      // Re-apply across the live repaint, so the selection survives a push.
      if (activeTag) focusTag(svg, taggedById, activeTag);
    }

    if (withheldSources.length) wrap.appendChild(withheldBanner(withheldSources));
    if (contradicted.length) wrap.appendChild(contradictionBanner(contradicted, (id) => focusPath(svg, incoming, id)));

    // No height cap: the diagram is the whole page, so it grows to its own height and the page scrolls once
    // — a pane capped at 74vh put a scrollbar inside a scrollbar and made the graph feel like an iframe.
    const scroll = el('div', { style: { overflow: 'auto', border: '1px solid var(--line)', borderRadius: '6px' } });
    scroll.appendChild(svg);
    const stage = el('div', { class: 'flow-stage' }, scroll);
    wrap.appendChild(stage);

    const zoom = attachZoom(scroll, svg, W, totalH, true);  // container is replaced on each draw(), so no leak.

    // Zoom where the diagram is, not in a toolbar under it: on a graph this size the reader's attention is
    // already inside the pane.
    const zoomBtn = (label: string, title: string, act: () => void) => {
      const b = btn(label);
      b.title = title;
      b.onclick = act;
      return b;
    };
    stage.appendChild(el('div', { class: 'flow-zoom' },
      zoomBtn('+', 'Zoom in', () => (zoom as any).zoomBy(1.2)),
      zoomBtn('−', 'Zoom out', () => (zoom as any).zoomBy(1 / 1.2)),
      zoomBtn('⤢', 'Fit the diagram to the page', () => (zoom as any).fit())));

    // The gesture line names what the device can actually do — a phone has neither a wheel nor a Ctrl key,
    // and being told to use them while the diagram sits three screens wide is its own kind of broken.
    const hints = el('div', { class: 'desc flow-gestures', style: { margin: '4px 2px 0', fontSize: '11px', display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } });
    const fitBtn = btn('Fit');
    fitBtn.onclick = () => (zoom as any).fit();
    fitBtn.style.padding = '1px 8px';
    fitBtn.style.fontSize = '11px';
    hints.appendChild(fitBtn);
    hints.appendChild(el('span', { text: 'Drag or swipe to pan · pinch to zoom · Ctrl/⌘ + scroll to zoom.' }));
    wrap.appendChild(hints);
  };

  // --- Settings: everything under EnergyFlow that isn't a node, a link or a group.
  const renderSettings = () => {
    const flow = ensure(state.data, 'EnergyFlow', {});
    migrateEnergyFlow(flow);
    const agg = ensure(flow, 'Aggregation', {});
    const body = settingsPage.body;
    body.innerHTML = '';

    const bar3 = el('div', { class: 'ld-toolbar' });
    const save = btn('Save', 'primary');
    save.onclick = () => saveConfig(load);
    bar3.append(save); body.appendChild(bar3);

    // MQTT export of the hierarchy (#164): each tier's rolled-up value is published per poll.
    body.appendChild(el('h3', { text: 'MQTT export', style: { margin: '14px 0 4px' } }));
    const exportRow = el('div', { class: 'ld-toolbar' });
    const topicIn = el('input', { type: 'text', placeholder: '{parent}/energyflow/{id}', style: { width: '280px' } });
    topicIn.value = flow.MqttTopicTemplate || '';
    topicIn.disabled = !flow.MqttExport;
    topicIn.onchange = () => { flow.MqttTopicTemplate = topicIn.value.trim() || undefined; refreshDirty(); };
    const expChk = el('input', { type: 'checkbox' }); expChk.checked = !!flow.MqttExport;
    expChk.onchange = () => { flow.MqttExport = expChk.checked; topicIn.disabled = !expChk.checked; refreshDirty(); };
    exportRow.append(el('label', {}, expChk, ' Export tiers to MQTT'), el('span', { class: 'desc', style: { margin: '0' }, text: 'Topic:' }), topicIn);
    body.appendChild(exportRow);

    // How the energy roll-up is accumulated, and when the day ends.
    body.appendChild(el('h3', { text: 'Energy roll-up', style: { margin: '14px 0 4px' } }));
    body.appendChild(el('div', { class: 'desc' },
      'Daily totals re-base every node and outlet at the same moment, so the figures can be compared and summed. '
      + 'Lifetime counters can’t: a PDU’s has run since it was commissioned, a node’s since you bound it. '
      + 'Draw the diagram with Show → “Energy today”.'));

    const aggRow = el('div', { class: 'ld-toolbar' });

    const trackChk = el('input', { type: 'checkbox' }) as HTMLInputElement;
    trackChk.checked = agg.TrackPeriods !== false;   // defaults on
    const zoneSel = el('select', { style: { minWidth: '200px' } }) as HTMLSelectElement;
    const hourSel = el('select') as HTMLSelectElement;
    for (let h = 0; h < 24; h++) hourSel.appendChild(el('option', { value: String(h), text: String(h).padStart(2, '0') + ':00' }));
    hourSel.value = String(agg.PeriodStartHour || 0);

    // Zones come from the schema, which the server filled with the ones IT can resolve.
    const zoneNode = (state.schema || []).find((n: any) => n.key === 'EnergyFlow')?.properties
      ?.find((n: any) => n.key === 'Aggregation')?.properties?.find((n: any) => n.key === 'PeriodTimeZone');
    const zones: string[] = zoneNode?.enumValues || [''];
    zones.forEach(z => zoneSel.appendChild(el('option', { value: z, text: z || '(server’s own zone)' })));
    zoneSel.value = agg.PeriodTimeZone || '';

    const syncAgg = () => {
      zoneSel.disabled = hourSel.disabled = !trackChk.checked;
      agg.TrackPeriods = trackChk.checked;
      agg.PeriodTimeZone = zoneSel.value || undefined;
      agg.PeriodStartHour = Number(hourSel.value) || undefined;
      refreshDirty();
      showDayNote();
    };
    trackChk.onchange = zoneSel.onchange = hourSel.onchange = syncAgg;
    zoneSel.disabled = hourSel.disabled = !trackChk.checked;

    aggRow.append(
      el('label', {}, trackChk, ' Track daily totals'),
      el('span', { class: 'desc', style: { margin: '0' }, text: 'Day ends at:' }), hourSel, zoneSel);
    body.appendChild(aggRow);

    // The server's own clock, right where the boundary is set — it is the clock the day is cut on.
    const clock = el('div', { class: 'desc' }) as HTMLElement;
    body.appendChild(clock);
    api('/api/time').then((r: any) => {
      const t = r.body; if (!t || !t.ok || !t.host || !t.period) return;
      const p = t.period;
      clock.textContent = `Server clock: ${String(t.host.time).replace('T', ' ').slice(0, 19)} (${t.host.zone}). `
        + (p.tracked
          ? `Current day ${p.key}, next rollover ${String(p.nextRolloverLocal).replace('T', ' ').slice(0, 16)} ${p.zone}.`
          : 'Daily totals are off, so “Energy today” has nothing to draw.');
      if (p.tracked && !p.resolved) {
        clock.textContent += ` The saved zone "${p.configured}" does not exist on the server — it is using ${p.zone}.`;
        clock.style.color = 'var(--bad, #d05a5a)';
      } else if (p.tracked && !p.configured) {
        clock.textContent += ' No zone set, so the server’s own is used — usually UTC in a container.';
        clock.style.color = 'var(--warn, #d08700)';
      }
    }).catch(() => { });

    body.appendChild(el('h3', { text: 'What the diagram may state', style: { margin: '14px 0 4px' } }));

    // Conservation back-fill. A switch you can see.
    const inferRow = el('div', { class: 'desc' }) as HTMLElement;
    const inferChk = el('input', { type: 'checkbox' }) as HTMLInputElement;
    inferChk.checked = flow.InferFromConservation !== false;   // defaults on
    inferChk.onchange = () => { flow.InferFromConservation = inferChk.checked ? undefined : false; refreshDirty(); };
    inferRow.append(el('label', {}, inferChk,
      ' Infer from a single supply path — fill in an unmeasured node from what it feeds, when only one path could have supplied it. Results are labelled “inferred”; off shows “no data”.'));
    body.appendChild(inferRow);

    const aggIntegrate = el('div', { class: 'desc' }) as HTMLElement;
    const intChk = el('input', { type: 'checkbox' }) as HTMLInputElement;
    intChk.checked = !!agg.Enabled;
    intChk.onchange = () => { agg.Enabled = intChk.checked; refreshDirty(); };
    aggIntegrate.append(el('label', {}, intChk,
      ' Derive kWh from power for nodes that report only watts (an estimate — a real energy source always wins)'));
    body.appendChild(aggIntegrate);

    // Three switches deliberately not gathered here: they sit on the diagram they change.
    body.appendChild(el('div', { class: 'desc', style: { marginTop: '14px' } },
      'The “Hide empty”, “Unmeasured load” and “Animate flow” switches stay on the Flow page: they change '
      + 'what the diagram shows rather than what is configured, and they are per-browser — nothing here is '
      + 'saved by them.'));
  };

  // --- Hierarchy editor: a layered, left→right arrow graph (energy flows source → target).
  const colors = ['#4f8cff', '#46c46a', '#fa4', '#f49', '#9f4', '#4ff'];
  const NW = 190, NH = 46;

  const renderEditor = () => {
    if (ed._cleanup) ed._cleanup();
    const flow = ensure(state.data, 'EnergyFlow', {});
    migrateEnergyFlow(flow);
    const customNodes = ensure(flow, 'Nodes', []);
    const links = ensure(flow, 'Links', []);
    ed.innerHTML = '';

    ed.appendChild(el('div', { class: 'desc', text: 'Drag from a node’s right ● onto another node to add a feed (source powers target); click ✕ on a link to remove it. Double-click a custom node to rename it. PDU → outlet links are auto-derived (dashed) until you wire an explicit feeder. Add and configure nodes on the Nodes tab.' }));

    const bar2 = el('div', { class: 'ld-toolbar' });
    const save = btn('Save', 'primary');
    save.onclick = () => saveConfig(load);
    bar2.append(save); ed.appendChild(bar2);

    // Candidate nodes (from the built graph + custom defs).
    const cand = flowCandidates(lastGraph, customNodes);
    const nm = (id: string): string => (cand.get(id) || {}).label || id;
    const byLabel = (a: string, b: string) => (cand.get(a).label || a).localeCompare(cand.get(b).label || b);

    const autoParent = (id: string) => { const m = /^outlet:(.+):\d+$/.exec(id); return m ? 'pdu:' + m[1] : null; };

    // Edges: explicit directed Links, plus the auto PDU → outlet feed.
    const customTo = new Set(links.map((l: any) => l.To));
    const edges: any[] = [];
    cand.forEach((c: any) => { const ap = autoParent(c.id); if (ap && cand.has(ap) && !customTo.has(c.id)) edges.push({ from: ap, to: c.id, custom: false }); });
    links.forEach((l: any) => { if (cand.has(l.From) && cand.has(l.To)) edges.push({ from: l.From, to: l.To, custom: true, ref: l }); });

    // Adjacency + column = longest path from a root (every edge therefore points strictly rightward).
    const incoming: any = {}, outgoing: any = {};
    cand.forEach((_: any, id: string) => { incoming[id] = []; outgoing[id] = []; });
    edges.forEach(e => { outgoing[e.from].push(e); incoming[e.to].push(e); });
    const colMemo: any = {};
    const col = (id: string, seen?: Set<string>): number => {
      if (colMemo[id] != null) return colMemo[id];
      seen = seen || new Set(); if (seen.has(id)) return 0; seen.add(id);
      const ins = incoming[id] || [];
      const c = ins.length ? Math.max(...ins.map((e: any) => col(e.from, seen) + 1)) : 0;
      seen.delete(id); return colMemo[id] = c;
    };
    [...cand.keys()].forEach(id => col(id));
    // Pull each node as far right as its nearest child allows, so it lands next to what it powers.
    const colX: any = {};
    [...cand.keys()].sort((a, b) => colMemo[b] - colMemo[a]).forEach(id => {
      const outs = outgoing[id] || [];
      colX[id] = outs.length ? Math.max(0, Math.min(...outs.map((e: any) => colX[e.to])) - 1) : colMemo[id];
    });
    // Never leave an empty left margin if every node pulled off column 0.
    const minC = Math.min(...([...cand.keys()].map(id => colX[id]) as number[]));
    if (minC > 0) [...cand.keys()].forEach(id => { colX[id] -= minC; });
    // Would adding from→to create a loop? (can `to` already reach `from`?)
    const reaches = (a: string, b: string) => { const stack = [a], seen = new Set(); while (stack.length) { const x = stack.pop()!; if (x === b) return true; if (seen.has(x)) continue; seen.add(x); (outgoing[x] || []).forEach((e: any) => stack.push(e.to)); } return false; };

    // Layout: stack each column top-to-bottom; order downstream columns by feeder barycenter.
    const padX = 22, padY = 18, rowGap = 16, step = NW + 96;
    const cols: any[] = [];
    [...cand.keys()].forEach(id => { const c = colX[id]; (cols[c] = cols[c] || []).push(id); });
    const pos: any = {};
    const bary = (id: string) => { const ins = incoming[id] || []; if (!ins.length) return 1e9; let s = 0, w = 0; ins.forEach((e: any) => { const p = pos[e.from]; if (p) { s += p.y + NH / 2; w++; } }); return w ? s / w : 1e9; };
    cols.forEach((ids, c) => {
      if (c === 0) ids.sort((a: string, b: string) => (cand.get(a).kind === 'pdu' ? 0 : 1) - (cand.get(b).kind === 'pdu' ? 0 : 1) || byLabel(a, b));
      else ids.sort((a: string, b: string) => (bary(a) - bary(b)) || byLabel(a, b));
      let y = padY;
      ids.forEach((id: string) => { pos[id] = { x: padX + c * step, y }; y += NH + rowGap; });
    });

    const W = Math.max(640, ...[...cand.keys()].map(id => pos[id].x + NW + padX));
    const H = Math.max(260, ...[...cand.keys()].map(id => pos[id].y + NH + padY));
    const scroll = el('div', { style: { overflow: 'auto', border: '1px solid var(--line)', borderRadius: '6px', marginTop: '10px', maxHeight: '72vh' } });
    const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, style: 'background:var(--panel2); display:block' });
    scroll.appendChild(svg); ed.appendChild(scroll);
    ed.appendChild(el('div', { class: 'desc', style: { margin: '4px 2px 0', fontSize: '11px' }, text: 'Drag the canvas to pan · scroll to move · Ctrl/⌘ + scroll to zoom · drag a node’s ● onto another to link.' }));
    const detachZoom = attachZoom(scroll, svg, W, H);
    const defs = svgEl('defs', {}); svg.appendChild(defs);
    [['fh-arrow', 'var(--faint)'], ['fh-arrow-c', '#7cc0ff']].forEach(([id, fill]) => {
      const mk = svgEl('marker', { id, viewBox: '0 0 10 10', refX: '9', refY: '5', markerWidth: '7', markerHeight: '7', orient: 'auto-start-reverse' });
      mk.appendChild(svgEl('path', { d: 'M0,0 L10,5 L0,10 z', fill })); defs.appendChild(mk);
    });
    const edgeLayer = svgEl('g', {}); svg.appendChild(edgeLayer);
    const nodeLayer = svgEl('g', {}); svg.appendChild(nodeLayer);

    const edgeD = (a: any, b: any) => { const x1 = a.x + NW, y1 = a.y + NH / 2, x2 = b.x, y2 = b.y + NH / 2, xc = (x1 + x2) / 2; return `M${x1},${y1} C${xc},${y1} ${xc},${y2} ${x2},${y2}`; };
    edges.forEach(e => {
      const a = pos[e.from], b = pos[e.to];
      edgeLayer.appendChild(svgEl('path', { d: edgeD(a, b), fill: 'none', stroke: e.custom ? '#5ab0ff' : 'var(--faint)', 'stroke-width': e.custom ? 3.5 : 2, 'stroke-opacity': e.custom ? '0.95' : '0.7', 'stroke-dasharray': e.custom ? '' : '5 4', 'marker-end': `url(#${e.custom ? 'fh-arrow-c' : 'fh-arrow'})`, 'pointer-events': 'none' }));
      if (e.custom) {
        // Drifting dashes along the link, hinting at flow direction.
        edgeLayer.appendChild(svgEl('path', { class: 'flow-line', d: edgeD(a, b), fill: 'none', stroke: '#eaf5ff', 'stroke-opacity': '0.95', 'stroke-width': '3.4', 'stroke-linecap': 'round', 'stroke-dasharray': '8 10', 'pointer-events': 'none' }));
        const mx = (a.x + NW + b.x) / 2, my = (a.y + b.y) / 2 + NH / 2;
        const del = svgEl('text', { x: mx, y: my, 'text-anchor': 'middle', 'dominant-baseline': 'middle', fill: 'var(--bad)', 'font-size': '15', style: 'cursor:pointer' });
        del.textContent = '✕'; del.onclick = () => { const i = links.indexOf(e.ref); if (i >= 0) links.splice(i, 1); toast(`${nm(e.from)} → ${nm(e.to)} removed.`, true); renderEditor(); };
        edgeLayer.appendChild(del);
      }
    });

    const nodeG: any = {};
    [...cand.values()].forEach((c: any) => {
      const p = pos[c.id], color = colors[col(c.id) % colors.length];
      const g = svgEl('g', { transform: `translate(${p.x},${p.y})`, style: 'cursor:default' }); g.dataset.id = c.id;
      g.appendChild(svgEl('rect', { width: NW, height: NH, rx: 7, fill: 'var(--panel)', stroke: color, 'stroke-width': 2 }));
      const t1 = svgEl('text', { x: 11, y: 19, fill: 'var(--fg)', 'font-size': '12', 'font-weight': '600' }); t1.textContent = c.label.length > 26 ? c.label.slice(0, 25) + '…' : c.label; g.appendChild(t1);
      const t2 = svgEl('text', { x: 11, y: 35, fill: 'var(--muted)', 'font-size': '10' }); t2.textContent = c.id; g.appendChild(t2);
      g.appendChild(svgEl('circle', { cx: NW, cy: NH / 2, r: 7, fill: color, style: 'cursor:crosshair', 'data-port': c.id }));
      if (c.custom) {
        const rm = svgEl('text', { x: NW - 13, y: 15, fill: 'var(--bad)', 'font-size': '13', style: 'cursor:pointer', 'data-rm': c.id }); rm.textContent = '✕'; g.appendChild(rm);
        // Rename in place: double-click the node to relabel it.
        t1.setAttribute('title', 'Double-click to rename'); g.style.cursor = 'pointer';
        g.addEventListener('dblclick', (e: any) => {
          e.preventDefault();
          const node = customNodes.find((n: any) => n.Id === c.id); if (!node) return;
          const next = window.prompt(`Rename “${node.Label || node.Id}” (id ${node.Id} is unchanged)`, node.Label || node.Id);
          if (next == null) return; // cancelled
          node.Label = next.trim() || node.Id;
          toast(`Renamed to ${node.Label}. Save the hierarchy to keep it.`, true);
          renderEditor();
        });
      }
      nodeLayer.appendChild(g); nodeG[c.id] = g;
    });

    // Interactions: drag a node's output port onto another node to add a directed feed.
    const toUser = (cx: number, cy: number) => new DOMPoint(cx, cy).matrixTransform(svg.getScreenCTM().inverse());
    let linkFrom: any = null, tempLine: any = null, hovered: any = null;
    // Drag the empty canvas to pan, engaging past a small threshold so a click on a node still registers.
    let panStart: any = null, panning = false;
    scroll.style.cursor = 'grab';
    const highlight = (id: any) => {
      if (id === hovered) return;
      if (hovered && nodeG[hovered]) { const rc = nodeG[hovered].querySelector('rect'); rc.setAttribute('stroke', colors[col(hovered) % colors.length]); rc.setAttribute('stroke-width', '2'); }
      hovered = id;
      if (hovered && nodeG[hovered]) { const rc = nodeG[hovered].querySelector('rect'); rc.setAttribute('stroke', '#46c46a'); rc.setAttribute('stroke-width', '3'); }
    };
    const targetUnder = (cx: number, cy: number) => { const hit: any = document.elementFromPoint(cx, cy); const gn = hit && hit.closest && hit.closest('g[data-id]'); return gn && gn.dataset.id !== linkFrom ? gn.dataset.id : null; };
    const onDown = (e: any) => {
      const portId = e.target.getAttribute && e.target.getAttribute('data-port');
      const rmId = e.target.getAttribute && e.target.getAttribute('data-rm');
      if (rmId) { const i = customNodes.findIndex((n: any) => n.Id === rmId); if (i >= 0) customNodes.splice(i, 1); for (let j = links.length - 1; j >= 0; j--) if (links[j].From === rmId || links[j].To === rmId) links.splice(j, 1); renderEditor(); return; }
      if (portId) { linkFrom = portId; tempLine = svgEl('path', { d: '', fill: 'none', stroke: '#5ab0ff', 'stroke-width': 2, 'stroke-dasharray': '4 3', 'pointer-events': 'none' }); edgeLayer.appendChild(tempLine); e.preventDefault(); return; }
      // Anything else (background, a node body, a label): a potential pan.
      panStart = { x: e.clientX, y: e.clientY, sl: scroll.scrollLeft, st: scroll.scrollTop };
      e.preventDefault();   // don't rubber-band-select node labels while dragging
    };
    const onMove = (e: any) => {
      if (panStart && !linkFrom) {
        const dx = e.clientX - panStart.x, dy = e.clientY - panStart.y;
        if (panning || Math.hypot(dx, dy) > 4) {
          panning = true; scroll.style.cursor = 'grabbing';
          scroll.scrollLeft = panStart.sl - dx; scroll.scrollTop = panStart.st - dy;
        }
        return;
      }
      if (!linkFrom) return;
      const u = toUser(e.clientX, e.clientY), a = pos[linkFrom];
      tempLine.setAttribute('d', `M${a.x + NW},${a.y + NH / 2} L${u.x},${u.y}`);
      highlight(targetUnder(e.clientX, e.clientY));
    };
    const onUp = (e: any) => {
      if (panStart) { const wasPanning = panning; panStart = null; panning = false; scroll.style.cursor = 'grab'; if (wasPanning) return; }
      if (!linkFrom) return;
      const src = linkFrom, tgt = targetUnder(e.clientX, e.clientY);
      if (tempLine) tempLine.remove(); linkFrom = null; highlight(null);
      if (!tgt || src === tgt) return;
      if (reaches(tgt, src)) { toast('That would create a feeder loop.', false); return; }
      if (links.some((l: any) => l.From === src && l.To === tgt)) { toast('That feed already exists.', false); return; }
      links.push({ From: src, To: tgt });
      toast(`${nm(src)} → ${nm(tgt)} added.`, true);
      renderEditor();
    };
    svg.addEventListener('mousedown', onDown);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    ed._cleanup = () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); detachZoom(); };
  };

  const load = async () => {
    let path = withInstance('/api/flow', instSel);
    if (metricSel.value && metricSel.value !== 'realpower') path += (path.includes('?') ? '&' : '?') + 'metric=' + metricSel.value;
    const past = historyQuery(hist);
    if (past) path += (path.includes('?') ? '&' : '?') + past.slice(1);
    const [r, w] = await Promise.all([api(path), api('/api/flow/withheld')]);
    withheldSources = (w.body && w.body.ok && w.body.sources) || [];
    if (!r.body.ok) { wrap.innerHTML = '<div class="desc" style="color:var(--bad)">' + (r.body.message || 'Could not load flow data.') + '</div>'; count.textContent = ''; lastGraph = null; redrawSubPages(); return; }
    // Say plainly that this is not now. A past diagram that looks like the live one is the worst outcome.
    hist.setNote(historyNote(r.body));
    lastGraph = r.body;
    draw(r.body);
    redrawSubPages();
  };
  refresh.onclick = load;

  // A sub-page repaints with the data only while it is the page you are on.
  const redrawSubPages = () => {
    if (edPage.sec.classList.contains('active')) renderEditor();
    if (treePage.sec.classList.contains('active')) renderTree();
  };

  // The editor draws every node the diagram knows about, not just the configured ones.
  const openSubPage = async (page: any, render: () => void) => {
    activate(page.link, page.sec);
    if (!lastGraph) await load();
    render();
  };
  treePage.link.onclick = () => openSubPage(treePage, renderTree);
  edPage.link.onclick = () => openSubPage(edPage, renderEditor);
  settingsPage.link.onclick = () => { activate(settingsPage.link, settingsPage.sec); renderSettings(); };

  // The Sankey follows the readings while the tab is open (#281).
  const syncLive = liveWhileActive(sec,
    () => 'flow:' + (metricSel.value || 'realpower') + (instSel.get() ? '|' + instSel.get() : ''),
    (body: any) => { if (hist.day() || !body || !body.ok) return; lastGraph = body; draw(body); });
  metricSel.addEventListener('change', () => syncLive());

  link.onclick = () => { activate(link, sec); syncLive(); load(); showDayNote(); };
}
