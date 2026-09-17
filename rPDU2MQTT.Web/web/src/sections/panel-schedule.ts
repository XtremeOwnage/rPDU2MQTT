// The panel schedule (#453): a panel drawn as it is — two columns of slots, a breaker handle on each — with
// each breaker's number, wire, rating, what it feeds and the live power of the channel measuring it (#454).
// Slots, breakers, tandem halves and the node measuring each leg are all edited here.
import { activate, api, btn, closeSheet, el, ensure, navLink, openSheet, toast } from '../helpers.js';
import { state } from '../state.js';
import { refreshDirty } from '../dirty.js';
import { column, rowOf } from '../panel-layout.js';

/// A breaker as the API reports it, with its chain and power resolved.
type Leg = { leg: number; wire: string; clamp: string | null; channel: string | null; reversed: boolean };
type Breaker = {
  slot: number; number: string; poles: number; half: number | null; amps: number | null;
  wire: string; description: string; state: string; power: number | null; gap: string; legs: Leg[];
};
type Panel = { id: string; name: string; slots: number; rows: number; node: string; incoming: number | null; volts: number | null; breakers: Breaker[] };

/// Why a breaker's power is not shown. Never a zero: a gap in the chain is a gap.
const GAPS: Record<string, string> = {
  noclamp: 'Nothing is measuring this breaker yet — pick the node its circuit is on. A double-pole needs both legs, unless one CT measures the whole circuit.',
  nochannel: 'Its clamp is not plugged into a monitor channel yet.',
  noreading: 'Its channel has no current reading.',
};

/// The kinds of node a breaker's circuit can be. A panel or the grid carries the breaker, it is not the breaker.
const PANEL_CIRCUIT_KINDS = ['breaker', 'outlet', 'load', 'node'];

