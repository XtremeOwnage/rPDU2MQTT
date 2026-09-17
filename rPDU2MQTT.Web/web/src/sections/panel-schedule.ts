// The panel schedule (#453): a panel drawn as it is — two columns of slots — with each breaker's number,
// wire, rating, what it feeds and the live power of the channel measuring it (#454). Editable in place.
import { activate, api, btn, closeSheet, el, navLink, openSheet, toast } from '../helpers.js';
import { state } from '../state.js';
import { refreshDirty } from '../dirty.js';
import { ensure } from '../helpers.js';
import { column, isLeft, rowOf } from '../panel-layout.js';

/// A breaker as the API reports it, with its chain and power resolved.
type Breaker = {
  slot: number; number: string; poles: number; half: number | null; amps: number | null;
  wire: string; description: string; state: string; power: number | null; gap: string;
  legs: { leg: number; wire: string; clamp: string | null; channel: string | null; reversed: boolean }[];
};
type Panel = { id: string; name: string; slots: number; rows: number; breakers: Breaker[] };

/// Why a breaker's power is not shown. Never a zero: a gap in the chain is a gap.
const GAPS: Record<string, string> = {
  noclamp: 'No CT clamp on this breaker’s wire yet.',
  nochannel: 'Its clamp is not plugged into a monitor channel yet.',
  noreading: 'Its channel has no current reading.',
};

