import { activate, api, btn, closeSheet, el, ensure, navLink, openSheet, saveFile, slug, toast } from '../helpers.js';
import { pdfDocument, pdfPage, pdfTextWidth, pdfWrap, type PdfPage } from '../pdf.js';
import { openHistorySheet } from '../history-sheet.js';
import { state } from '../state.js';
import { refreshDirty } from '../dirty.js';
import { collides, column, rowOf } from '../panel-layout.js';
import { extensionsFor, renderExtensions } from '../entity-extensions.js';
import { integrationIds } from '../plugin-pages.js';
import { openNodeSheet } from './nodes.js';

/// A breaker as the API reports it, with its chain and power resolved.
type Leg = { leg: number; wire: string; clamp: string | null; channel: string | null; reversed: boolean };
type Breaker = {
  slot: number; number: string; poles: number; half: number | null; amps: number | null;
  wire: string; gauge: string; conductor: string; description: string; state: string;
  power: number | null; current: number | null; gap: string; legs: Leg[]; node?: string | null; derived?: boolean;
};
type Finding = { kind: string; severity: string; message: string; breakers: string[]; channels: string[] };
type Panel = { id: string; name: string; slots: number; rows: number; node: string; incoming: number | null; volts: number | null; breakers: Breaker[] };

/// What a finding is about, in the words the page uses.
const CHECK_TITLES: Record<string, string> = {
  'channel-shared': 'One channel, two breakers',
  'channel-unmapped': 'A channel nobody mapped',
  'unused-live': 'An unused breaker drawing power',
  'half-clamped': 'Half a double-pole breaker',
  'over-rating': 'Over the breaker\u2019s rating',
  'channel-is-a-tier': 'Measured by a breaker, not a channel',
  'panel-multi-fed': 'A panel fed from two places',
  'circuit-multi-fed': 'A circuit fed from two places',
};

/// Why a breaker's power is not shown. Never a zero: a gap in the chain is a gap.
const GAPS: Record<string, string> = {
  noclamp: 'Nothing is measuring this breaker yet — pick the node its circuit is on. A double-pole needs both legs, unless one CT measures the whole circuit.',
  nochannel: 'Its clamp is not plugged into a monitor channel yet.',
  noreading: 'Its channel has no current reading.',
};

const PANEL_CIRCUIT_KINDS = ['breaker', 'outlet', 'load', 'node', 'panel'];

