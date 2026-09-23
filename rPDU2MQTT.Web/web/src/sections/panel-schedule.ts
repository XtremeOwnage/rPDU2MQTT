// The panel schedule (#453): a panel drawn as it is — two columns of slots, a breaker handle on each — with
// each breaker's number, wire, rating, what it feeds and the live power of the channel measuring it (#454).
// Slots, breakers, tandem halves and the node measuring each leg are all edited here.
import { activate, api, btn, closeSheet, el, ensure, navLink, openSheet, toast } from '../helpers.js';
import { openHistorySheet } from '../history-sheet.js';
import { state } from '../state.js';
import { refreshDirty } from '../dirty.js';
import { column, rowOf } from '../panel-layout.js';
import { locationChoices, choiceSelect } from '../location-options.js';

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

/// The kinds of node a breaker's circuit can be. A subpanel counts: a breaker feeding one is measured by the
/// CT on its feed. What carries the breaker — its own panel, and whatever feeds that — is ruled out separately.
const PANEL_CIRCUIT_KINDS = ['breaker', 'outlet', 'load', 'node', 'panel'];

export function addPanelScheduleSection(nav: any, sections: any) {
  const link = navLink(nav, 'Panel Schedule', '🗂');
  link.dataset.section = 'EnergyFlow';
  const sec = el('div', { class: 'section ps' });
  sections.appendChild(sec);
  sec.appendChild(el('h2', { text: 'Panel Schedule' }));
  sec.appendChild(el('div', { class: 'desc' },
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
  importBtn.title = 'Paste a directory you already keep — breaker numbers, wires, channels and what each feeds — and see what it reads as before anything is written.';
  // Watts or amps: the same reading, in the unit the question is being asked in.
  const unitSel = el('select', { class: 'ps-unit' }) as HTMLSelectElement;
  [['W', 'watts'], ['A', 'amps']].forEach(([v, t]) => unitSel.appendChild(el('option', { value: v, text: t })));
  unitSel.title = 'Show what each breaker is drawing in watts, or in amps against its rating.';
  unitSel.onchange = () => render();
  const status = el('span', { class: 'ld-count' });
  sec.appendChild(el('div', { class: 'ld-toolbar', style: { flexWrap: 'wrap', gap: '8px' } },
    el('label', { class: 'ld-inst' }, 'Panel ', panelSel), el('label', { class: 'ld-inst' }, 'Show ', unitSel), refresh, addPanel, importBtn, traceStart, printBtn, status));

  // The panel's own settings: what it is called, and how many slots it has.
  const nameIn = el('input', { type: 'text', placeholder: 'Main Panel' }) as HTMLInputElement;
  const slotsIn = el('input', { type: 'number', min: '2', max: '200', step: '2', class: 'ps-slots' }) as HTMLInputElement;
  slotsIn.title = 'How many breaker positions the panel has, counting both columns. A 42-space panel has 42.';
  // The node that is this panel: its reading is the power coming in, and its breakers' circuits hang beneath it.
  const nodeSel = el('select', { class: 'ps-panel-node' }) as HTMLSelectElement;
  nodeSel.title = 'The energy-flow node that is this panel. Its reading is the power coming in, and a circuit mapped to one of its breakers is placed beneath it.';
  const feeders = el('span', { class: 'ps-feeders' });
  const feedAdd = el('select', { class: 'ps-feed-add' }) as HTMLSelectElement;
  // Where the panel is mounted, from the locations on the Floor Plans page.
  const whereBox = el('span', { class: 'ps-where' });
  feedAdd.title = 'Add a node that feeds this panel.';
  const settings = el('div', { class: 'ld-toolbar', style: { flexWrap: 'wrap', gap: '8px' } },
    el('label', { class: 'ld-inst' }, 'Name ', nameIn),
    el('label', { class: 'ld-inst' }, 'Slots ', slotsIn),
    el('label', { class: 'ld-inst' }, 'This panel is ', nodeSel),
    el('label', { class: 'ld-inst' }, 'Fed by ', feeders, feedAdd),
    el('label', { class: 'ld-inst' }, 'Mounted in ', whereBox));
  sec.appendChild(settings);
  const incoming = el('div', { class: 'desc ps-incoming' });
  sec.appendChild(incoming);

  // What the mapping contradicts, or the readings do (#457). A report: nothing here changes the directory.
  const checks = el('div', { class: 'ps-checks' });
  sec.appendChild(checks);

  const grid = el('div', { class: 'ps-grid' });
  // The enclosure: the two columns of breakers either side of the bus bar down the middle.
  sec.appendChild(el('div', { class: 'ps-panel' }, el('div', { class: 'ps-bus' }), grid));

  // The same directory laid out for the inside of the panel door (#460): shown only on paper.
  const printable = el('div', { class: 'ps-print' });
  sec.appendChild(printable);
  traceStart.onclick = () => {
    const p = shown();
    if (!p) { toast('Add a panel first.', false); return; }
    trace(p, null);
  };
  printBtn.onclick = () => {
    const w: any = window;
    if (typeof w.print === 'function') w.print();
    else toast('This browser cannot print from here.', false);
  };

  let panels: Panel[] = [];
  let findings: Finding[] = [];
  let nodes: { id: string; label: string; kind: string }[] = [];

  const flowIn = () => ensure(state.data, 'EnergyFlow', {});
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
    // Resolved from the directory on screen rather than the saved one, so an edit is drawn before Save.
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
    // The nodes a breaker's circuit can be: whatever the bridge already reads.
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
    // Two slots to a row, so an odd count would leave half a row: the panel is sized in rows.
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
      // A channel that went dark: it was drawing, and now it is not. One that stopped reporting altogether is
      // not a channel that went dark, so it is not offered as the answer.
      const dropped = drawing.filter(n => typeof after[n.id] === 'number'
        && (after[n.id] as number) <= Math.max(TRACE_FLOOR, (was(n.id) as number) * 0.15));
      result.innerHTML = '';
      if (!drawing.length) {
        // Nothing was drawing to begin with, so switching anything off changes nothing anyone can read.
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
        // A channel already recorded against another breaker: one of the two records is wrong, so it is said here.
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
    [['1', 'single pole'], ['2', 'double pole (spans the next slot down)']].forEach(([v, t]) => poles.appendChild(el('option', { value: v, text: t })));
    poles.value = String(b?.poles || 1);
    const half = el('select', {}) as HTMLSelectElement;
    [['', 'the whole slot'], ['1', 'tandem, upper half'], ['2', 'tandem, lower half']].forEach(([v, t]) => half.appendChild(el('option', { value: v, text: t })));
    half.value = String(b?.half || presetHalf || '');
    const stateSel = el('select', {}) as HTMLSelectElement;
    [['identified', 'Identified'], ['unknown', 'Not identified yet'], ['unused', 'Unused slot']]
      .forEach(([v, t]) => stateSel.appendChild(el('option', { value: v, text: t })));
    stateSel.value = b?.state || 'unknown';

    // One picker per leg: which node the bridge already reads is this circuit. A 240 V circuit is often
    // measured by a single CT, which is the whole breaker rather than half of it.
    const wholeBox = el('input', { type: 'checkbox', class: 'ps-whole' }) as HTMLInputElement;
    wholeBox.checked = !!clampFor(panel.id, wasNumber, 1)?.Whole;
    const pickers: HTMLSelectElement[] = [];
    const pickerRows = el('div', {});
    // A house has more channels than anyone wants to scroll: type to narrow them.
    const hunt = el('input', { type: 'search', class: 'ps-hunt', placeholder: 'filter channels by name or id…' }) as HTMLInputElement;
    const huntCount = el('span', { class: 'desc', style: { margin: '0 0 0 8px' } });
    // What carries this breaker: any panel in the directory, and whatever feeds this one, up the chain. A
    // breaker cannot be measured by something it hangs beneath.
    const above = new Set<string>();
    panelsIn().forEach((p: any) => { if (p.Id) above.add(p.Id); if (p.Node) above.add(p.Node); });
    const walkUp = (id: string) => { if (!id || above.has(id)) return; above.add(id); parentsOf(id).forEach(walkUp); };
    walkUp(configPanel(panel.id)?.Node || panel.node || '');
    // A breaker's own tier is not a channel either: nothing measures it, so nothing can be measured by it.
    const candidates = () => nodes.filter(n => PANEL_CIRCUIT_KINDS.includes(n.kind) && !n.id.startsWith('breaker:') && !above.has(n.id));
    /// The channels worth showing: those matching what was typed, and whatever is already picked, which must
    /// never be filtered out from under the person looking at it — a pick the list has lost would be cleared
    /// by the next Apply.
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
        fill(chosen);
        (sel as any)._fill = fill;
        pickers.push(sel);
        pickerRows.appendChild(field(legs.length > 1 ? `Measured by (leg ${leg})` : 'Measured by', sel,
          legs.length > 1 ? 'Both legs need a node before this breaker reports its power.' : ''));
      });
      // Filtering keeps whatever is picked, so narrowing the list never quietly unpicks it.
      hunt.oninput = () => pickers.forEach(p => (p as any)._fill(p.value));
    };
    poles.onchange = () => drawPickers();
    wholeBox.onchange = () => drawPickers();
    drawPickers();

    // The rooms and areas the circuit serves (#459), and what is placed on it on the floor plans (#464).
    const served = new Set<string>(entry?.Rooms || []);
    const serves = el('div', { class: 'ps-serves' });
    const places = locationChoices();
    places.forEach(([id, label]) => {
      const cb = el('input', { type: 'checkbox' }) as HTMLInputElement;
      cb.checked = served.has(id);
      cb.onchange = () => { if (cb.checked) served.add(id); else served.delete(id); };
      serves.appendChild(el('label', { class: 'ld-inst' }, cb, ' ' + label.trim()));
    });
    const servesField = field('Serves', places.length ? serves : el('div', { class: 'desc', text: 'No rooms yet — add them on the Floor Plans page.' }),
      'The rooms and areas this circuit feeds. A room then lists it among the circuits serving it.');
    const onIt = ((state.data?.EnergyFlow?.Placements || []) as any[]).filter(p => wasNumber && p.Circuit === `${panel.id}/${wasNumber}`);
    const placedField = field('Placed on it', onIt.length
      ? el('ul', { class: 'ps-placed' }, ...onIt.map(p => el('li', { text: `${p.Label || p.Kind}${p.Room ? ' — ' + p.Room : ''}` })))
      : el('div', { class: 'desc', text: 'Nothing on the floor plans is linked to this circuit.' }));

    const save = btn('Apply', 'primary');
    save.onclick = () => {
      const target = entry || { Slot: slot };
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
      target.Rooms = [...served];
      if (!entry) {
        const p = configPanel(panel.id);
        if (p) ensure(p, 'Breakers', []).push(target);
      }
      // A renamed breaker keeps the clamps, placements and devices that were recorded against its old number.
      if (wasNumber && wasNumber !== newNumber) {
        clampsIn().filter((c: any) => c.Panel === panel.id && c.Breaker === wasNumber).forEach((c: any) => { c.Breaker = newNumber; });
        const was = `${panel.id}/${wasNumber}`, now = `${panel.id}/${newNumber}`;
        [...((flowIn().Placements || []) as any[]), ...((flowIn().Nodes || []) as any[])].forEach((x: any) => { if (x.Circuit === was) x.Circuit = now; });
      }
      const whole = target.Poles === 2 && wholeBox.checked;
      pickers.forEach((sel, i) => mapLeg(panel.id, newNumber, i + 1, sel.value, target.Wire, whole && i === 0));
      // One CT for the whole circuit leaves no second leg to record.
      if (whole || target.Poles === 1) mapLeg(panel.id, newNumber, 2, '', '');
      // The breaker is a node of the flow in its own right (#458), beneath its panel and above its channels,
      // so nothing has to be wired by hand here.
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

    openSheet({
      title: `Slot ${slot}${b ? ` — ${b.number}` : ''}`,
      body: el('div', {}, field('Breaker number', number), field('What it feeds', description),
        field('Wire label', wire), field('Wire gauge', gauge), field('Conductor', conductor),
        field('Rating (A)', amps), field('Poles', poles),
        field('Tandem', half, 'A tandem breaker is two half-height breakers sharing one slot.'),
        field('State', stateSel), pickerRows, servesField, placedField,
        ...(b?.node ? [field('On the energy flow', el('div', {
          class: 'desc',
          style: { margin: '0' },
          // A breaker measured by one channel is that channel: a tier above it would carry the same reading twice.
          text: (b.legs.some(l => l.channel === b.node)
            ? `It is the channel measuring it, ${b.node} — beneath ${panel.name || panel.id}. The circuit and the channel are one node, not two.`
            : `${b.derived ? 'This breaker is a tier of its own, ' : 'It is '}${b.node} — beneath ${panel.name || panel.id}, valued from `
              + `${b.legs.map(l => l.channel).filter(Boolean).join(' + ') || 'nothing measuring it yet'}.`)
            + ' It reaches Home Assistant, EmonCMS and Prometheus like any other node.',
        }))] : [])),
      footer: [save, traceBtn, remove],
    });
  };

  /// What this breaker has been drawing: the channels measuring it, summed the way its power is.
  const history = (panel: Panel, b: Breaker) => {
    const toEditor = btn('Edit breaker');
    toEditor.onclick = () => edit(panel, b, b.slot);
    openHistorySheet({
      title: `${b.number}${b.description ? ' — ' + b.description : ''}${b.amps ? ` (${b.amps} A)` : ''}`,
      nodes: b.legs.map(l => l.channel).filter(Boolean) as string[],
      lineLabel: `${b.number}${b.description ? ' — ' + b.description : ''}`,
      labelOf,
      empty: GAPS[b.gap] || 'Nothing is measuring this breaker, so there is nothing to chart.',
      footer: [toEditor],
    });
  };

  const powerText = (b: Breaker) => unitSel.value === 'A'
    ? (b.current == null ? 'no data' : `${b.current.toFixed(1)} A`)
    : (b.power == null ? 'no data' : `${Math.round(b.power).toLocaleString('en-US')} W`);

  /// How hard the circuit is working, against the breaker holding it. Only ever from a current reading —
  /// dividing watts by a voltage nobody measured would be a number we made up.
  const loadOf = (b: Breaker) => (b.current == null || !b.amps ? null : b.current / b.amps);
  const loadClass = (b: Breaker) => {
    const load = loadOf(b);
    return load == null ? '' : load >= 0.8 ? ' is-over' : load >= 0.6 ? ' is-busy' : ' is-easy';
  };

  /// Whether a breaker's number says anything the slot stamp has not already said: "1,3" in slots 1+3 has not,
  /// but "B06" and a tandem's "26.1" have.
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
      // Straight to the breaker it names, so it can be put right.
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
      // Which line of the box each row came from, so one that could not be read can be corrected in place.
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
          // Not read: the line itself is the field, so it can be put right without hunting for it above.
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
        // A channel the line named, recorded as the clamp that measures the breaker.
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

  /// What a breaker reads as on paper: what it feeds, or that nobody has identified it. Never blank —
  /// a slot nobody has written down is the point of printing it.
  const printWords = (b: Breaker) =>
    b.state === 'unused' ? 'Unused'
      : b.state === 'unknown' ? (b.description ? `${b.description} ????` : 'Unknown — not identified')
        : b.description || 'Unknown — not identified';

  /// The directory laid out as the panel is, for the door: odd slots down the left, even down the right.
  const drawPrint = (p: Panel, slots: number) => {
    printable.innerHTML = '';
    const when = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
    printable.appendChild(el('div', { class: 'ps-print-head' },
      el('h3', { text: p.name || p.id }),
      el('span', { class: 'ps-print-when', text: `${slots} slots · ${when}` })));
    const table = el('table', { class: 'ps-print-grid' });
    const head = el('tr');
    ['Circuit', 'Wire', 'A', '#', '#', 'A', 'Wire', 'Circuit'].forEach(h => head.appendChild(el('th', { text: h })));
    table.appendChild(el('thead', {}, head));
    const body = el('tbody');
    const holding = (slot: number) => p.breakers.filter(b => (b.poles === 2 ? [b.slot, b.slot + 2] : [b.slot]).includes(slot));
    const side = (slot: number, tr: any, mirrored: boolean) => {
      const on = holding(slot);
      const words = on.length
        ? on.map(b => b.slot === slot ? printWords(b) : `${b.number} — the other half of the breaker above`).join(' / ')
        : 'Empty';
      const cells = [
        el('td', { class: 'ps-print-desc' + (on.some(b => b.state === 'unknown') ? ' is-unknown' : on.length ? '' : ' is-empty'), text: words }),
        el('td', { class: 'ps-print-wire', text: on.map(b => b.wire).filter(Boolean).join(' / ') }),
        el('td', { class: 'ps-print-amps', text: on.map(b => b.amps ? String(b.amps) : '').filter(Boolean).join(' / ') }),
        el('td', { class: 'ps-print-slot', text: String(slot) }),
      ];
      (mirrored ? [...cells].reverse() : cells).forEach(c => tr.appendChild(c));
    };
    for (let slot = 1; slot <= slots; slot += 2) {
      const tr = el('tr');
      tr.dataset.slot = String(slot);
      side(slot, tr, false);
      if (slot + 1 <= slots) side(slot + 1, tr, true);
      body.appendChild(tr);
    }
    table.appendChild(body);
    printable.appendChild(table);
  };

  const render = () => {
    grid.innerHTML = '';
    const drawn = shown();
    const cfg = drawn ? configPanel(drawn.id) : null;
    settings.hidden = !drawn;
    if (!drawn) {
      grid.appendChild(el('div', { class: 'desc', text: 'No panels yet. Add one to start a directory, then fill in its slots.' }));
      return;
    }
    // The config is what is being edited, so the drawing follows it rather than the last answer from the API.
    const slots = Number(cfg?.Slots) || drawn.slots;
    const rows = Math.ceil(slots / 2);
    nameIn.value = cfg?.Name ?? drawn.name;
    whereBox.innerHTML = '';
    const whereSel = choiceSelect(locationChoices(), cfg?.Location || '', '— not placed —');
    whereSel.title = 'The room, area or floor this panel is mounted in.';
    whereSel.onchange = () => { if (cfg) { cfg.Location = whereSel.value || undefined; refreshDirty(); } };
    whereBox.appendChild(whereSel);
    slotsIn.value = String(slots);

    // Which node is this panel, and what feeds it.
    const panelNode = cfg?.Node ?? drawn.node ?? '';
    nodeSel.innerHTML = '';
    nodeSel.appendChild(el('option', { value: '', text: '— not mapped —' }));
    // A panel is a panel: only a node of that kind, and not one another panel in the directory already is.
    const claimed = new Set(panelsIn().filter((p: any) => p.Id !== drawn.id).map((p: any) => p.Node).filter(Boolean));
    const panelChoices = nodes.filter(n => n.kind === 'panel' && !claimed.has(n.id));
    // What is already recorded stays in the list, even where it is not a panel: opening the page must never
    // quietly re-point the panel at something else.
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
    // A panel is fed from one place. Once that is said, the way to change it is to drop it and pick again.
    feedAdd.hidden = !panelNode || fedBy.length > 0;
    feedAdd.disabled = !panelNode;

    // The mains figure: power, and the voltage beside it when whatever measures the panel reports one.
    const volts = drawn.volts == null ? '' : ` at ${drawn.volts.toFixed(1)} V`;
    incoming.textContent = !panelNode
      ? 'No node is mapped to this panel, so there is no incoming power to draw. Pick one above.'
      : drawn.incoming == null
        ? `Incoming: no data${volts ? `, though ${labelOf(panelNode)} reports${volts}` : ` — ${labelOf(panelNode)} has no current reading`}.`
        : `Incoming: ${Math.round(drawn.incoming).toLocaleString('en-US')} W${volts} through ${labelOf(panelNode)}.`;
    drawChecks(drawn);
    drawPrint(drawn, slots);
    // Every slot is one row tall, so a double-pole spanning two is twice the height of a single — with `auto`
    // the two rows it spans had nothing else in them and split its height between them instead.
    grid.style.gridTemplateRows = `repeat(${rows}, minmax(var(--ps-row), auto))`;

    [true, false].forEach(left => {
      column(slots, drawn.breakers, left).forEach(cell => {
        const place = `${rowOf(cell.slot)} / span ${cell.span}`;
        const box = el('div', {
          // The column decides which way the breaker faces: handles point at the bus bar down the middle.
          // A breaker holding two slots has the room of two, so it is read at the size it is drawn.
          class: 'ps-cell ' + (left ? 'is-left' : 'is-right') + (cell.span === 2 ? ' is-double' : '')
            + (cell.halves.length ? '' : ' is-empty'),
          style: { gridColumn: left ? '2' : '3', gridRow: place },
        });
        box.dataset.slot = String(cell.slot);
        const slotLabel = String(cell.slot) + (cell.span === 2 ? `+${cell.slot + 2}` : '');
        // Stamped down the outside edge of the frame, as a panel is: one number per slot, counted down.
        const stamped = el('div', {
          class: 'ps-nums',
          style: { gridColumn: left ? '1' : '4', gridRow: place },
        }, ...(cell.span === 2 ? [cell.slot, cell.slot + 2] : [cell.slot]).map(n => el('span', { text: String(n) })));
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
          cell.halves.forEach(b => {
            // The breaker as it looks in the panel, not a control: nothing here can switch one. A double-pole
            // is two handles with a tie between them, as it is on the wall.
            const poles = b.poles === 2 && cell.span === 2 ? 2 : 1;
            const handle = el('span', { class: 'ps-breaker is-' + b.state });
            for (let i = 0; i < poles; i++)
              handle.appendChild(el('span', { class: 'ps-pole is-' + b.state },
                el('span', { class: 'ps-throw', text: b.amps ? String(b.amps) : '' })));
            if (poles === 2) handle.appendChild(el('span', { class: 'ps-tie' }));
            handle.setAttribute('aria-hidden', 'true');
            const open = el('button', { class: 'ps-open' },
              handle,
              ...(saysMore(b.number, slotLabel) ? [el('span', { class: 'ps-num', text: b.number })] : []),
              el('span', { class: 'ps-desc', text: b.state === 'unused' ? 'Unused' : b.description || 'Not identified' }),
              // The directory's own mark for a circuit nobody has confirmed, description or not.
              ...(b.state === 'unknown' ? [el('span', { class: 'ps-mark', text: '????', title: 'Nobody has identified this circuit yet.' })] : []),
              el('span', { class: 'ps-meta', text: [b.wire, b.amps ? `${b.amps} A` : '', b.gauge].filter(Boolean).join(' · ') }));
            open.title = 'Edit this breaker — what it feeds, its wire, rating, and the node measuring it.';
            open.onclick = () => edit(drawn, b, cell.slot);
            // The reading is its own target: what a circuit is drawing now is also the way into what it has been drawing.
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
          // A breaker declared as one half of a tandem leaves the other half of its slot to fill in. Saying
          // a slot is shared is the editor's business; what is in the other half is the panel's.
          const lone = cell.halves.length === 1 ? cell.halves[0] : null;
          if (lone?.half) {
            const missing = lone.half === 1 ? 2 : 1;
            const vacant = el('span', { class: 'ps-breaker is-empty' }, el('span', { class: 'ps-pole is-empty' }));
            vacant.setAttribute('aria-hidden', 'true');
            const other = el('button', { class: 'ps-open is-empty' }, vacant,
              el('span', { class: 'ps-desc', text: missing === 1 ? 'empty upper half' : 'empty lower half' }));
            other.title = `Slot ${cell.slot} shares two breakers; this half is empty. Tap to fill it in.`;
            other.onclick = () => edit(drawn, null, cell.slot, missing);
            box.appendChild(other);
          }
        }
        grid.appendChild(box);
      });
    });
  };

  link.onclick = () => { activate(link, sec); load(); };
  // A schedule is read while someone is at the panel, so it keeps up with the channels behind it.
  setInterval(() => { if (sec.classList.contains('active')) load(); }, 10000);
  return { link, sec };
}