export function addPanelScheduleSection(nav: any, sections: any) {
  const link = navLink(nav, 'Panel Schedule', '🗂');
  link.dataset.section = 'EnergyFlow';
  const sec = el('div', { class: 'section' });
  sections.appendChild(sec);
  sec.appendChild(el('h2', { text: 'Panel Schedule' }));
  sec.appendChild(el('div', { class: 'desc' },
    'Each panel as its own directory: the slots laid out as they are in the panel, odd down the left and even '
    + 'down the right, with what each breaker feeds and the power of the node measuring it. A breaker with '
    + 'nothing mapped to it reads no data rather than zero. Tap a breaker to edit it, or an empty slot to fill it in.'));

  const panelSel = el('select', { title: 'Which panel to show.' }) as HTMLSelectElement;
  const refresh = btn('Refresh');
  const addPanel = btn('Add panel');
  const status = el('span', { class: 'ld-count' });
  sec.appendChild(el('div', { class: 'ld-toolbar', style: { flexWrap: 'wrap', gap: '8px' } },
    el('label', { class: 'ld-inst' }, 'Panel ', panelSel), refresh, addPanel, status));

  // The panel's own settings: what it is called, and how many slots it has.
  const nameIn = el('input', { type: 'text', placeholder: 'Main Panel' }) as HTMLInputElement;
  const slotsIn = el('input', { type: 'number', min: '2', max: '200', step: '2', class: 'ps-slots' }) as HTMLInputElement;
  slotsIn.title = 'How many breaker positions the panel has, counting both columns. A 42-space panel has 42.';
  // The node that is this panel: its reading is the power coming in, and its breakers' circuits hang beneath it.
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
  sec.appendChild(settings);
  const incoming = el('div', { class: 'desc ps-incoming' });
  sec.appendChild(incoming);

  const grid = el('div', { class: 'ps-grid' });
  // The enclosure: the two columns of breakers either side of the bus bar down the middle.
  sec.appendChild(el('div', { class: 'ps-panel' }, el('div', { class: 'ps-bus' }), grid));

  let panels: Panel[] = [];
  let nodes: { id: string; label: string; kind: string }[] = [];

  const flowIn = () => ensure(state.data, 'EnergyFlow', {});
  const panelsIn = (): any[] => ensure(flowIn(), 'Panels', []);
  const clampsIn = (): any[] => ensure(flowIn(), 'Clamps', []);
  const linksIn = (): any[] => ensure(flowIn(), 'Links', []);
  const shown = () => panels.find(p => p.id === panelSel.value) || panels[0];
  const labelOf = (id: string) => nodes.find(n => n.id === id)?.label || id;
  /// What feeds a node today, according to the flow links.
  const parentsOf = (node: string) => linksIn().filter((l: any) => l.To === node).map((l: any) => String(l.From));
  /// A breaker's circuit hangs beneath the panel: whatever fed it before is replaced, never left beside it.
  const reparent = (node: string, parent: string) => {
    const links = linksIn();
    for (let i = links.length - 1; i >= 0; i--) if (links[i].To === node) links.splice(i, 1);
    links.push({ From: parent, To: node });
  };
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
    const drawPickers = () => {
      pickerRows.innerHTML = '';
      pickers.length = 0;
      const doublePole = Number(poles.value) === 2;
      if (doublePole)
        pickerRows.appendChild(el('div', { class: 'ps-field' },
          el('label', { class: 'ld-inst' }, wholeBox, ' One CT measures the whole circuit, not one leg')));
      const legs = doublePole && !wholeBox.checked ? [1, 2] : [1];
      legs.forEach(leg => {
        const sel = el('select', { class: 'ps-node' }) as HTMLSelectElement;
        sel.appendChild(el('option', { value: '', text: '— nothing measuring it —' }));
        nodes.filter(n => PANEL_CIRCUIT_KINDS.includes(n.kind)).forEach(n => {
          const taken = takenBy(n.id, panel.id, wasNumber || number.value, leg);
          sel.appendChild(el('option', { value: n.id, text: `${n.label} (${n.id})${taken ? ` — already on ${taken}` : ''}` }));
        });
        sel.value = clampFor(panel.id, wasNumber, leg)?.Channel || '';
        pickers.push(sel);
        pickerRows.appendChild(field(legs.length > 1 ? `Measured by (leg ${leg})` : 'Measured by', sel,
          legs.length > 1 ? 'Both legs need a node before this breaker reports its power.' : ''));
      });
    };
    poles.onchange = () => drawPickers();
    wholeBox.onchange = () => drawPickers();
    drawPickers();

    const save = btn('Apply', 'primary');
    save.onclick = () => {
      const panelNode = configPanel(panel.id)?.Node || '';
      const picked = pickers.map(s => s.value).filter(Boolean);
      // A circuit belongs beneath the panel feeding it. One that hangs somewhere else today is not moved
      // quietly: what it is fed by now, and what that becomes, is said before anything is written.
      const moving = panelNode
        ? picked.map(ch => ({ ch, from: parentsOf(ch).filter(f => f !== panelNode) })).filter(x => x.from.length)
        : [];
      if (moving.length) {
        const where = nameIn.value.trim() || panel.name || panel.id;
        const lines = moving.map(m => `• ${labelOf(m.ch)} is fed by ${m.from.map(labelOf).join(', ')}`);
        const ok = confirm(`${lines.join('\n')}\n\nMapping ${moving.length > 1 ? 'them' : 'it'} to breaker `
          + `${number.value.trim() || slot} places ${moving.length > 1 ? 'them' : 'it'} beneath ${where} instead, `
          + `and the old feeder link${moving.reduce((n, m) => n + m.from.length, 0) > 1 ? 's are' : ' is'} removed.`
          + `\n\nOK to move, Cancel to leave it as it is.`);
        if (!ok) return;
      }
      const target = entry || { Slot: slot };
      const newNumber = number.value.trim() || String(slot);
      target.Slot = slot;
      target.Number = newNumber;
      target.Description = description.value.trim();
      target.Wire = wire.value.trim();
      target.Amps = amps.value ? Number(amps.value) : null;
      target.Poles = Number(poles.value) || 1;
      target.Half = half.value ? Number(half.value) : null;
      target.State = stateSel.value;
      if (!entry) {
        const p = configPanel(panel.id);
        if (p) ensure(p, 'Breakers', []).push(target);
      }
      // A renamed breaker keeps the clamps that were recorded against its old number.
      if (wasNumber && wasNumber !== newNumber)
        clampsIn().filter((c: any) => c.Panel === panel.id && c.Breaker === wasNumber).forEach((c: any) => { c.Breaker = newNumber; });
      const whole = target.Poles === 2 && wholeBox.checked;
      pickers.forEach((sel, i) => mapLeg(panel.id, newNumber, i + 1, sel.value, target.Wire, whole && i === 0));
      // One CT for the whole circuit leaves no second leg to record.
      if (whole || target.Poles === 1) mapLeg(panel.id, newNumber, 2, '', '');
      // The panel is now what feeds these circuits, in the flow graph as well as on paper.
      if (panelNode) picked.forEach(ch => reparent(ch, panelNode));
      refreshDirty();
      closeSheet();
      toast('Breaker updated. Press Save to keep it.', true);
      load();
    };
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
        field('Wire label', wire), field('Rating (A)', amps), field('Poles', poles),
        field('Tandem', half, 'A tandem breaker is two half-height breakers sharing one slot.'),
        field('State', stateSel), pickerRows),
      footer: [save, remove],
    });
  };

  /// Put a second breaker in a slot that already has one: both become halves of a tandem.
  const addTandem = (panel: Panel, first: Breaker, slot: number) => {
    const entry = configBreaker(panel.id, first);
    if (entry && !entry.Half) entry.Half = 1;
    refreshDirty();
    edit(panel, null, slot, 2);
  };

  const powerText = (b: Breaker) => b.power == null ? 'no data' : `${Math.round(b.power).toLocaleString('en-US')} W`;

  /// Whether a breaker's number says anything the slot stamp has not already said: "1,3" in slots 1+3 has not,
  /// but "B06" and a tandem's "26.1" have.
  const saysMore = (number: string, slotLabel: string) => {
    const digits = (s: string) => (s.match(/\d+/g) || []).join(',');
    return !!number && digits(number) !== digits(slotLabel);
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
    slotsIn.value = String(slots);

    // Which node is this panel, and what feeds it.
    const panelNode = cfg?.Node ?? drawn.node ?? '';
    nodeSel.innerHTML = '';
    nodeSel.appendChild(el('option', { value: '', text: '— not mapped —' }));
    nodes.forEach(n => nodeSel.appendChild(el('option', { value: n.id, text: `${n.label} (${n.id})` })));
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
    grid.style.gridTemplateRows = `repeat(${rows}, auto)`;

    [true, false].forEach(left => {
      column(slots, drawn.breakers, left).forEach(cell => {
        const place = `${rowOf(cell.slot)} / span ${cell.span}`;
        const box = el('div', {
          // The column decides which way the breaker faces: handles point at the bus bar down the middle.
          class: 'ps-cell ' + (left ? 'is-left' : 'is-right') + (cell.halves.length ? '' : ' is-empty'),
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
          const blank = el('span', { class: 'ps-handle is-empty' });
          blank.setAttribute('aria-hidden', 'true');
          const add = el('button', { class: 'ps-half is-empty' }, blank, el('span', { class: 'ps-desc', text: 'empty' }));
          add.title = `Slot ${cell.slot} — nothing recorded. Tap to add a breaker.`;
          add.onclick = () => edit(drawn, null, cell.slot);
          box.appendChild(add);
        } else {
          cell.halves.forEach(b => {
            // The handle is the breaker as it looks in the panel, not a control: nothing here can switch one.
            const handle = el('span', { class: 'ps-handle is-' + b.state });
            handle.setAttribute('aria-hidden', 'true');
            const half = el('button', { class: 'ps-half is-' + b.state },
              handle,
              ...(saysMore(b.number, slotLabel) ? [el('span', { class: 'ps-num', text: b.number })] : []),
              el('span', { class: 'ps-desc', text: b.state === 'unused' ? 'Unused' : b.description || 'Not identified' }),
              // The directory's own mark for a circuit nobody has confirmed, description or not.
              ...(b.state === 'unknown' ? [el('span', { class: 'ps-mark', text: '????', title: 'Nobody has identified this circuit yet.' })] : []),
              el('span', { class: 'ps-meta', text: [b.wire, b.amps ? `${b.amps} A` : ''].filter(Boolean).join(' · ') }),
              el('span', { class: 'ps-power' + (b.power == null ? ' is-nodata' : ''), text: powerText(b) }));
            half.title = b.power == null ? (GAPS[b.gap] || 'No reading for this breaker.') : `Measured by ${b.legs.map(l => l.channel).filter(Boolean).join(' + ')}`;
            half.onclick = () => edit(drawn, b, cell.slot);
            box.appendChild(half);
          });
          // A slot holding one full-height breaker can take a second as a tandem.
          if (cell.halves.length === 1 && cell.span === 1) {
            const tandem = el('button', { class: 'ps-tandem', text: '+ tandem' });
            tandem.title = 'Add a second breaker sharing this slot, as a tandem.';
            tandem.onclick = () => addTandem(drawn, cell.halves[0], cell.slot);
            box.appendChild(tandem);
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
