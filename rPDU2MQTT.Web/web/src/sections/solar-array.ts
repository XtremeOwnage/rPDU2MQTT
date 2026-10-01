// Solar Array: the panels as they are wired — optimizers into strings, strings into MPPTs — and what each
// panel is doing now. Fed by the Tigo TAP plugin (plugins/rPDU2MQTT.Plugin.Tigo), which reads the optimizers
// off the TAP's RS485 bus.
//
// Everything here is ordinary flow configuration. A panel is a node bound to its optimizer
// ({ Type: 'tigo', Settings: { Optimizer: <serial> } }) for power, voltage, current and temperature; a string
// is a node tagged 'pv-string' that the panels feed; the string feeds an MPPT node that already exists. So
// the panels roll up, chart, accumulate energy and export like any other node — this page only arranges them.
import { activate, api, btn, el, ensure, navLink, toast } from '../helpers.js';
import { state } from '../state.js';
import { refreshDirty } from '../dirty.js';
import { saveConfig } from '../config-form.js';
import { openHistorySheet } from '../history-sheet.js';
import { busyInSection } from '../realtime.js';

/// The tag that makes a node a string, so one with no panels yet is still one.
export const STRING_TAG = 'pv-string';

/// What a tile shows, and the metric a click charts.
const SA_SHOWS: [string, string, string][] = [
  ['power', 'Power', 'realpower'],
  ['vin', 'Volts', 'voltage'],
  ['iin', 'Amps', 'current'],
  ['temp', 'Temp', 'temperature'],
];

const saFlow = () => ensure(state.data, 'EnergyFlow', {});
const saNodes = (): any[] => ensure(saFlow(), 'Nodes', []);
const saLinks = (): any[] => ensure(saFlow(), 'Links', []);
const saSame = (a?: string, b?: string) => (a || '').toLowerCase() === (b || '').toLowerCase();

/// The optimizer a node is bound to, or null when it is not a panel.
export const serialOf = (n: any): string | null =>
  (n?.Sources || []).find((s: any) => saSame(s.Type, 'tigo') && s.Settings?.Optimizer)?.Settings.Optimizer || null;

const saNode = (id: string) => saNodes().find(n => saSame(n.Id, id));
const saIsPanel = (id: string) => !!serialOf(saNode(id));

/// Every string: tagged as one, or fed by a panel.
export function stringsOf(): any[] {
  const fedByPanel = new Set(saLinks().filter(l => saIsPanel(l.From)).map(l => (l.To || '').toLowerCase()));
  return saNodes().filter(n => (n.Tags || []).includes(STRING_TAG) || fedByPanel.has((n.Id || '').toLowerCase()));
}
/// A string's panels, in the order they are wired.
export const panelsOf = (stringId: string): string[] => saLinks().filter(l => saSame(l.To, stringId) && saIsPanel(l.From)).map(l => l.From);
const saMpptOf = (stringId: string): string => saLinks().find(l => saSame(l.From, stringId))?.To || '';

const saSlug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'string';

/// Put a panel at a place in a string (before another panel, or at the end), taking it out of any other.
export function placePanel(panelId: string, stringId: string, before: string | null) {
  const links = saLinks();
  for (let i = links.length - 1; i >= 0; i--) if (saSame(links[i].From, panelId) && !saIsPanel(links[i].To)) links.splice(i, 1);
  const link = { From: panelId, To: stringId };
  const at = before ? links.findIndex(l => saSame(l.From, before) && saSame(l.To, stringId)) : -1;
  if (at >= 0) links.splice(at, 0, link);
  else {
    // After the string's last panel, so the order reads as wired.
    let last = -1;
    links.forEach((l, i) => { if (saSame(l.To, stringId) && saIsPanel(l.From)) last = i; });
    links.splice(last >= 0 ? last + 1 : links.length, 0, link);
  }
}