export function addPanelScheduleSection(nav: any, sections: any) {
  const link = navLink(nav, 'Breaker Panels', '🗂');
  link.dataset.was = 'panel-schedule';
  link.dataset.section = 'EnergyFlow.Panels,EnergyFlow.Clamps,EnergyFlow.Links';
  const sec = el('div', { class: 'section ps' });
  sections.appendChild(sec);
  sec.appendChild(el('h2', { text: 'Breaker Panels' }));
  sec.appendChild(el('div', { class: 'desc ps-intro' },
    'Each panel as its own directory: the slots laid out as they are in the panel, odd down the left and even '
    + 'down the right, with what each breaker feeds and the power of the node measuring it. A breaker with '
    + 'nothing mapped to it reads no data rather than zero. Tap a breaker to edit it, or an empty slot to fill it in.'));

  const panelSel = el('select', { title: 'Which panel to show.' }) as HTMLSelectElement;
  const refresh = btn('Refresh');
  const addPanel = btn('Add panel');
  const importBtn = btn('Import…');
  const traceStart = btn('Trace…');
  traceStart.title = 'Identify an unknown breaker: take a baseline, switch it off, and see which channel went dark.';
  const printBtn = btn('Print…');
  printBtn.title = 'Print this directory for the inside of the panel door.';
  const exportBtn = btn('Export…');
  exportBtn.title = 'Save this directory as a PDF for the panel door, or as text the Import reads back.';
  importBtn.title = 'Paste a directory you already keep — breaker numbers, wires, channels and what each feeds — and see what it reads as before anything is written.';
  const unitSel = el('select', { class: 'ps-unit' }) as HTMLSelectElement;
  [['W', 'watts'], ['A', 'amps']].forEach(([v, t]) => unitSel.appendChild(el('option', { value: v, text: t })));
  unitSel.title = 'Show what each breaker is drawing in watts, or in amps against its rating.';
  unitSel.onchange = () => render();
  const status = el('span', { class: 'ld-count' });
  sec.appendChild(el('div', { class: 'ld-toolbar ps-toolbar', style: { flexWrap: 'wrap', gap: '8px' } },
    el('div', { class: 'ps-pick' }, el('label', { class: 'ld-inst' }, 'Panel ', panelSel), el('label', { class: 'ld-inst' }, 'Show ', unitSel)),
    el('div', { class: 'ps-actions' }, refresh, addPanel, importBtn, traceStart, printBtn, exportBtn), status));
  [addPanel, importBtn, traceStart].forEach(b => b.classList.add('edit-only'));

  const nameIn = el('input', { type: 'text', placeholder: 'Main Panel' }) as HTMLInputElement;
  const slotsIn = el('input', { type: 'number', min: '2', max: '200', step: '2', class: 'ps-slots' }) as HTMLInputElement;
  slotsIn.title = 'How many breaker positions the panel has, counting both columns. A 42-space panel has 42.';
  const nodeSel = el('select', { class: 'ps-panel-node' }) as HTMLSelectElement;
  nodeSel.title = 'The energy-flow node that is this panel. Its reading is the power coming in, and a circuit mapped to one of its breakers is placed beneath it.';
  const feeders = el('span', { class: 'ps-feeders' });
  const feedAdd = el('select', { class: 'ps-feed-add' }) as HTMLSelectElement;
  feedAdd.title = 'Add a node that feeds this panel.';
  const settings = el('div', { class: 'ld-toolbar', style: { flexWrap: 'wrap', gap: '8px' } },
    el('label', { class: 'ld-inst' }, 'Name ', nameIn),
    el('label', { class: 'ld-inst' }, 'Slots ', slotsIn),
    el('label', { class: 'ld-inst' }, 'This panel is ', nodeSel),
    el('label', { class: 'ld-inst' }, 'Fed by ', feeders, feedAdd));
  const panelExt = el('div', { class: 'ps-ext' });
  const settingsBox = el('details', { class: 'ps-settings' }, el('summary', { text: 'Panel settings' }), settings, panelExt);
  settingsBox.open = !(window.matchMedia?.('(max-width: 560px)').matches);
  const incoming = el('div', { class: 'desc ps-incoming' });
  sec.appendChild(incoming);

  const checks = el('div', { class: 'ps-checks' });
  sec.appendChild(checks);

  const grid = el('div', { class: 'ps-grid' });
  sec.appendChild(el('div', { class: 'ps-panel' }, el('div', { class: 'ps-bus' }), grid));
  sec.appendChild(settingsBox);

  traceStart.onclick = () => {
    const p = shown();
    if (!p) { toast('Add a panel first.', false); return; }
    trace(p, null);
  };
  printBtn.onclick = () => {
    const p = shown();
    if (!p) { toast('Add a panel first.', false); return; }
    const url = URL.createObjectURL(new Blob([directoryPdf(p, slotsOf(p))], { type: 'application/pdf' }));
    const frame: any = el('iframe', { class: 'ps-print-frame', title: 'Panel directory' });
    frame.onload = () => {
      try { frame.contentWindow.focus(); frame.contentWindow.print(); }
      catch { window.open(url, '_blank'); }
      setTimeout(() => { frame.remove(); URL.revokeObjectURL(url); }, 60000);
    };
    frame.src = url;
    document.body.appendChild(frame);
  };

  let panels: Panel[] = [];
  let findings: Finding[] = [];
  let nodes: { id: string; label: string; kind: string }[] = [];

  const flowIn = () => ensure(state.data, 'EnergyFlow', {});
  const placementsIn = (): any[] => state.data?.Plugins?.locations?.Placements || [];
  const panelsIn = (): any[] => ensure(flowIn(), 'Panels', []);
  const clampsIn = (): any[] => ensure(flowIn(), 'Clamps', []);
  const linksIn = (): any[] => ensure(flowIn(), 'Links', []);
  const shown = () => panels.find(p => p.id === panelSel.value) || panels[0];
  const labelOf = (id: string) => nodes.find(n => n.id === id)?.label || id;
  /// What feeds a node today, according to the flow links.
  const parentsOf = (node: string) => linksIn().filter((l: any) => l.To === node).map((l: any) => String(l.From));
  /// The config entry behind the drawn panel: edits land there, and it is what the drawing follows.
  const configPanel = (id: string) => panelsIn().find((p: any) => p.Id === id);

  const load = async () => {
    status.textContent = 'loading…';
    let r: any;
    const holding = { EnergyFlow: { Panels: panelsIn(), Clamps: clampsIn() } };
    try {
      r = panelsIn().length
        ? await api('/api/panels/resolve', { method: 'POST', body: JSON.stringify(holding) })
        : await api('/api/panels');
    }
    catch (e: any) { r = { body: { ok: false, message: e?.message || 'the request failed' } }; }
    if (!r.body?.ok) { status.textContent = r.body?.message || 'Could not read the panels.'; panels = []; render(); return; }
    panels = r.body.panels || [];
    findings = r.body.findings || [];
    const keep = panelSel.value;
    panelSel.innerHTML = '';
    panels.forEach(p => panelSel.appendChild(el('option', { value: p.id, text: p.name || p.id })));
    if (panels.some(p => p.id === keep)) panelSel.value = keep;
    status.textContent = '';
    try {
      const f: any = await api('/api/flow');
      if (f?.body?.ok) nodes = (f.body.nodes || [])
        .filter((n: any) => n.id && !String(n.id).includes('#'))
        .map((n: any) => ({ id: n.id, label: n.label || n.id, kind: n.kind || 'node' }));
    } catch { /* the page still draws without the picker's choices */ }
    render();
  };
  refresh.onclick = () => load();
  panelSel.onchange = () => render();

  addPanel.onclick = () => {
    const id = (prompt('An id for the panel, e.g. main_panel') || '').trim();
    if (!id) return;
    panelsIn().push({ Id: id, Name: id, Slots: 42, Breakers: [] });
    refreshDirty();
    toast(`Added panel ${id}. Press Save to keep it.`, true);
    load();
  };

  nameIn.onchange = () => {
    const p = configPanel(panelSel.value);
    if (!p) return;
    p.Name = nameIn.value.trim() || p.Id;
    refreshDirty();
    render();
  };
  nodeSel.onchange = () => {
    const p = configPanel(panelSel.value);
    if (!p) return;
    p.Node = nodeSel.value;
    refreshDirty();
    load();
  };
  feedAdd.onchange = () => {
    const p = configPanel(panelSel.value);
    if (!p?.Node || !feedAdd.value) return;
    if (!parentsOf(p.Node).includes(feedAdd.value)) linksIn().push({ From: feedAdd.value, To: p.Node });
    feedAdd.value = '';
    refreshDirty();
    render();
  };
  slotsIn.onchange = () => {
    const p = configPanel(panelSel.value);
    if (!p) return;
    const want = Math.max(2, Math.min(200, Number(slotsIn.value) || 42));
    p.Slots = want % 2 ? want + 1 : want;
    slotsIn.value = String(p.Slots);
    refreshDirty();
    render();
  };

  /// The breaker in the config this drawn one came from, so an edit lands on the real entry.
  const configBreaker = (panelId: string, b: Breaker) => {
    const p = configPanel(panelId);
    if (!p) return null;
    return ensure(p, 'Breakers', []).find((x: any) => x.Slot === b.slot && (x.Number || '') === b.number) || null;
  };

  /// The clamp recording which node measures one leg of a breaker, if anything does.
  const clampFor = (panelId: string, number: string, leg: number) =>
    clampsIn().find((c: any) => c.Panel === panelId && c.Breaker === number && (c.Leg || 1) === leg) || null;

  /// Point a leg at a node, or at nothing. The chain is kept — the pick writes the clamp behind it.
  const mapLeg = (panelId: string, number: string, leg: number, channel: string, wire: string, whole = false) => {
    const existing = clampFor(panelId, number, leg);
    if (!channel) {
      const at = clampsIn().indexOf(existing);
      if (at >= 0) clampsIn().splice(at, 1);
      return;
    }
    if (existing) { existing.Channel = channel; existing.Whole = whole; if (wire) existing.Wire = wire; return; }
    clampsIn().push({ Label: `${number} L${leg}`, Panel: panelId, Breaker: number, Leg: leg, Wire: wire, Channel: channel, Whole: whole });
  };

  /// Which breaker a node is already measuring, so the picker can say so rather than let it be claimed twice.
  const takenBy = (channel: string, panelId: string, number: string, leg: number) => {
    const other = clampsIn().find((c: any) => c.Channel === channel
      && !(c.Panel === panelId && c.Breaker === number && (c.Leg || 1) === leg));
    return other ? `${other.Panel}/${other.Breaker}` : '';
  };

  /// Power below this, in watts, is noise rather than a circuit drawing something — the same floor the bridge's own check uses.
  const TRACE_FLOOR = 5;

  /// Every node that could be the channel measuring a circuit: not a panel, and not a synthetic tier.
  const traceCandidates = () => nodes.filter(n => PANEL_CIRCUIT_KINDS.includes(n.kind)
    && !panelsIn().some((p: any) => p.Node === n.id || p.Id === n.id)
    && !n.id.startsWith('breaker:'));

  /// What every node is reading right now, for the before and after of a trace.
  const readAll = async (): Promise<Record<string, number | null>> => {
    const out: Record<string, number | null> = {};
    try {
      const f: any = await api('/api/flow');
      if (f?.body?.ok) (f.body.nodes || []).forEach((n: any) => { out[n.id] = typeof n.value === 'number' ? n.value : null; });
    } catch { /* nothing read is nothing to compare */ }
    return out;
  };

  /// Identify a breaker by switching it off and reading which channel went dark (#456).
  const trace = (panel: Panel, start: Breaker | null) => {
    const live = panel.breakers.filter(b => b.state !== 'unused');
    const pick = el('select', { class: 'ps-trace-pick' }) as HTMLSelectElement;
    live.forEach(b => pick.appendChild(el('option', {
      value: `${b.slot}|${b.number}`,
      text: `${b.number} — ${b.description || 'not identified'}${b.legs.some(l => l.channel) ? ' (already mapped)' : ''}`,
    })));
    const chosen = start || live.find(b => !b.legs.some(l => l.channel)) || live[0];
    if (chosen) pick.value = `${chosen.slot}|${chosen.number}`;
    const breakerNow = () => live.find(b => `${b.slot}|${b.number}` === pick.value) || chosen;

    const step = el('div', { class: 'desc ps-trace-step' });
    const result = el('div', { class: 'ps-trace-out' });
    const take = btn('Take the baseline', 'primary');
    const again = btn('Read again');
    again.hidden = true;
    let before: Record<string, number | null> | null = null;
    let watching: any = null;

    const stop = () => { if (watching) { clearInterval(watching); watching = null; } };

    const compare = async () => {
      if (!before) return;
      const b = breakerNow();
      const after = await readAll();
      const cand = traceCandidates();
      const was = (id: string) => before![id];
      const drawing = cand.filter(n => typeof was(n.id) === 'number' && (was(n.id) as number) > TRACE_FLOOR);
      const dropped = drawing.filter(n => typeof after[n.id] === 'number'
        && (after[n.id] as number) <= Math.max(TRACE_FLOOR, (was(n.id) as number) * 0.15));
      result.innerHTML = '';
      if (!drawing.length) {
        result.appendChild(el('div', { class: 'ps-trace-note is-warn' },
          'Nothing was drawing when the baseline was taken, so a breaker going off changes nothing that can be read. '
          + 'Switch something on the circuit on — a lamp, a heater, the appliance itself — then take the baseline again.'));
        return;
      }
      if (!dropped.length) {
        result.appendChild(el('div', { class: 'ps-trace-note is-warn' },
          `${drawing.length} channel(s) are drawing power and none of them went dark. Either the breaker is still on, or `
          + 'nothing measures what it feeds — a circuit with no CT on it cannot be traced this way.'));
        return;
      }
      result.appendChild(el('div', { class: 'desc', text: dropped.length === 1
        ? 'One channel went dark while the breaker was off:'
        : `${dropped.length} channels went dark while the breaker was off — a 240 V circuit drops both its legs at once:` }));
      dropped.forEach((n, i) => {
        const row = el('div', { class: 'ps-trace-hit' });
        row.dataset.node = n.id;
        row.appendChild(el('span', { class: 'ps-trace-name', text: `${n.label} (${n.id})` }));
        row.appendChild(el('span', { class: 'ps-trace-fall',
          text: `${Math.round(was(n.id) as number).toLocaleString('en-US')} W → ${Math.round(after[n.id] as number).toLocaleString('en-US')} W` }));
        const held = takenBy(n.id, panel.id, b.number, 1);
        if (held) row.appendChild(el('span', { class: 'ps-trace-held', text: `already measuring ${held}` }));
        const map = (leg: number) => {
          const cfg = configBreaker(panel.id, b);
          mapLeg(panel.id, b.number, leg, n.id, cfg?.Wire || '');
          if (cfg) cfg.State = 'identified';
          refreshDirty();
          stop();
          closeSheet();
          toast(`${b.number} is measured by ${n.label}. Press Save to keep it.`, true);
          load();
        };
        if (b.poles === 2) {
          const one = btn('It is leg 1'), two = btn('It is leg 2');
          one.onclick = () => map(1);
          two.onclick = () => map(2);
          row.append(one, two);
        } else {
          const it = btn('This is it', 'primary');
          it.onclick = () => map(1);
          row.appendChild(it);
        }
        if (i === 0 && b.poles === 2 && dropped.length === 2) {
          const both = btn('Both legs are this breaker', 'primary');
          both.onclick = () => {
            const cfg = configBreaker(panel.id, b);
            dropped.slice(0, 2).forEach((d, leg) => mapLeg(panel.id, b.number, leg + 1, d.id, cfg?.Wire || ''));
            if (cfg) cfg.State = 'identified';
            refreshDirty();
            stop();
            closeSheet();
            toast(`${b.number} is measured by ${dropped[0].id} and ${dropped[1].id}. Press Save to keep it.`, true);
            load();
          };
          result.appendChild(both);
        }
        result.appendChild(row);
      });
    };

    take.onclick = async () => {
      before = await readAll();
      const drawing = traceCandidates().filter(n => typeof before![n.id] === 'number' && (before![n.id] as number) > TRACE_FLOOR).length;
      step.textContent = `Baseline taken: ${drawing} of ${traceCandidates().length} channels are drawing power. `
        + `Now switch ${breakerNow()?.number || 'the breaker'} off. The reading is checked every few seconds — or press Read again.`;
      again.hidden = false;
      take.textContent = 'Take the baseline again';
      result.innerHTML = '';
      stop();
      watching = setInterval(() => compare(), 4000);
    };
    again.onclick = () => compare();
    pick.onchange = () => { result.innerHTML = ''; };
    step.textContent = 'Take a baseline of what every channel is drawing, then switch the breaker off.';

    openSheet({
      title: 'Trace a breaker',
      wide: true,
      onClose: stop,
      body: el('div', { class: 'ps-trace' },
        el('div', { class: 'desc' }, 'Switching a breaker off and reading which channel went dark identifies it without guessing. '
          + 'The circuit has to be drawing something for the drop to be visible.'),
        el('label', { class: 'ld-inst' }, 'Breaker ', pick),
        step, result),
      footer: [take, again],
    });
  };

  const edit = (panel: Panel, b: Breaker | null, slot: number, presetHalf?: number) => {
    if (state.viewer) { if (b) history(panel, b); return; }
    const entry = b ? configBreaker(panel.id, b) : null;
    const wasNumber = b?.number || '';
    const field = (label: string, input: any, hint?: string) =>
      el('div', { class: 'ps-field' }, el('label', { class: 'ps-label', text: label }), input,
        ...(hint ? [el('div', { class: 'desc', style: { margin: '2px 0 0' }, text: hint })] : []));
    const text = (value: string, placeholder = '') => {
      const i = el('input', { type: 'text', placeholder }) as HTMLInputElement;
      i.value = value;
      return i;
    };
    const number = text(b?.number || String(slot), 'as written, e.g. B06 or 26.1');
    const description = text(b?.description || '', 'what it feeds');
    const wire = text(b?.wire || '', 'e.g. W11');
    const gauge = text(b?.gauge || '', 'e.g. 12 AWG THWN');
    const conductor = el('select', {}) as HTMLSelectElement;
    [['', 'not stated'], ['copper', 'copper'], ['aluminium', 'aluminium']].forEach(([v, t]) => conductor.appendChild(el('option', { value: v, text: t })));
    conductor.value = b?.conductor || '';
    const amps = el('input', { type: 'number', min: '1', placeholder: 'e.g. 20' }) as HTMLInputElement;
    amps.value = b?.amps == null ? '' : String(b.amps);
    const poles = el('select', {}) as HTMLSelectElement;
    [['1', 'single pole'], ['2', 'double pole']].forEach(([v, t]) => poles.appendChild(el('option', { value: v, text: t })));
    poles.value = String(b?.poles || 1);
    const half = el('select', {}) as HTMLSelectElement;
    [['', 'the whole slot'], ['1', 'tandem, upper half'], ['2', 'tandem, lower half']].forEach(([v, t]) => half.appendChild(el('option', { value: v, text: t })));
    half.value = String(b?.half || presetHalf || '');
    const stateSel = el('select', {}) as HTMLSelectElement;
    [['identified', 'Identified'], ['unknown', 'Not identified yet'], ['unused', 'Unused slot']]
      .forEach(([v, t]) => stateSel.appendChild(el('option', { value: v, text: t })));
    stateSel.value = b?.state || 'unknown';

    const wholeBox = el('input', { type: 'checkbox', class: 'ps-whole' }) as HTMLInputElement;
    wholeBox.checked = !!clampFor(panel.id, wasNumber, 1)?.Whole;
    const pickers: HTMLSelectElement[] = [];
    const pickerRows = el('div', { class: 'ps-legs' });
    const hunt = el('input', { type: 'search', class: 'ps-hunt', placeholder: 'filter channels by name or id…' }) as HTMLInputElement;
    const huntCount = el('span', { class: 'desc', style: { margin: '0 0 0 8px' } });
    const above = new Set<string>();
    panelsIn().forEach((p: any) => { if (p.Id) above.add(p.Id); if (p.Node) above.add(p.Node); });
    const walkUp = (id: string) => { if (!id || above.has(id)) return; above.add(id); parentsOf(id).forEach(walkUp); };
    walkUp(configPanel(panel.id)?.Node || panel.node || '');
    const candidates = () => nodes.filter(n => PANEL_CIRCUIT_KINDS.includes(n.kind) && !n.id.startsWith('breaker:') && !above.has(n.id));
    const matching = (chosen: string) => {
      const q = hunt.value.trim().toLowerCase();
      const list = candidates();
      if (chosen && !list.some(n => n.id === chosen))
        list.push(nodes.find(n => n.id === chosen) || { id: chosen, label: `${chosen} — nothing reads it`, kind: 'node' });
      return list.filter(n => !q || n.id.toLowerCase().includes(q) || (n.label || '').toLowerCase().includes(q) || n.id === chosen);
    };
    const drawPickers = () => {
      pickerRows.innerHTML = '';
      pickers.length = 0;
      const doublePole = Number(poles.value) === 2;
      if (doublePole)
        pickerRows.appendChild(el('div', { class: 'ps-field' },
          el('label', { class: 'ld-inst' }, wholeBox, ' One CT measures the whole circuit, not one leg')));
      pickerRows.appendChild(el('div', { class: 'ps-field' }, el('label', { class: 'ld-inst' }, hunt, huntCount)));
      const legs = doublePole && !wholeBox.checked ? [1, 2] : [1];
      legs.forEach(leg => {
        const chosen = clampFor(panel.id, wasNumber, leg)?.Channel || '';
        const sel = el('select', { class: 'ps-node' }) as HTMLSelectElement;
        const fill = (keep: string) => {
          sel.innerHTML = '';
          sel.appendChild(el('option', { value: '', text: '— nothing measuring it —' }));
          const shown = matching(keep);
          shown.forEach(n => {
            const taken = takenBy(n.id, panel.id, wasNumber || number.value, leg);
            sel.appendChild(el('option', { value: n.id, text: `${n.label} (${n.id})${taken ? ` — already on ${taken}` : ''}` }));
          });
          sel.value = keep;
          huntCount.textContent = `${shown.length} of ${candidates().length} channels`;
        };
        const toNode = btn('Edit node');
        const configNode = () => (state.data?.EnergyFlow?.Nodes || []).find((x: any) => x.Id === sel.value);
        const syncToNode = () => {
          toNode.hidden = !configNode();
          toNode.title = toNode.hidden ? '' : `Edit ${sel.value} without leaving this breaker.`;
        };
        toNode.onclick = () => {
          const id = sel.value;
          openNodeSheet(id, nodes, () => {
            const n = nodes.find(x => x.id === id);
            const c = (state.data?.EnergyFlow?.Nodes || []).find((x: any) => x.Id === id);
            if (n && c) n.label = c.Label || id;
            pickers.forEach(p => (p as any)._fill(p.value));
          });
        };
        const fillAndSync = (keep: string) => { fill(keep); syncToNode(); };
        sel.onchange = syncToNode;
        fillAndSync(chosen);
        (sel as any)._fill = fillAndSync;
        pickers.push(sel);
        pickerRows.appendChild(field(legs.length > 1 ? `Measured by (leg ${leg})` : 'Measured by', el('div', { class: 'ps-node-row' }, sel, toNode),
          legs.length > 1 ? 'Both legs need a node before this breaker reports its power.' : ''));
      });
      hunt.oninput = () => pickers.forEach(p => (p as any)._fill(p.value));
    };
    poles.onchange = () => drawPickers();
    wholeBox.onchange = () => drawPickers();
    drawPickers();

    const onIt = placementsIn().filter(p => wasNumber && p.Circuit === `${panel.id}/${wasNumber}`);
    const placedField = !integrationIds.has('locations') ? null : field('Placed on it', onIt.length
      ? el('ul', { class: 'ps-placed' }, ...onIt.map(p => el('li', { text: `${p.Label || p.Kind}${p.Room ? ' — ' + p.Room : ''}` })))
      : el('div', { class: 'desc', text: 'Nothing on the floor plans is linked to this circuit.' }));

    const extDraft: any = { Ext: entry?.Ext ? JSON.parse(JSON.stringify(entry.Ext)) : undefined };
    const extBox = el('div', { class: 'ps-ext' });
    if (extensionsFor('breaker').length) renderExtensions('breaker', extDraft, extBox, []);

    const save = btn('Apply', 'primary');
    save.onclick = () => {
      const asSlotted = (x: any) => ({ slot: Number(x.Slot), poles: Number(x.Poles) || 1, half: x.Half ? Number(x.Half) : null });
      const next = { slot, poles: Number(poles.value) || 1, half: half.value ? Number(half.value) : null };
      const clash = (configPanel(panel.id)?.Breakers || []).find((x: any) => x !== entry && collides(next, asSlotted(x))
        && !(entry && collides(asSlotted(entry), asSlotted(x))));
      if (clash) { toast(`That position is already taken by ${clash.Number || clash.Slot}.`, false); return; }
      const target = entry || { Slot: slot };
      if (extDraft.Ext) target.Ext = extDraft.Ext;
      const newNumber = number.value.trim() || String(slot);
      target.Slot = slot;
      target.Number = newNumber;
      target.Description = description.value.trim();
      target.Wire = wire.value.trim();
      target.Gauge = gauge.value.trim();
      target.Conductor = conductor.value;
      target.Amps = amps.value ? Number(amps.value) : null;
      target.Poles = Number(poles.value) || 1;
      target.Half = half.value ? Number(half.value) : null;
      target.State = stateSel.value;
      if (!entry) {
        const p = configPanel(panel.id);
        if (p) ensure(p, 'Breakers', []).push(target);
      }
      if (wasNumber && wasNumber !== newNumber) {
        clampsIn().filter((c: any) => c.Panel === panel.id && c.Breaker === wasNumber).forEach((c: any) => { c.Breaker = newNumber; });
        const was = `${panel.id}/${wasNumber}`, now = `${panel.id}/${newNumber}`;
        [...placementsIn(), ...((flowIn().Nodes || []) as any[])].forEach((x: any) => { if (x.Circuit === was) x.Circuit = now; });
      }
      const whole = target.Poles === 2 && wholeBox.checked;
      pickers.forEach((sel, i) => mapLeg(panel.id, newNumber, i + 1, sel.value, target.Wire, whole && i === 0));
      if (whole || target.Poles === 1) mapLeg(panel.id, newNumber, 2, '', '');
      refreshDirty();
      closeSheet();
      toast('Breaker updated. Press Save to keep it.', true);
      load();
    };
    const traceBtn = btn('Trace it…');
    traceBtn.title = 'Identify this breaker by switching it off and reading which channel went dark.';
    traceBtn.onclick = () => { if (b) trace(panel, b); };
    traceBtn.hidden = !b;

    const remove = btn('Remove', 'danger');
    remove.hidden = !entry;
    remove.onclick = () => {
      const p = configPanel(panel.id);
      const list = p ? ensure(p, 'Breakers', []) : [];
      const at = list.indexOf(entry);
      if (at >= 0) list.splice(at, 1);
      refreshDirty();
      closeSheet();
      toast('Breaker removed. Press Save to keep it.', true);
      load();
    };

    const section = (title: string, ...children: any[]) =>
      el('section', { class: 'ps-sec' }, el('h4', { class: 'ps-sec-title', text: title }), el('div', { class: 'ps-sec-grid' }, ...children.filter(Boolean)));
    const wide = (f: HTMLElement) => { f.classList.add('ps-wide'); return f; };
    const full = (s: HTMLElement) => { s.classList.add('ps-sec-full'); return s; };
    const wiring = (s: HTMLElement) => { s.classList.add('ps-sec-wiring'); return s; };
    const hasExt = extensionsFor('breaker').length > 0;
    openSheet({
      title: `Slot ${slot}${b ? ` — ${b.number}` : ''}`,
      class: 'ps-sheet',
      body: el('div', { class: 'ps-editor' },
        section('Breaker', field('Breaker number', number), field('State', stateSel), wide(field('What it feeds', description))),
        section('Size', field('Rating (A)', amps), field('Poles', poles, 'Double pole spans the next slot down.'),
          field('Tandem', half, 'Two half-height breakers sharing one slot.')),
        wiring(section('Wiring', field('Wire label', wire), field('Wire gauge', gauge), field('Conductor', conductor))),
        full(section('Metering', wide(pickerRows))),
        ...(placedField || b?.node ? [full(section('Linked to', placedField && wide(placedField),
        ...(b?.node ? [wide(field('On the energy flow', el('div', {
          class: 'desc',
          style: { margin: '0' },
          text: (b.legs.some(l => l.channel === b.node)
            ? `It is the channel measuring it, ${b.node} — beneath ${panel.name || panel.id}. The circuit and the channel are one node, not two.`
            : `${b.derived ? 'This breaker is a tier of its own, ' : 'It is '}${b.node} — beneath ${panel.name || panel.id}, valued from `
              + `${b.legs.map(l => l.channel).filter(Boolean).join(' + ') || 'nothing measuring it yet'}.`)
            + ' It reaches Home Assistant, EmonCMS and Prometheus like any other node.',
        })))] : [])))] : []),
        hasExt ? full(section('More', wide(extBox))) : null),
      footer: [save, traceBtn, remove],
    });
  };

  /// What this breaker has been drawing: the channels measuring it, summed the way its power is.
  const history = (panel: Panel, b: Breaker) => {
    const toEditor = btn('Edit breaker', 'edit-only');
    toEditor.onclick = () => edit(panel, b, b.slot);
    const channels = b.legs.map(l => l.channel).filter(Boolean) as string[];
    openHistorySheet({
      title: `${b.number}${b.description ? ' — ' + b.description : ''}${b.amps ? ` (${b.amps} A)` : ''}`,
      nodes: channels,
      lineLabel: `${b.number}${b.description ? ' — ' + b.description : ''}`,
      labelOf,
      empty: GAPS[b.gap] || 'Nothing is measuring this breaker, so there is nothing to chart.',
      parts: channels.length > 1 ? channels : [],
      partsLabel: 'Its legs',
      footer: [toEditor],
    });
  };

  const powerText = (b: Breaker) => unitSel.value === 'A'
    ? (b.current == null ? 'no data' : `${b.current.toFixed(1)} A`)
    : (b.power == null ? 'no data' : `${Math.round(b.power).toLocaleString('en-US')} W`);

  const loadOf = (b: Breaker) => (b.current == null || !b.amps ? null : b.current / b.amps);
  const loadClass = (b: Breaker) => {
    const load = loadOf(b);
    return load == null ? '' : load >= 0.8 ? ' is-over' : load >= 0.6 ? ' is-busy' : ' is-easy';
  };

  const saysMore = (number: string, slotLabel: string) => {
    const digits = (s: string) => (s.match(/\d+/g) || []).join(',');
    return !!number && digits(number) !== digits(slotLabel);
  };

  const drawChecks = (drawn: Panel | null) => {
    checks.innerHTML = '';
    const mine = findings.filter(f => !f.breakers.length || f.breakers.some(b => b.split('/')[0] === drawn?.id));
    if (!mine.length) return;
    checks.appendChild(el('h3', { class: 'ps-checks-head', text: `${mine.length} thing${mine.length > 1 ? 's' : ''} to look at` }));
    mine.forEach(f => {
      const row = el('div', { class: 'ps-check is-' + f.severity }, el('span', { class: 'ps-check-kind', text: CHECK_TITLES[f.kind] || f.kind }), el('span', { class: 'ps-check-msg', text: f.message }));
      f.breakers.forEach(ref => {
        const [panelId, number] = [ref.slice(0, ref.indexOf('/')), ref.slice(ref.indexOf('/') + 1)];
        const b = panels.find(p => p.id === panelId)?.breakers.find(x => x.number === number);
        if (!b) return;
        const go = btn(number);
        go.title = `Open breaker ${number}`;
        go.onclick = () => { if (panelSel.value !== panelId) { panelSel.value = panelId; render(); } edit(panels.find(p => p.id === panelId)!, b, b.slot); };
        row.appendChild(go);
      });
      checks.appendChild(row);
    });
  };

  /// Paste a directory, see what each line reads as, then write it into the panel (#455).
  const importSheet = () => {
    const panel = shown();
    if (!panel) { toast('Add a panel first.', false); return; }
    const body = el('div', { class: 'ps-import' });
    const text = el('textarea', { class: 'ps-paste', rows: '10', spellcheck: 'false',
      placeholder: 'B06,W11,N30,1,5: Lights, Garage, Kitchen\nB07: Bathroom????\n1,3: AC Heat Strips\nB26.1: W21: Servers' }) as HTMLTextAreaElement;
    const file = el('input', { type: 'file', accept: '.csv,.txt,text/plain,text/csv', class: 'ps-file' }) as HTMLInputElement;
    file.onchange = async () => { const picked = file.files?.[0]; if (picked) { text.value = await picked.text(); read(); } };
    const pick = btn('Open a file…');
    pick.onclick = () => file.click();
    const out = el('div', { class: 'ps-rows' });
    const summary = el('div', { class: 'desc' });
    let rows: any[] = [];

    const read = async () => {
      out.innerHTML = '';
      summary.textContent = 'Reading…';
      let r: any;
      try { r = await api('/api/panels/import', { method: 'POST', body: JSON.stringify({ text: text.value, panel: panel.id, config: { EnergyFlow: flowIn() } }) }); }
      catch (e: any) { r = { body: { ok: false, message: e?.message } }; }
      if (!r.body?.ok) { summary.textContent = r.body?.message || 'Could not read it.'; return; }
      rows = r.body.rows || [];
      const raw = text.value.replace(/\r\n?/g, '\n').split('\n');
      let at = -1;
      rows.forEach((x: any) => {
        at = raw.findIndex((l, i) => i > at && l.trim().length > 0 && !l.trim().startsWith('#') && !l.trim().startsWith('//'));
        x.at = at;
      });
      const ok = rows.filter((x: any) => !x.note);
      summary.textContent = rows.length
        ? `${ok.length} of ${rows.length} line(s) read: ${ok.filter((x: any) => x.effect === 'add').length} new, `
          + `${ok.filter((x: any) => x.effect === 'update').length} updated, ${ok.filter((x: any) => x.effect === 'clash').length} clashing with a slot already taken. `
          + 'Nothing is written until you apply it, and nothing is kept until you press Save.'
        : 'Nothing to read yet.';
      rows.forEach((x: any) => {
        const row = el('div', { class: 'ps-row is-' + (x.note ? 'bad' : x.effect) });
        if (x.note) {
          const fix = el('input', { class: 'ps-row-fix', value: x.line, spellcheck: 'false' }) as HTMLInputElement;
          fix.onchange = () => {
            const lines = text.value.replace(/\r\n?/g, '\n').split('\n');
            if (x.at >= 0 && x.at < lines.length) { lines[x.at] = fix.value; text.value = lines.join('\n'); read(); }
          };
          row.appendChild(fix);
          row.appendChild(el('span', { class: 'ps-row-note', text: x.note }));
        }
        else {
          row.appendChild(el('span', { class: 'ps-row-line', text: x.line }));
          const bits = [x.number, x.poles === 2 ? 'double-pole' : x.half ? `tandem half ${x.half}` : '', x.wire, x.amps ? `${x.amps} A` : '',
            x.channel ? (x.channelKnown ? x.channel : `${x.channel} — no node with that id`) : '',
            x.description || (x.state === 'unused' ? 'unused' : 'not identified')];
          row.appendChild(el('span', { class: 'ps-row-read' + (x.channel && !x.channelKnown ? ' is-warn' : ''), text: bits.filter(Boolean).join(' · ') }));
          row.appendChild(el('span', { class: 'ps-row-effect', text: x.effect === 'add' ? 'new' : x.effect === 'update' ? 'updates it' : 'slot taken' }));
        }
        out.appendChild(row);
      });
    };
    text.oninput = () => { clearTimeout((text as any)._t); (text as any)._t = setTimeout(read, 250); };

    const apply = btn('Apply to the panel', 'primary');
    apply.onclick = () => {
      const cfg = configPanel(panel.id);
      if (!cfg) return;
      const list = ensure(cfg, 'Breakers', []);
      let added = 0, updated = 0, clashes = 0, mapped = 0;
      rows.filter((x: any) => !x.note).forEach((x: any) => {
        if (x.effect === 'clash') { clashes++; return; }
        let target = list.find((b: any) => String(b.Number || '').toLowerCase() === String(x.number).toLowerCase());
        if (target) updated++; else { target = { Slot: x.slot }; list.push(target); added++; }
        Object.assign(target, {
          Slot: x.slot, Number: x.number, Poles: x.poles, Half: x.half ?? null, Wire: x.wire || target.Wire || '',
          Description: x.description, State: x.state,
        });
        if (x.amps) target.Amps = x.amps;
        if (x.channel && x.channelKnown) { mapLeg(panel.id, x.number, 1, x.channel, x.wire || ''); mapped++; }
      });
      refreshDirty();
      closeSheet();
      toast(`${added} breaker(s) added, ${updated} updated${mapped ? `, ${mapped} mapped to a channel` : ''}`
        + `${clashes ? `, ${clashes} left alone because their slot is taken` : ''}. Press Save to keep it.`, true);
      load();
    };
    body.append(el('div', { class: 'desc', text: 'Paste the directory you already keep. Each line can carry the breaker number, the wire label, the monitor channel and what it feeds, in any order; “????” marks one nobody has identified and “Unused” an empty slot.' }),
      text, el('div', { class: 'ld-toolbar', style: { gap: '8px' } }, pick, file), summary, out);
    openSheet({ title: `Import into ${panel.name || panel.id}`, body, wide: true, footer: [apply] });
  };
  importBtn.onclick = () => importSheet();

  const printWords = (b: Breaker) =>
    b.state === 'unused' ? 'Unused'
      : b.state === 'unknown' ? (b.description ? `${b.description} ????` : 'Unknown')
        : b.description || 'Unknown';

  const printedOn = () => new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
  const slotsOf = (p: Panel) => Number(configPanel(p.id)?.Slots) || p.slots;

  const halfIn = (b: Breaker, slot: number) => !b.half ? 0 : b.slot === slot ? b.half : 3 - b.half;

  /// One slot as paper carries it: a paragraph per breaker, so a tandem's halves each get their own lines.
  const paperSlot = (p: Panel, slot: number, slots: number) => {
    const on = p.breakers.filter(b => b.slot === slot || (b.poles === 2 && b.slot + 2 === slot));
    const own = on.filter(b => b.slot === slot);
    const above = on.filter(b => b.slot !== slot);
    return {
      span: own.length === 1 && own[0].poles === 2 && !own[0].half && on.length === 1 && slot + 2 <= slots,
      below: own.length === 0 && above.length === 1 && !above[0].half,
      words: on.length ? [...on].sort((a, b) => halfIn(a, slot) - halfIn(b, slot))
        .map(b => b.slot === slot ? printWords(b) : `${b.number || b.slot} (2-pole)`) : ['Empty'],
      wire: own.map(b => b.wire).filter(Boolean),
      amps: own.map(b => b.amps ? String(b.amps) : '').filter(Boolean),
      gap: !on.length || own.some(b => b.state === 'unknown' || (b.state !== 'unused' && !b.description)),
    };
  };

  const directoryPdf = (p: Panel, slots: number) => {
    const margin = 36, titleH = 30, headH = 16, pad = 4, bus = 16;
    const left = margin, right = 612 - margin, room = 792 - 2 * margin - titleH - headH;
    const rows = Math.ceil(slots / 2);
    const cells = Array.from({ length: slots }, (_, i) => paperSlot(p, i + 1, slots));
    const cell = (slot: number) => cells[slot - 1];
    const continued = (slot: number) => slot > 2 && cell(slot - 2).span && cell(slot).below;

    const lay = (size: number) => {
      const lead = size * 1.2;
      const wireW = Math.min(110, Math.max(36, ...cells.flatMap(c => c.wire).map(w => pdfTextWidth(w, size) + 2 * pad)));
      const ampsW = pdfTextWidth('100', size) + 2 * pad, numW = pdfTextWidth('100', size, 'bold') + 2 * pad;
      const descW = (right - left - bus) / 2 - wireW - ampsW - numW;
      const widths = [numW, ampsW, wireW, descW, descW, wireW, ampsW, numW];
      const wrap = (paras: string[], w: number, face: 'regular' | 'italic' = 'regular') => paras.flatMap(t => pdfWrap(t, w - 2 * pad, size, face));
      const text = cells.map(c => ({ desc: wrap(c.words, descW, c.gap ? 'italic' : 'regular'), wire: wrap(c.wire, wireW), amps: wrap(c.amps, ampsW) }));
      const need = (slot: number) => { const t = text[slot - 1]; return Math.max(t.desc.length, t.wire.length, t.amps.length, 1) * lead + 2 * pad; };
      const heights = Array.from({ length: rows }, (_, r) => Math.max(lead + 2 * pad,
        ...[2 * r + 1, 2 * r + 2].filter(s => s <= slots && !cell(s).span && !continued(s)).map(need)));
      cells.forEach((c, i) => {
        if (!c.span) return;
        const r = Math.floor(i / 2), short = need(i + 1) - heights[r] - heights[r + 1];
        if (short > 0) { heights[r] += short / 2; heights[r + 1] += short / 2; }
      });
      return { size, lead, widths, text, heights, total: heights.reduce((a, h) => a + h, 0) };
    };
    let L = lay(7);
    for (let size = 11; size > 7; size -= 0.5) { const t = lay(size); if (t.total <= room) { L = t; break; } }
    if (L.total < room) { const extra = Math.min((room - L.total) / rows, 3 * L.lead); L.heights = L.heights.map(h => h + extra); }
    const { size, lead, widths, text, heights } = L;
    const xs = widths.reduce((a, w, i) => [...a, a[a.length - 1] + w + (i === 3 ? bus : 0)], [left]);
    const midL = xs[4] - bus;

    const pagesOf: number[][] = [[]];
    let used = 0;
    for (let r = 0; r < rows; r++) {
      const joined = [2 * r + 1, 2 * r + 2].some(s => s <= slots && cell(s).span);
      const take = joined ? heights[r] + heights[r + 1] : heights[r];
      if (used + take > room + 0.01 && pagesOf[pagesOf.length - 1].length) { pagesOf.push([]); used = 0; }
      pagesOf[pagesOf.length - 1].push(r);
      used += heights[r];
      if (joined) { pagesOf[pagesOf.length - 1].push(++r); used += heights[r]; }
    }

    const when = printedOn();
    const block = (page: PdfPage, lines: string[], x: number, w: number, y: number, h: number, opt: any = {}) => {
      const first = y + (h - lines.length * lead) / 2 + lead * 0.78;
      lines.forEach((l, i) => page.text(opt.center ? x + w / 2 : x + pad, first + i * lead, l, size, { ...opt, align: opt.center ? 'center' : 'left' }));
    };
    const pages = pagesOf.map((list, pg) => {
      const page = pdfPage();
      page.text(left, margin + 14, p.name || p.id, 14, { face: 'bold' });
      page.text(right, margin + 14, `${slots} slots · ${when}` + (pagesOf.length > 1 ? ` · page ${pg + 1} of ${pagesOf.length}` : ''), 9, { gray: 0.33, align: 'right' });
      const head = margin + titleH;
      page.fill(left, head, midL - left, headH, 0.93);
      page.fill(xs[4], head, right - xs[4], headH, 0.93);
      ['#', 'A', 'Wire', 'Circuit', 'Circuit', 'Wire', 'A', '#'].forEach((h, i) => page.text(xs[i] + widths[i] / 2, head + 11, h.toUpperCase(), 7, { face: 'bold', align: 'center' }));
      const ys: number[] = [];
      let y = head + headH;
      list.forEach(r => { ys.push(y); y += heights[r]; });
      const bottom = y;
      list.forEach((r, k) => {
        [0, 1].forEach(side => {
          const slot = 2 * r + 1 + side;
          if (slot > slots) return;
          const [desc, wire, amps, num] = side === 0 ? [3, 2, 1, 0] : [4, 5, 6, 7];
          page.fill(xs[num], ys[k], widths[num], heights[r], 0.95);
          block(page, [String(slot)], xs[num], widths[num], ys[k], heights[r], { face: 'bold', center: true });
          if (continued(slot)) return;
          const h = cell(slot).span ? heights[r] + heights[r + 1] : heights[r];
          const t = text[slot - 1];
          block(page, t.amps, xs[amps], widths[amps], ys[k], h, { center: true });
          block(page, t.wire, xs[wire], widths[wire], ys[k], h, { center: true });
          block(page, t.desc, xs[desc], widths[desc], ys[k], h, cell(slot).gap ? { face: 'italic', gray: 0.33 } : {});
        });
      });
      list.forEach((r, k) => {
        if (k === 0) return;
        const y0 = ys[k];
        const spanL = cell(2 * r - 1)?.span, spanR = 2 * r <= slots && cell(2 * r).span;
        page.rule(left, y0, spanL ? xs[1] : midL, y0);
        page.rule(spanR ? xs[7] : xs[4], y0, right, y0);
      });
      [...xs, midL].forEach((x, i) => page.rule(x, head, x, bottom, i === 0 || i === 8 ? 0.75 : 0.5));
      [head, head + headH, bottom].forEach(y0 => { page.rule(left, y0, midL, y0, 0.75); page.rule(xs[4], y0, right, y0, 0.75); });
      return page;
    });
    return pdfDocument(pages, `${p.name || p.id} — panel directory`);
  };

  /// A breaker as a line of the directory Import reads (#455), so an export pastes straight back in.
  const directoryLine = (b: Breaker) => {
    const num = /^(?:[Bb])?(\d{1,3})(?:\.(\d))?(?:\s*[,/]\s*(?:[Bb])?(\d{1,3})(?:\.(\d))?)?$/.exec(b.number.trim());
    const other = b.half ? 3 - b.half : 0;
    const fits = !!num && Number(num[1]) === b.slot
      && (b.half ? Number(num[2]) === b.half : !num[2])
      && (b.poles === 2
        ? Math.abs(Number(num[3]) - b.slot) === 2 && (b.half ? Number(num[4]) === other : !num[4])
        : !num[3] && !num[4]);
    const number = fits ? b.number.trim()
      : b.poles === 2 ? (b.half ? `${b.slot}.${b.half},${b.slot + 2}.${other}` : `${b.slot},${b.slot + 2}`)
        : b.half ? `${b.slot}.${b.half}` : String(b.slot);
    const ch = /^([a-z][a-z0-9]{0,15})_(\d{1,3})(?:_(\d{1,3}))?$/i.exec(b.legs?.[0]?.channel || '');
    const channel = ch && !/^w\d/i.test(ch[1]) ? [ch[1].toUpperCase(), ch[2], ch[3]].filter(Boolean).join(',') : '';
    const labels = [number, /^[Ww]\d{1,3}[A-Za-z]?$/.test(b.wire) ? b.wire : '', b.amps ? `${b.amps}A` : '', channel];
    const words = (b.description || '').replace(/\s+/g, ' ').trim();
    const feeds = b.state === 'unused' ? 'Unused' : b.state === 'unknown' || !words ? `${words} ????`.trim() : words;
    return `${labels.filter(Boolean).join(',')}: ${feeds}`;
  };
  const directoryText = (p: Panel, slots: number) => [
    `# ${p.name || p.id}: ${slots} slots, exported ${new Date().toISOString().slice(0, 10)}`,
    '# Breaker, wire, rating, channel: what it feeds. ???? marks one nobody has identified. Import reads this back.',
    ...[...p.breakers].sort((a, b) => a.slot - b.slot || (a.half || 0) - (b.half || 0)).map(directoryLine),
  ].join('\n') + '\n';

  const exportSheet = () => {
    const p = shown();
    if (!p) { toast('Add a panel first.', false); return; }
    const slots = slotsOf(p);
    const stem = (slug(p.name || p.id) || 'panel') + '-directory';
    const pdf = btn('PDF', 'primary');
    pdf.onclick = () => { saveFile(directoryPdf(p, slots), `${stem}.pdf`, 'application/pdf'); closeSheet(); };
    const text = btn('Directory text');
    text.onclick = () => { saveFile(directoryText(p, slots), `${stem}.txt`, 'text/plain'); closeSheet(); };
    openSheet({
      title: `Export ${p.name || p.id}`,
      body: el('div', { class: 'desc', text: 'PDF is the printed directory, for the panel door. Directory text is one line a breaker — number, wire, rating, channel and what it feeds — that Import… reads back.' }),
      footer: [text, pdf],
    });
  };
  exportBtn.onclick = () => exportSheet();

  const render = () => {
    grid.innerHTML = '';
    const drawn = shown();
    const cfg = drawn ? configPanel(drawn.id) : null;
    settings.hidden = !drawn;
    if (!drawn) {
      grid.appendChild(el('div', { class: 'desc', text: 'No panels yet. Add one to start a directory, then fill in its slots.' }));
      return;
    }
    const slots = Number(cfg?.Slots) || drawn.slots;
    const rows = Math.ceil(slots / 2);
    nameIn.value = cfg?.Name ?? drawn.name;
    panelExt.innerHTML = '';
    if (cfg) renderExtensions('panel', cfg, panelExt, ['EnergyFlow', 'Panels', String(panelsIn().indexOf(cfg))]);
    slotsIn.value = String(slots);

    const panelNode = cfg?.Node ?? drawn.node ?? '';
    nodeSel.innerHTML = '';
    nodeSel.appendChild(el('option', { value: '', text: '— not mapped —' }));
    const claimed = new Set(panelsIn().filter((p: any) => p.Id !== drawn.id).map((p: any) => p.Node).filter(Boolean));
    const panelChoices = nodes.filter(n => n.kind === 'panel' && !claimed.has(n.id));
    if (panelNode && !panelChoices.some(n => n.id === panelNode))
      panelChoices.push(nodes.find(n => n.id === panelNode) || { id: panelNode, label: panelNode, kind: 'node' });
    panelChoices.forEach(n => nodeSel.appendChild(el('option', {
      value: n.id, text: `${n.label} (${n.id})${n.kind === 'panel' ? '' : ' — not a panel'}`,
    })));
    nodeSel.value = panelNode;
    feeders.innerHTML = '';
    const fedBy = panelNode ? parentsOf(panelNode) : [];
    fedBy.forEach(from => {
      const chip = el('span', { class: 'ps-chip' }, el('span', { text: labelOf(from) }));
      const drop = el('button', { class: 'ps-chip-x', text: '×', title: `${labelOf(from)} no longer feeds this panel` });
      drop.onclick = () => {
        const links = linksIn();
        for (let i = links.length - 1; i >= 0; i--) if (links[i].To === panelNode && links[i].From === from) links.splice(i, 1);
        refreshDirty();
        render();
      };
      chip.appendChild(drop);
      feeders.appendChild(chip);
    });
    if (!fedBy.length) feeders.appendChild(el('span', { class: 'desc', style: { margin: '0' }, text: panelNode ? 'nothing yet' : 'pick the panel’s node first' }));
    feedAdd.innerHTML = '';
    feedAdd.appendChild(el('option', { value: '', text: '+ add a feeder' }));
    nodes.filter(n => n.id !== panelNode && !fedBy.includes(n.id))
      .forEach(n => feedAdd.appendChild(el('option', { value: n.id, text: `${n.label} (${n.id})` })));
    feedAdd.hidden = !panelNode || fedBy.length > 0;
    feedAdd.disabled = !panelNode;

    const volts = drawn.volts == null ? '' : ` at ${drawn.volts.toFixed(1)} V`;
    incoming.textContent = !panelNode
      ? 'No node is mapped to this panel, so there is no incoming power to draw. Pick one under Panel settings.'
      : drawn.incoming == null
        ? `Incoming: no data${volts ? `, though ${labelOf(panelNode)} reports${volts}` : ` — ${labelOf(panelNode)} has no current reading`}.`
        : `Incoming: ${Math.round(drawn.incoming).toLocaleString('en-US')} W${volts} through ${labelOf(panelNode)}.`;
    drawChecks(drawn);
    grid.style.gridTemplateRows = `repeat(${rows}, minmax(var(--ps-row), auto))`;

    [true, false].forEach(left => {
      column(slots, drawn.breakers, left).forEach(cell => {
        const place = `${rowOf(cell.slot)} / span ${cell.span}`;
        const box = el('div', {
          class: 'ps-cell ' + (left ? 'is-left' : 'is-right') + (cell.span > 1 && cell.halves.length === 1 ? ' is-double' : '')
            + (cell.halves.length ? '' : ' is-empty'),
          style: { gridColumn: left ? '2' : '3', gridRow: place },
        });
        box.dataset.slot = String(cell.slot);
        const covers = Array.from({ length: cell.span }, (_, i) => cell.slot + 2 * i);
        const lastSlot = covers[covers.length - 1];
        const stamped = el('div', {
          class: 'ps-nums',
          style: { gridColumn: left ? '1' : '4', gridRow: place },
        }, ...covers.map(n => el('span', { text: String(n) })));
        stamped.setAttribute('aria-hidden', 'true');
        grid.appendChild(stamped);
        if (!cell.halves.length) {
          const blank = el('span', { class: 'ps-breaker is-empty' }, el('span', { class: 'ps-pole is-empty' }));
          blank.setAttribute('aria-hidden', 'true');
          const add = el('button', { class: 'ps-open is-empty' }, blank, el('span', { class: 'ps-desc', text: 'empty' }));
          add.title = `Slot ${cell.slot} — nothing recorded. Tap to add a breaker.`;
          add.onclick = () => edit(drawn, null, cell.slot);
          box.appendChild(add);
        } else {
          cell.parts.forEach(part => {
            const b = part.b;
            if (!b) {
              const vacant = el('span', { class: 'ps-breaker is-empty' }, el('span', { class: 'ps-pole is-empty' }));
              vacant.setAttribute('aria-hidden', 'true');
              const which = part.half === 1 ? 'upper' : 'lower';
              const other = el('button', { class: 'ps-open is-empty' }, vacant,
                el('span', { class: 'ps-desc', text: cell.span > 1 ? `${part.slot}: empty ${which} half` : `empty ${which} half` }));
              other.title = `Slot ${part.slot}, ${which} half: empty. Tap to fill it in.`;
              other.onclick = () => edit(drawn, null, part.slot, part.half || undefined);
              box.appendChild(other);
              return;
            }
            const poles = b.poles === 2 && b.slot + 2 <= lastSlot ? 2 : 1;
            const handle = el('span', { class: 'ps-breaker is-' + b.state });
            for (let i = 0; i < poles; i++)
              handle.appendChild(el('span', { class: 'ps-pole is-' + b.state },
                el('span', { class: 'ps-throw', text: b.amps ? String(b.amps) : '' })));
            if (poles === 2) handle.appendChild(el('span', { class: 'ps-tie' }));
            handle.setAttribute('aria-hidden', 'true');
            const open = el('button', { class: 'ps-open' },
              handle,
              ...(saysMore(b.number, poles === 2 ? `${b.slot}+${b.slot + 2}` : String(b.slot)) ? [el('span', { class: 'ps-num', text: b.number })] : []),
              el('span', { class: 'ps-desc', text: b.state === 'unused' ? 'Unused' : b.description || 'Not identified' }),
              ...(b.state === 'unknown' ? [el('span', { class: 'ps-mark', text: '????', title: 'Nobody has identified this circuit yet.' })] : []),
              el('span', { class: 'ps-meta', text: [b.wire, b.amps ? `${b.amps} A` : '', b.gauge].filter(Boolean).join(' · ') }));
            open.title = 'Edit this breaker — what it feeds, its wire, rating, and the node measuring it.';
            open.onclick = () => edit(drawn, b, b.slot);
            const shown = unitSel.value === 'A' ? b.current : b.power;
            const reading = el('button', { class: 'ps-power' + (shown == null ? ' is-nodata' : loadClass(b)), text: powerText(b) });
            const load = loadOf(b);
            reading.title = shown == null
              ? (GAPS[b.gap] || 'No reading for this breaker.')
              : (load == null ? '' : `${b.current!.toFixed(1)} A of ${b.amps} A — ${Math.round(load * 100)}% of the breaker. `)
                + `Measured by ${b.legs.map(l => l.channel).filter(Boolean).join(' + ')}. Tap for what it has been drawing.`;
            reading.onclick = () => history(drawn, b);
            box.appendChild(el('div', { class: 'ps-half is-' + b.state }, open, reading));
          });
        }
        grid.appendChild(box);
      });
    });
  };

  link.onclick = () => { activate(link, sec); load(); };
  setInterval(() => { if (sec.classList.contains('active')) load(); }, 10000);
  return { link, sec };
}
