// Energy Flow: a read-only Sankey + the layered arrow-graph hierarchy editor.
import { api, btn, el, ensure, formatNum, svgEl, attachZoom, activate, toast, instanceSelector, withInstance } from '../helpers.js';
import { state } from '../state.js';
import { exportData } from '../overrides.js';

export function addFlowSection(nav: any, sections: any) {
  const link = document.createElement('a'); link.textContent = 'Flow'; nav.appendChild(link);
  const sec = document.createElement('div'); sec.className = 'section'; sections.appendChild(sec);
  const h = document.createElement('h2'); h.textContent = 'Energy Flow'; sec.appendChild(h);
  const d = document.createElement('div'); d.className = 'desc';
  d.textContent = 'Live power flow (from the latest poll). Outlet→PDU is auto-derived; add upstream nodes (panels, breakers, a “Total”) and drag to set each node’s feeder to model the full hierarchy. Link width is proportional to the measurement.';
  sec.appendChild(d);

  const bar = document.createElement('div'); bar.className = 'ld-toolbar';
  const refresh = btn('Refresh');
  const instSel = instanceSelector(() => load());
  const count = document.createElement('span'); count.className = 'ld-count';
  bar.appendChild(refresh); bar.appendChild(instSel.wrap); bar.appendChild(count); sec.appendChild(bar);
  const wrap = document.createElement('div'); sec.appendChild(wrap);
  const ed: any = document.createElement('div'); ed.style.marginTop = '18px'; sec.appendChild(ed);
  let lastGraph: any = null;

  // Layered Sankey: columns = longest path from a root (energy flows left->right, parent->child).
  const draw = (graph: any) => {
    wrap.innerHTML = '';
    const links = (graph.links || []).slice();
    const nodes = graph.nodes || [];
    if (!links.length) { wrap.innerHTML = '<div class="desc" style="color:var(--muted)">No measured power flow to display. Define an EnergyFlow hierarchy, or check that outlets report power.</div>'; count.textContent = ''; return; }

    const units = graph.units || '';
    const incoming: any = {}, outgoing: any = {};
    nodes.forEach((n: any) => { incoming[n.id] = []; outgoing[n.id] = []; });
    links.forEach((l: any) => { (outgoing[l.source] = outgoing[l.source] || []).push(l); (incoming[l.target] = incoming[l.target] || []).push(l); });
    const sumv = (arr: any[]) => (arr || []).reduce((s, l) => s + l.value, 0);
    const nodeValue = (id: string) => Math.max(sumv(incoming[id]), sumv(outgoing[id]));

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
    const maxCol = Math.max(0, ...nodes.map((n: any) => colMemo[n.id]));

    const cols: any[] = [];
    nodes.forEach((n: any) => { const c = colMemo[n.id]; (cols[c] = cols[c] || []).push(n); });

    const W = 960, padTop = 22, gap = 8, nodeW = 12, usableH = 520;
    // Labels sit to the right of each node, so reserve a right gutter for them and only a small left pad.
    const leftPad = 16, rightGutter = 232;
    const maxTotal = Math.max(1, ...cols.map(cn => cn.reduce((s: number, n: any) => s + nodeValue(n.id), 0)));
    const pxPerUnit = usableH / maxTotal;
    const colX = (c: number) => leftPad + (maxCol > 0 ? c * ((W - leftPad - rightGutter - nodeW) / maxCol) : 0);

    const pos: any = {};
    // Barycenter: a node's preferred y is the value-weighted mean of its (already positioned) feeders.
    const bary = (id: string) => { let w = 0, s = 0; (incoming[id] || []).forEach((l: any) => { const sp = pos[l.source]; if (sp) { s += (sp.y + sp.h / 2) * l.value; w += l.value; } }); return w ? s / w : Infinity; };
    cols.forEach((cn, c) => {
      // Roots stack by size; downstream columns follow their feeder's order (groups children, avoids crossings).
      if (c === 0) cn.sort((a: any, b: any) => nodeValue(b.id) - nodeValue(a.id));
      else cn.sort((a: any, b: any) => (bary(a.id) - bary(b.id)) || (nodeValue(b.id) - nodeValue(a.id)));
      let y = padTop;
      cn.forEach((n: any) => { const h = Math.max(2, nodeValue(n.id) * pxPerUnit); pos[n.id] = { x: colX(c), y, h, outOff: 0, inOff: 0 }; y += h + gap; });
    });

    // Fit the viewBox to the tallest column (stacking gaps push it past usableH), so nothing clips.
    const totalH = Math.ceil(Math.max(padTop + usableH, ...nodes.map((n: any) => pos[n.id] ? pos[n.id].y + pos[n.id].h : 0))) + padTop;
    const svg = svgEl('svg', { viewBox: `0 0 ${W} ${totalH}`, width: W, height: totalH, style: 'display:block' });
    const colors = ['#49f', '#4f9', '#fa4', '#f49', '#9f4', '#4ff', '#f94', '#a9f'];

    // Ribbons (filled bezier bands), stacked on each node edge by target order.
    links.sort((a: any, b: any) => pos[a.target].y - pos[b.target].y).forEach((l: any) => {
      const s = pos[l.source], t = pos[l.target];
      if (!s || !t) return;
      const h = Math.max(1, l.value * pxPerUnit);
      const x1 = s.x + nodeW, x2 = t.x, xc = (x1 + x2) / 2;
      const sTop = s.y + s.outOff, tTop = t.y + t.inOff;
      const color = colors[colMemo[l.source] % colors.length];
      svg.appendChild(svgEl('path', { d: `M${x1},${sTop} C${xc},${sTop} ${xc},${tTop} ${x2},${tTop} L${x2},${tTop + h} C${xc},${tTop + h} ${xc},${sTop + h} ${x1},${sTop + h} Z`, fill: color, 'fill-opacity': '0.3' }));
      s.outOff += h; t.inOff += h;
    });

    // Nodes + labels (to the right of each node, vertically centered; a bg halo keeps them legible
    // where they cross a ribbon).
    nodes.forEach((n: any) => {
      const p = pos[n.id]; if (!p) return;
      svg.appendChild(svgEl('rect', { x: p.x, y: p.y, width: nodeW, height: p.h, rx: 2, fill: colors[colMemo[n.id] % colors.length] }));
      const lab = svgEl('text', {
        x: p.x + nodeW + 6, y: p.y + p.h / 2, fill: 'var(--fg)', 'font-size': '11', 'font-weight': n.kind === 'outlet' ? '400' : '600',
        'dominant-baseline': 'middle', 'paint-order': 'stroke', stroke: 'var(--panel2)', 'stroke-width': '3', 'stroke-linejoin': 'round',
      });
      lab.textContent = `${n.label} · ${formatNum(nodeValue(n.id))} ${units}`;
      svg.appendChild(lab);
    });

    count.textContent = `${nodes.length} node(s) · ${links.length} link(s)`;
    const scroll = el('div', { style: { overflow: 'auto', maxHeight: '74vh', border: '1px solid var(--line)', borderRadius: '6px' } });
    scroll.appendChild(svg); wrap.appendChild(scroll);
    attachZoom(scroll, svg, W, totalH);  // scroll-into-view container is replaced on each draw(), so no leak.
  };

  // --- Hierarchy editor: a layered, left→right arrow graph (energy flows source → target). Drag from a
  //     node's right ● output port onto another node to add a directed feed. A node can have many feeders
  //     (a transfer switch fed by grid + generator + inverter) and producers are just feeds pointing into
  //     what they power (solar → inverter). Columns are auto-laid-out by depth to minimise crossings. ---
  const colors = ['#4f8cff', '#46c46a', '#fa4', '#f49', '#9f4', '#4ff'];
  const NW = 190, NH = 46;

  const renderEditor = () => {
    if (ed._cleanup) ed._cleanup();
    const flow = ensure(state.data, 'EnergyFlow', {});
    const customNodes = ensure(flow, 'Nodes', []);
    const links = ensure(flow, 'Links', []);
    const legacy = ensure(flow, 'Parents', {});
    // One-time migration: fold any legacy single-feeder Parents (child→parent) into directed Links.
    if (Object.keys(legacy).length) {
      Object.entries(legacy).forEach(([child, parent]) => { if (parent && child && !links.some((l: any) => l.From === parent && l.To === child)) links.push({ From: parent, To: child }); });
      Object.keys(legacy).forEach(k => delete legacy[k]);
    }
    ed.innerHTML = '';

    ed.appendChild(el('h3', { text: 'Hierarchy', style: { margin: '4px 0' } }));
    ed.appendChild(el('div', { class: 'desc', text: 'Energy flows left → right. Drag from a node’s right ● onto another node to add a feed (source powers target). A node can have several feeders, and a producer is just a feed into what it powers — e.g. drag from Solar onto your inverter. The target highlights green when in range; click ✕ on a link to remove it. PDU → outlet links are auto-derived (dashed) until you wire an explicit feeder.' }));

    const addBar = el('div', { class: 'ld-toolbar' });
    const idIn = el('input', { type: 'text', placeholder: 'id (e.g. gridboss)' });
    const labIn = el('input', { type: 'text', placeholder: 'label (e.g. Grid Boss)' });
    const valIn = el('input', { type: 'number', placeholder: 'known value (optional)', style: { width: '150px' } });
    const addBtn = btn('Add node', 'primary');
    const save = btn('Save hierarchy', 'primary');
    addBar.append(idIn, labIn, valIn, addBtn, save); ed.appendChild(addBar);

    // MQTT export of the hierarchy (#164): each tier's rolled-up value is published per poll. Saved with
    // the hierarchy (the Save button posts the whole config).
    const exportRow = el('div', { class: 'ld-toolbar' });
    const topicIn = el('input', { type: 'text', placeholder: '{parent}/energyflow/{id}', style: { width: '280px' } });
    topicIn.value = flow.MqttTopicTemplate || '';
    topicIn.disabled = !flow.MqttExport;
    topicIn.onchange = () => { flow.MqttTopicTemplate = topicIn.value.trim() || undefined; };
    const expChk = el('input', { type: 'checkbox' }); expChk.checked = !!flow.MqttExport;
    expChk.onchange = () => { flow.MqttExport = expChk.checked; topicIn.disabled = !expChk.checked; };
    exportRow.append(el('label', {}, expChk, ' Export tiers to MQTT'), el('span', { class: 'desc', style: { margin: '0' }, text: 'Topic:' }), topicIn);
    ed.appendChild(exportRow);

    // Candidate nodes (from the built graph + custom defs).
    const cand = new Map();
    (lastGraph?.nodes || []).forEach((n: any) => cand.set(n.id, { id: n.id, label: n.label, kind: n.kind }));
    customNodes.forEach((n: any) => cand.set(n.Id, { id: n.Id, label: n.Label || n.Id, kind: 'node', custom: true }));
    const nm = (id: string): string => (cand.get(id) || {}).label || id;
    const byLabel = (a: string, b: string) => (cand.get(a).label || a).localeCompare(cand.get(b).label || b);

    const autoParent = (id: string) => { const m = /^outlet:(.+):\d+$/.exec(id); return m ? 'pdu:' + m[1] : null; };

    // Edges: explicit directed Links, plus the auto PDU → outlet feed (suppressed once an outlet is
    // explicitly fed). `custom` edges are user links (deletable); auto edges are dashed and fixed.
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
    // Would adding from→to create a loop? (can `to` already reach `from`?)
    const reaches = (a: string, b: string) => { const stack = [a], seen = new Set(); while (stack.length) { const x = stack.pop()!; if (x === b) return true; if (seen.has(x)) continue; seen.add(x); (outgoing[x] || []).forEach((e: any) => stack.push(e.to)); } return false; };

    // Layout: stack each column top-to-bottom; order downstream columns by feeder barycenter.
    const padX = 22, padY = 18, rowGap = 16, step = NW + 96;
    const cols: any[] = [];
    [...cand.keys()].forEach(id => { const c = col(id); (cols[c] = cols[c] || []).push(id); });
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
    const detachZoom = attachZoom(scroll, svg, W, H);
    const defs = svgEl('defs', {}); svg.appendChild(defs);
    [['fh-arrow', 'var(--line)'], ['fh-arrow-c', '#5ab0ff']].forEach(([id, fill]) => {
      const mk = svgEl('marker', { id, viewBox: '0 0 10 10', refX: '9', refY: '5', markerWidth: '7', markerHeight: '7', orient: 'auto-start-reverse' });
      mk.appendChild(svgEl('path', { d: 'M0,0 L10,5 L0,10 z', fill })); defs.appendChild(mk);
    });
    const edgeLayer = svgEl('g', {}); svg.appendChild(edgeLayer);
    const nodeLayer = svgEl('g', {}); svg.appendChild(nodeLayer);

    const edgeD = (a: any, b: any) => { const x1 = a.x + NW, y1 = a.y + NH / 2, x2 = b.x, y2 = b.y + NH / 2, xc = (x1 + x2) / 2; return `M${x1},${y1} C${xc},${y1} ${xc},${y2} ${x2},${y2}`; };
    edges.forEach(e => {
      const a = pos[e.from], b = pos[e.to];
      edgeLayer.appendChild(svgEl('path', { d: edgeD(a, b), fill: 'none', stroke: e.custom ? '#5ab0ff' : 'var(--line)', 'stroke-width': e.custom ? 2 : 1.5, 'stroke-dasharray': e.custom ? '' : '4 3', 'marker-end': `url(#${e.custom ? 'fh-arrow-c' : 'fh-arrow'})`, 'pointer-events': 'none' }));
      if (e.custom) {
        // Drifting dashes along the link, hinting at flow direction.
        edgeLayer.appendChild(svgEl('path', { class: 'flow-line', d: edgeD(a, b), fill: 'none', stroke: '#cfe8ff', 'stroke-opacity': '0.85', 'stroke-width': '2.6', 'stroke-linecap': 'round', 'stroke-dasharray': '7 11', 'pointer-events': 'none' }));
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
      if (c.custom) { const rm = svgEl('text', { x: NW - 13, y: 15, fill: 'var(--bad)', 'font-size': '13', style: 'cursor:pointer', 'data-rm': c.id }); rm.textContent = '✕'; g.appendChild(rm); }
      nodeLayer.appendChild(g); nodeG[c.id] = g;
    });

    // Interactions: drag a node's output port onto another node to add a directed feed. Map screen
    // coords through the SVG CTM so the drag line stays correct under zoom/scroll.
    const toUser = (cx: number, cy: number) => new DOMPoint(cx, cy).matrixTransform(svg.getScreenCTM().inverse());
    let linkFrom: any = null, tempLine: any = null, hovered: any = null;
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
      if (portId) { linkFrom = portId; tempLine = svgEl('path', { d: '', fill: 'none', stroke: '#5ab0ff', 'stroke-width': 2, 'stroke-dasharray': '4 3', 'pointer-events': 'none' }); edgeLayer.appendChild(tempLine); e.preventDefault(); }
    };
    const onMove = (e: any) => {
      if (!linkFrom) return;
      const u = toUser(e.clientX, e.clientY), a = pos[linkFrom];
      tempLine.setAttribute('d', `M${a.x + NW},${a.y + NH / 2} L${u.x},${u.y}`);
      highlight(targetUnder(e.clientX, e.clientY));
    };
    const onUp = (e: any) => {
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

    addBtn.onclick = () => {
      const id = (idIn.value || '').trim(); if (!id) { toast('Node id is required.', false); return; }
      if (cand.has(id)) { toast('That id already exists.', false); return; }
      const node: any = { Id: id, Label: (labIn.value || '').trim() || id };
      if (valIn.value !== '' && !isNaN(+valIn.value)) node.Value = +valIn.value;
      customNodes.push(node); renderEditor();
    };
    save.onclick = async () => {
      const r = await api('/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(exportData()) });
      toast(r.body.message || (r.ok ? 'Saved.' : 'Save failed.'), r.ok && r.body.ok);
      if (r.ok && r.body.ok) load();
    };
  };

  const load = async () => {
    const r = await api(withInstance('/api/flow', instSel));
    if (!r.body.ok) { wrap.innerHTML = '<div class="desc" style="color:var(--bad)">' + (r.body.message || 'Could not load flow data.') + '</div>'; count.textContent = ''; lastGraph = null; renderEditor(); return; }
    lastGraph = r.body;
    draw(r.body);
    renderEditor();
  };
  refresh.onclick = load;
  link.onclick = () => { activate(link, sec); load(); };
}