export function addPanelScheduleSection(nav: any, sections: any) {
  const link = navLink(nav, 'Panel Schedule', '🗂');
  link.dataset.section = 'EnergyFlow';
  const sec = el('div', { class: 'section' });
  sections.appendChild(sec);
  sec.appendChild(el('h2', { text: 'Panel Schedule' }));
  sec.appendChild(el('div', { class: 'desc' },
    'Each panel as its own directory: the slots laid out as they are in the panel, odd down the left and even '
    + 'down the right, with what each breaker feeds and the power of the channel measuring it. A breaker with '
    + 'no channel mapped to it reads no data rather than zero. Tap a slot to edit it.'));

  const panelSel = el('select', { title: 'Which panel to show.' }) as HTMLSelectElement;
  const refresh = btn('Refresh');
  const addPanel = btn('Add panel');
  const status = el('span', { class: 'ld-count' });
  sec.appendChild(el('div', { class: 'ld-toolbar', style: { flexWrap: 'wrap', gap: '8px' } },
    el('label', { class: 'ld-inst' }, 'Panel ', panelSel), refresh, addPanel, status));
  const grid = el('div', { class: 'ps-grid' });
  sec.appendChild(grid);

  let panels: Panel[] = [];

  const panelsIn = (): any[] => ensure(ensure(state.data, 'EnergyFlow', {}), 'Panels', []);
  const shown = () => panels.find(p => p.id === panelSel.value) || panels[0];

  const load = async () => {
    status.textContent = 'loading…';
    let r: any;
    try { r = await api('/api/panels'); }
    catch (e: any) { r = { body: { ok: false, message: e?.message || 'the request failed' } }; }
    if (!r.body?.ok) { status.textContent = r.body?.message || 'Could not read the panels.'; panels = []; render(); return; }
    panels = r.body.panels || [];
    const keep = panelSel.value;
    panelSel.innerHTML = '';
    panels.forEach(p => panelSel.appendChild(el('option', { value: p.id, text: p.name || p.id })));
    if (panels.some(p => p.id === keep)) panelSel.value = keep;
    status.textContent = '';
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

  /// The breaker in the config this drawn one came from, so an edit lands on the real entry.
  const configBreaker = (panel: Panel, b: Breaker) => {
    const p = panelsIn().find((x: any) => x.Id === panel.id);
    if (!p) return null;
    const list = ensure(p, 'Breakers', []);
    return list.find((x: any) => x.Slot === b.slot && (x.Number || '') === b.number) || null;
  };

  const edit = (panel: Panel, b: Breaker | null, slot: number) => {
    const entry = b ? configBreaker(panel, b) : null;
    const field = (label: string, input: any, hint?: string) =>
      el('div', { class: 'ps-field' }, el('label', { class: 'ps-label', text: label }), input,
        hint ? el('div', { class: 'desc', style: { margin: '2px 0 0' }, text: hint }) : '');
    const text = (value: string, placeholder = '') => {
      const i = el('input', { type: 'text', placeholder }) as HTMLInputElement;
      i.value = value;
      return i;
    };
    const num = (value: number | null) => {
      const i = el('input', { type: 'number', min: '1' }) as HTMLInputElement;
      i.value = value == null ? '' : String(value);
      return i;
    };
    const number = text(b?.number || String(slot), 'as written, e.g. B06 or 26.1');
    const description = text(b?.description || '', 'what it feeds');
    const wire = text(b?.wire || '', 'e.g. W11');
    const amps = num(b?.amps ?? null);
    const poles = el('select', {}) as HTMLSelectElement;
    [['1', 'single pole'], ['2', 'double pole (spans the next slot down)']].forEach(([v, t]) => poles.appendChild(el('option', { value: v, text: t })));
    poles.value = String(b?.poles || 1);
    const half = el('select', {}) as HTMLSelectElement;
    [['', 'the whole slot'], ['1', 'tandem, upper half'], ['2', 'tandem, lower half']].forEach(([v, t]) => half.appendChild(el('option', { value: v, text: t })));
    half.value = b?.half ? String(b.half) : '';
    const stateSel = el('select', {}) as HTMLSelectElement;
    [['identified', 'Identified'], ['unknown', 'Not identified yet'], ['unused', 'Unused slot']]
      .forEach(([v, t]) => stateSel.appendChild(el('option', { value: v, text: t })));
    stateSel.value = b?.state || 'unknown';

    const save = btn('Apply', 'primary');
    save.onclick = () => {
      const target = entry || { Slot: slot };
      target.Slot = slot;
      target.Number = number.value.trim() || String(slot);
      target.Description = description.value.trim();
      target.Wire = wire.value.trim();
      target.Amps = amps.value ? Number(amps.value) : null;
      target.Poles = Number(poles.value) || 1;
      target.Half = half.value ? Number(half.value) : null;
      target.State = stateSel.value;
      if (!entry) {
        const p = panelsIn().find((x: any) => x.Id === panel.id);
        if (p) ensure(p, 'Breakers', []).push(target);
      }
      refreshDirty();
      closeSheet();
      toast('Breaker updated. Press Save to keep it.', true);
      load();
    };
    const remove = btn('Remove', 'danger');
    remove.hidden = !entry;
    remove.onclick = () => {
      const p = panelsIn().find((x: any) => x.Id === panel.id);
      const list = p ? ensure(p, 'Breakers', []) : [];
      const at = list.indexOf(entry);
      if (at >= 0) list.splice(at, 1);
      refreshDirty();
      closeSheet();
      toast('Breaker removed. Press Save to keep it.', true);
      load();
    };

    const chain = b?.legs?.length
      ? el('div', { class: 'desc' }, 'Measured by: ' + b.legs.map(l =>
        `leg ${l.leg} — ${l.wire || 'no wire'} → ${l.clamp || 'no clamp'} → ${l.channel || 'no channel'}${l.reversed ? ' (reversed)' : ''}`).join('; '))
      : el('div', { class: 'desc', text: 'Nothing is measuring this breaker yet. CT clamps are mapped under Energy Flow → Clamps.' });

    openSheet({
      title: `Slot ${slot}${b ? ` — ${b.number}` : ''}`,
      body: el('div', {}, field('Breaker number', number), field('What it feeds', description),
        field('Wire label', wire), field('Rating (A)', amps), field('Poles', poles),
        field('Tandem', half, 'A tandem breaker is two half-height breakers sharing one slot.'),
        field('State', stateSel), chain),
      footer: [save, remove],
    });
  };

  const powerText = (b: Breaker) => b.power == null ? 'no data' : `${Math.round(b.power).toLocaleString('en-US')} W`;

  const render = () => {
    grid.innerHTML = '';
    const panel = shown();
    if (!panel) {
      grid.appendChild(el('div', { class: 'desc', text: 'No panels yet. Add one to start a directory, then fill in its slots.' }));
      return;
    }
    grid.style.gridTemplateRows = `repeat(${panel.rows}, auto)`;
    [true, false].forEach(left => {
      column(panel.slots, panel.breakers, left).forEach(cell => {
        const first = cell.halves[0];
        const box = el('button', {
          class: 'ps-cell' + (cell.halves.length ? '' : ' is-empty')
            + (first && first.state === 'unknown' ? ' is-unknown' : '')
            + (first && first.state === 'unused' ? ' is-unused' : ''),
          style: { gridColumn: left ? '1' : '2', gridRow: `${rowOf(cell.slot)} / span ${cell.span}` },
        });
        box.appendChild(el('span', { class: 'ps-slot', text: String(cell.slot) + (cell.span === 2 ? `+${cell.slot + 2}` : '') }));
        if (!cell.halves.length) {
          box.appendChild(el('span', { class: 'ps-desc', text: 'empty' }));
          box.title = `Slot ${cell.slot} — nothing recorded. Tap to add a breaker.`;
          box.onclick = () => edit(panel, null, cell.slot);
        } else {
          cell.halves.forEach(b => {
            const half = el('span', { class: 'ps-half' },
              el('span', { class: 'ps-num', text: b.number }),
              el('span', { class: 'ps-desc', text: b.state === 'unused' ? 'Unused' : b.description || 'Not identified' }),
              // The directory's own mark for a circuit nobody has confirmed, description or not.
              ...(b.state === 'unknown' ? [el('span', { class: 'ps-mark', text: '????', title: 'Nobody has identified this circuit yet.' })] : []),
              el('span', { class: 'ps-meta', text: [b.wire, b.amps ? `${b.amps} A` : ''].filter(Boolean).join(' · ') }),
              el('span', { class: 'ps-power' + (b.power == null ? ' is-nodata' : ''), text: powerText(b) }));
            half.title = b.power == null ? (GAPS[b.gap] || 'No reading for this breaker.') : '';
            box.appendChild(half);
          });
          box.onclick = () => edit(panel, cell.halves[0], cell.slot);
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