/// A new panel node for an optimizer: power, voltage, current and temperature, all from the saSame optimizer.
export function adoptOptimizer(serial: string, stringId: string, label: string) {
  const id = 'tigo_' + serial.toLowerCase();
  if (!saNode(id)) {
    const bind = (Metric: string) => ({ Type: 'tigo', Metric, Settings: { Optimizer: serial } });
    saNodes().push({ Id: id, Label: label, Kind: 'solar', Sources: ['realpower', 'voltage', 'current', 'temperature'].map(bind) });
  }
  placePanel(id, stringId, null);
  return id;
}

/// The next label in a string: its name's first letter and the next number — A1, A2…
function saNextLabel(stringNode: any) {
  const letter = ((stringNode?.Label || stringNode?.Id || 'S').match(/[A-Za-z0-9]/)?.[0] || 'S').toUpperCase();
  return `${letter}${panelsOf(stringNode.Id).length + 1}`;
}

export function addSolarArraySection(nav: any, sections: any) {
  const link = navLink(nav, 'Solar Array', '☀');
  link.dataset.section = 'EnergyFlow';
  const sec = el('div', { class: 'section' });
  sections.appendChild(sec);

  const head = el('div', { class: 'sa-head' }, el('h2', { text: 'Solar Array' }));
  const showSel = el('div', { class: 'sa-show', role: 'group' });
  let show = 'power';
  try { show = localStorage.getItem('rpdu-solar-show') || 'power'; } catch { /* default */ }
  const editBtn = btn('Arrange');
  const save = btn('Save', 'primary');
  head.append(showSel, editBtn, save);
  sec.appendChild(head);
  const buses = el('div', { class: 'sa-buses' });
  const array = el('div', { class: 'sa-array' });
  const loose = el('div', { class: 'sa-loose' });
  sec.append(buses, array, loose);

  let snap: any = null;
  let failed: string | null = null;
  let editing = false;
  let dragged: string | null = null;

  SA_SHOWS.forEach(([key, label]) => {
    const b = el('button', { type: 'button', class: 'sa-show-btn', text: label }) as HTMLButtonElement;
    b.dataset.show = key;
    b.onclick = () => { show = key; try { localStorage.setItem('rpdu-solar-show', key); } catch { /* this view */ } render(); };
    showSel.appendChild(b);
  });
  editBtn.onclick = () => { editing = !editing; render(); };
  save.onclick = () => saveConfig(() => render());

  const live = (serial: string | null) => (snap?.optimizers || []).find((o: any) => saSame(o.serial, serial || ''));
  const fmt = (o: any, key: string) => o == null ? '—'
    : key === 'power' ? `${Math.round(o.power)} W` : key === 'vin' ? `${o.vin.toFixed(1)} V`
    : key === 'iin' ? `${o.iin.toFixed(2)} A` : `${Math.round(o.temp)} °C`;
  const stale = (o: any) => !o || o.ageSeconds > (snap?.staleSeconds ?? 180);
  const changed = () => { refreshDirty(); render(); };

  const tile = (panelId: string, stringId: string, scale: { max: number; median: number }) => {
    const node = saNode(panelId);
    const serial = serialOf(node);
    const o = live(serial);
    const quiet = stale(o);
    const t = el('div', { class: 'sa-panel' + (quiet ? ' is-quiet' : '') });
    t.dataset.node = panelId;
    // Brighter is more: the share of the best panel's output, so a shaded or failing one stands out.
    const value = o && !quiet ? (show === 'power' ? o.power : show === 'vin' ? o.vin : show === 'iin' ? o.iin : o.temp) : 0;
    const frac = scale.max > 0 ? Math.max(0, Math.min(1, value / scale.max)) : 0;
    t.style.setProperty?.('--sa-fill', String(frac));
    // Well under its string's typical output, in daylight: the one to look at.
    if (!quiet && show === 'power' && scale.median > 20 && o.power < 0.75 * scale.median) t.classList.add('is-low');
    t.append(
      el('div', { class: 'sa-panel-label', text: node?.Label || panelId }),
      el('div', { class: 'sa-panel-value', text: quiet ? (o ? 'quiet' : 'no report') : fmt(o, show) }),
      el('div', { class: 'sa-panel-sub', text: !o || quiet ? (serial || '') : `${o.vin.toFixed(1)} V · ${o.iin.toFixed(2)} A · ${Math.round(o.temp)} °C` }));
    t.title = `${node?.Label || panelId} · optimizer ${serial}` + (o ? ` · reported ${Math.round(o.ageSeconds)} s ago` : ' · not heard on the bus');

    if (editing) {
      t.draggable = true;
      t.classList.add('is-editing');
      t.addEventListener('dragstart', (e: any) => { dragged = panelId; e.dataTransfer?.setData('text/plain', panelId); });
      t.addEventListener('dragover', (e: any) => e.preventDefault());
      t.addEventListener('drop', (e: any) => { e.preventDefault(); e.stopPropagation?.(); if (dragged && dragged !== panelId) { placePanel(dragged, stringId, panelId); dragged = null; changed(); } });
      // The saSame moves without a mouse: a phone cannot drag.
      const order = panelsOf(stringId);
      const at = order.findIndex(id => saSame(id, panelId));
      const move = (to: number) => { const before = order.filter(id => !saSame(id, panelId))[to] ?? null; placePanel(panelId, stringId, before); changed(); };
      const left = btn('‹'); left.title = 'Move left'; left.disabled = at <= 0; left.onclick = (e: any) => { e.stopPropagation?.(); move(at - 1); };
      const right = btn('›'); right.title = 'Move right'; right.disabled = at >= order.length - 1; right.onclick = (e: any) => { e.stopPropagation?.(); move(at + 1); };
      const name = el('input', { type: 'text', value: node?.Label || '', class: 'sa-panel-name', title: 'Panel label' }) as HTMLInputElement;
      name.onclick = (e: any) => e.stopPropagation?.();
      name.onchange = () => { node.Label = name.value.trim() || undefined; changed(); };
      const to = el('select', { class: 'sa-panel-move', title: 'Move to another string, or take it out' }) as HTMLSelectElement;
      to.appendChild(el('option', { value: '', text: 'Move to…' }));
      stringsOf().filter(s => !saSame(s.Id, stringId)).forEach(s => to.appendChild(el('option', { value: s.Id, text: s.Label || s.Id })));
      to.appendChild(el('option', { value: '__remove', text: 'Take out of the array' }));
      to.onclick = (e: any) => e.stopPropagation?.();
      to.onchange = () => {
        if (to.value === '__remove') {
          if (!confirm(`Take ${node?.Label || panelId} out of the array? Its node and its bindings are removed; the optimizer is offered again below.`)) { to.value = ''; return; }
          const links = saLinks();
          for (let i = links.length - 1; i >= 0; i--) if (saSame(links[i].From, panelId) || saSame(links[i].To, panelId)) links.splice(i, 1);
          const nodes = saNodes();
          nodes.splice(nodes.findIndex(n => saSame(n.Id, panelId)), 1);
        } else if (to.value) placePanel(panelId, to.value, null);
        changed();
      };
      t.append(name, el('div', { class: 'sa-panel-edit' }, left, to, right));
    } else {
      t.classList.add('is-link');
      t.onclick = () => openHistorySheet({
        title: node?.Label || panelId, nodes: [panelId], lineLabel: node?.Label || panelId,
        metric: (SA_SHOWS.find(s => s[0] === show) || SA_SHOWS[0])[2], editNode: true,
      });
    }
    return t;
  };

  const render = () => {
    showSel.querySelectorAll?.('.sa-show-btn').forEach((b: any) => b.classList.toggle('is-on', b.dataset.show === show));
    editBtn.textContent = editing ? 'Done arranging' : 'Arrange';
    editBtn.classList.toggle('primary', editing);

    // The buses: whether the bridge can hear the optimizers at all.
    buses.innerHTML = '';
    if (failed) buses.appendChild(el('div', { class: 'sa-note is-bad', text: failed }));
    (snap?.connections || []).forEach((c: any) => {
      const state = c.standby ? 'standby — another process reads it' : !c.connected ? `not connected${c.error ? ': ' + c.error : ''}`
        : c.otherController ? 'another controller is polling — Poll mode is not transmitting'
        : c.lastAnswerSeconds == null ? (c.mode === 'listen' ? 'connected, no TAP answers yet — is the CCA polling?' : 'connected, the TAP has not answered')
        : `${c.mode === 'listen' ? 'listening' : 'polling'} · TAP ${c.gatewayId} answered ${c.lastAnswerSeconds} s ago`;
      buses.appendChild(el('div', { class: 'sa-bus' + (c.connected && c.lastAnswerSeconds != null && c.lastAnswerSeconds < 60 ? ' is-good' : ' is-warn') },
        el('strong', { text: c.name || c.id }), el('span', { text: state })));
    });

    // The array: one row of panels per string, in wired order.
    array.innerHTML = '';
    const strings = stringsOf();
    const all = (snap?.optimizers || []).filter((o: any) => !stale(o));
    const valueOf = (o: any) => show === 'power' ? o.power : show === 'vin' ? o.vin : show === 'iin' ? o.iin : o.temp;
    const max = all.reduce((m: number, o: any) => Math.max(m, valueOf(o)), 0);
    strings.forEach(s => {
      const panels = panelsOf(s.Id);
      const readings = panels.map(id => live(serialOf(saNode(id)))).filter((o: any) => o && !stale(o));
      const watts = readings.reduce((sum: number, o: any) => sum + o.power, 0);
      const sorted = readings.map((o: any) => o.power).sort((a: number, b: number) => a - b);
      const median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
      // A series string: the optimizers' output voltages add up, and the current is shared.
      const volts = readings.reduce((sum: number, o: any) => sum + (o.vout || 0), 0);

      const card = el('div', { class: 'sa-string' });
      card.dataset.node = s.Id;
      const mppt = saMpptOf(s.Id);
      const headRow = el('div', { class: 'sa-string-head' });
      if (editing) {
        const name = el('input', { type: 'text', value: s.Label || s.Id, class: 'sa-string-name', title: 'String name' }) as HTMLInputElement;
        name.onchange = () => { s.Label = name.value.trim() || undefined; changed(); };
        const to = el('select', { class: 'sa-mppt', title: 'The MPPT this string feeds' }) as HTMLSelectElement;
        to.appendChild(el('option', { value: '', text: '— not wired to an MPPT —' }));
        saNodes().filter(n => !serialOf(n) && !stringsOf().some(x => saSame(x.Id, n.Id)))
          .forEach(n => to.appendChild(el('option', { value: n.Id, text: n.Label || n.Id })));
        to.value = saNodes().find(n => saSame(n.Id, mppt))?.Id || '';
        to.onchange = () => {
          const links = saLinks();
          for (let i = links.length - 1; i >= 0; i--) if (saSame(links[i].From, s.Id)) links.splice(i, 1);
          if (to.value) links.push({ From: s.Id, To: to.value });
          changed();
        };
        headRow.append(name, el('span', { class: 'sa-arrow', text: '→' }), to);
        if (!panels.length) {
          const drop = btn('Delete string', 'danger');
          drop.onclick = () => {
            const links = saLinks();
            for (let i = links.length - 1; i >= 0; i--) if (saSame(links[i].From, s.Id) || saSame(links[i].To, s.Id)) links.splice(i, 1);
            saNodes().splice(saNodes().findIndex(n => saSame(n.Id, s.Id)), 1);
            changed();
          };
          headRow.appendChild(drop);
        }
      } else {
        headRow.append(el('strong', { class: 'sa-string-title', text: s.Label || s.Id }),
          el('span', { class: 'sa-arrow', text: mppt ? `→ ${saNode(mppt)?.Label || mppt}` : '→ not wired' }));
      }
      headRow.appendChild(el('span', { class: 'sa-string-total', text: readings.length
        ? `${(watts / 1000).toFixed(2)} kW · ${Math.round(volts)} V · ${readings.length}/${panels.length} reporting` : `${panels.length} panel${panels.length === 1 ? '' : 's'}` }));
      card.appendChild(headRow);

      const row = el('div', { class: 'sa-panels' });
      panels.forEach(id => row.appendChild(tile(id, s.Id, { max, median })));
      if (!panels.length) row.appendChild(el('div', { class: 'sa-empty', text: editing ? 'Drop panels here, or add optimizers from the list below.' : 'No panels yet.' }));
      if (editing) {
        row.addEventListener('dragover', (e: any) => e.preventDefault());
        row.addEventListener('drop', (e: any) => { e.preventDefault(); if (dragged) { placePanel(dragged, s.Id, null); dragged = null; changed(); } });
      }
      card.appendChild(row);
      array.appendChild(card);
    });

    const addString = btn('+ New string');
    addString.onclick = () => {
      const name = (prompt('Name the string (e.g. "A" or "South roof")') || '').trim();
      if (!name) return;
      let id = 'pv_' + saSlug(name);
      for (let n = 2; saNode(id); n++) id = `pv_${saSlug(name)}_${n}`;
      saNodes().push({ Id: id, Label: name, Kind: 'solar', Tags: [STRING_TAG] });
      editing = true;
      changed();
    };
    if (!strings.length) array.appendChild(el('div', { class: 'sa-note', text: 'No strings yet. Add one, then put the optimizers below into it.' }));
    array.appendChild(el('div', { class: 'sa-actions' }, addString));

    // Optimizers heard on the bus that are not panels yet.
    loose.innerHTML = '';
    const bound = new Set(saNodes().map(serialOf).filter(Boolean).map((s: any) => s.toLowerCase()));
    const unbound = (snap?.optimizers || []).filter((o: any) => !bound.has(String(o.serial).toLowerCase()));
    if (unbound.length) {
      loose.appendChild(el('h3', { text: `Not in the array (${unbound.length})` }));
      loose.appendChild(el('div', { class: 'desc', text: 'Optimizers heard on the bus. Put each into a string; its label can be changed after.' }));
      unbound.forEach((o: any) => {
        const pick = el('select', { class: 'sa-adopt' }) as HTMLSelectElement;
        pick.appendChild(el('option', { value: '', text: 'Add to…' }));
        strings.forEach(s => pick.appendChild(el('option', { value: s.Id, text: s.Label || s.Id })));
        pick.disabled = !strings.length || !o.named;
        pick.onchange = () => {
          const s = saNode(pick.value);
          if (!s) return;
          adoptOptimizer(o.serial, s.Id, saNextLabel(s));
          changed();
          toast(`Added to ${s.Label || s.Id}. Press Save to keep it.`, true);
        };
        const row = el('div', { class: 'sa-loose-row' },
          el('code', { text: o.serial }),
          el('span', { class: 'sa-loose-val', text: stale(o) ? 'quiet' : `${Math.round(o.power)} W · ${o.vin.toFixed(1)} V` }),
          pick);
        if (!o.named) row.appendChild(el('span', { class: 'desc', text: 'waiting for the TAP’s node table to name it' }));
        row.dataset.serial = o.serial;
        loose.appendChild(row);
      });
    }
  };

  const load = async () => {
    let r: any;
    try { r = await api('/api/integrations/tigo/optimizers', { method: 'POST' }); }
    catch (e: any) { r = { body: { ok: false, message: String(e?.message || e) } }; }
    const body = r?.body;
    if (body?.ok && body.result?.ok) { snap = body.result; failed = null; }
    else {
      snap = snap || null;
      failed = /No integration called/.test(body?.message || '')
        ? 'The Tigo TAP plugin is not loaded, so nothing is reading the optimizers.'
        : body?.message || 'The optimizers could not be read.';
    }
    if (snap && !(snap.connections || []).length)
      failed = 'No TAP bus is set up. Add one on the Tigo TAP settings page: the RS485 gateway’s host and port, and whether a CCA is on the bus (Listen) or not (Poll).';
    render();
  };

  link.onclick = () => { activate(link, sec); load(); };
  // Live while the page is open; a drag or an edit in progress is left alone.
  setInterval(() => { if (sec.classList.contains('active') && !dragged && !busyInSection(sec)) load(); }, 5000);
  render();
  return { link, sec };
}
