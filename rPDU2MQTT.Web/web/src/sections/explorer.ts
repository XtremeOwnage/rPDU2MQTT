// Explorers on the MQTT and Modbus pages: browse what is out there, tick readings, and create a node from them.
import { api, btn, el, ensure, formatNum, toast } from '../helpers.js';
import { state } from '../state.js';
import { refreshDirty } from '../dirty.js';
import { METRICS, NODE_KINDS, MODBUS_REGISTER_TYPES, metricLabel } from '../flow-vocabulary.js';
import { overlay, fetchTopics } from './node-editor.js';
import { editNodeOnNextOpen } from './nodes.js';

/// A ticked reading: the binding it becomes, what the create dialog calls it, and a JSON topic's fields.
type PickedBinding = { key: string, what: string, source: any, fields?: string[] };

/// The footer both explorers share: how many are ticked, and the button that turns them into a node.
function explorerFooter(picked: Map<string, PickedBinding>, suggestId: () => string, onClear: () => void, closeExplorer: () => void) {
  const bar = el('div', { class: 'ld-toolbar', style: { marginTop: '8px' } });
  const create = btn('Create node', 'primary') as HTMLButtonElement;
  const clear = btn('Clear selection');
  const count = el('span', { class: 'desc', style: { margin: '0 0 0 8px' } });
  const sync = () => {
    count.textContent = picked.size ? `${picked.size} selected` : 'Tick readings to create a node from them.';
    create.disabled = !picked.size;
  };
  create.onclick = () => { if (picked.size) openCreateNodeDialog([...picked.values()], suggestId(), closeExplorer); };
  clear.onclick = () => { picked.clear(); onClear(); sync(); };
  bar.append(create, clear, count);
  sync();
  return { bar, sync };
}

/// A node id from free text: lower case, with anything EmonCMS or MQTT would not take replaced.
function explorerSlug(s: string) {
  return String(s || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

/// The create-node dialog, filled in with a binding per ticked reading; the node opens in the Nodes editor.
export function openCreateNodeDialog(bindings: PickedBinding[], suggestedId: string, closeExplorer: () => void) {
  const { body, close } = overlay('Create node');
  const flow = ensure(state.data, 'EnergyFlow', {});
  const nodes: any[] = ensure(flow, 'Nodes', []);
  body.appendChild(el('div', { class: 'desc', text: `A node with a binding for each of the ${bindings.length} selected reading(s). It opens in the node editor, and nothing is saved until you press Save there.` }));

  const bar = el('div', { class: 'ld-toolbar' });
  const idIn = el('input', { type: 'text', value: suggestedId, placeholder: 'id (e.g. gridboss)' }) as HTMLInputElement;
  const labIn = el('input', { type: 'text', placeholder: 'label (e.g. Grid Boss)' }) as HTMLInputElement;
  const kindSel = el('select', { style: { width: 'auto' } }) as HTMLSelectElement;
  NODE_KINDS.forEach(([v, label]) => kindSel.appendChild(el('option', { value: v, text: label })));
  bar.append(idIn, labIn, kindSel);
  body.appendChild(bar);

  const sources = bindings.map(b => ({ ...b.source }));
  const tbl = el('table', { class: 'ld' });
  tbl.appendChild(el('thead', {}, el('tr', {}, el('th', { text: 'Reading' }), el('th', { text: 'Metric' }), el('th', { text: 'JSON field' }))));
  const tbody = el('tbody');
  bindings.forEach((b, i) => {
    const src = sources[i];
    const metricSel = el('select', { style: { width: 'auto' } }) as HTMLSelectElement;
    METRICS.forEach(([key, label]) => metricSel.appendChild(el('option', { value: key, text: label })));
    metricSel.value = src.Metric || 'realpower';
    metricSel.onchange = () => { src.Metric = metricSel.value; src.Unit = undefined; };
    let fieldCell: any = el('span', { class: 'desc', text: '—' });
    if (b.fields && b.fields.length > 1) {
      const fieldSel = el('select', { style: { width: 'auto' } }) as HTMLSelectElement;
      b.fields.forEach(f => fieldSel.appendChild(el('option', { value: f, text: f })));
      fieldSel.value = src.JsonField || b.fields[0];
      src.JsonField = fieldSel.value;
      fieldSel.onchange = () => { src.JsonField = fieldSel.value; };
      fieldCell = fieldSel;
    }
    tbody.appendChild(el('tr', {}, el('td', {}, el('code', { text: b.what })), el('td', {}, metricSel), el('td', {}, fieldCell)));
  });
  tbl.appendChild(tbody);
  body.appendChild(tbl);

  const foot = el('div', { class: 'ld-toolbar', style: { marginTop: '8px' } });
  const create = btn('Create node', 'primary');
  const err = el('span', { class: 'desc', style: { margin: '0 0 0 8px', color: 'var(--bad)' } });
  foot.append(create, err);
  body.appendChild(foot);

  create.onclick = () => {
    const id = (idIn.value || '').trim();
    if (!id) { err.textContent = 'An id is required.'; return; }
    if (nodes.some((n: any) => n.Id === id)) { err.textContent = 'That id already exists.'; return; }
    // 'none': the node is valued by the bindings it was created with.
    const node: any = { Id: id, Label: (labIn.value || '').trim() || id, Mode: 'none', Sources: sources };
    if (kindSel.value !== 'node') node.Kind = kindSel.value;
    nodes.push(node);
    refreshDirty();
    close();
    closeExplorer();
    editNodeOnNextOpen(id);
    (Array.from(document.querySelectorAll('nav a')) as any[]).find(a => a.dataset.label === 'Nodes')?.click();
    toast(`Created node ${id} with ${sources.length} binding(s). Press Save to keep it.`, true);
  };
}

/// The MQTT explorer: search the broker's live topics and tick the ones to create a node from.
export function openMqttExplorer() {
  const { body, close } = overlay('MQTT explorer');
  body.appendChild(el('div', { class: 'desc', text: 'Live topics seen on the broker while this window is open. Tick readings, then create a node with a binding for each.' }));

  const filterBar = el('div', { class: 'ld-toolbar' });
  const filterIn = el('input', { type: 'text', value: '#', placeholder: '# (everything)', style: { width: '220px' } }) as HTMLInputElement;
  filterIn.title = 'The topic filter to subscribe to while browsing. If the broker denies “#”, narrow it (e.g. solar_assistant/#).';
  const applyFilter = btn('Browse this');
  filterBar.append(el('span', { class: 'desc', style: { margin: '0' }, text: 'Subscribe to:' }), filterIn, applyFilter);
  body.appendChild(filterBar);

  const bar = el('div', { class: 'ld-toolbar' });
  const search = el('input', { type: 'search', placeholder: 'filter the shown topics…', style: { width: '320px' } }) as HTMLInputElement;
  const status = el('span', { class: 'desc', style: { margin: '0 0 0 8px' } });
  bar.append(search, status);
  body.appendChild(bar);

  const tbl = el('table', { class: 'ld' });
  const head = el('tr');
  ['', 'Topic', 'Last value', 'Looks like'].forEach(h => head.appendChild(el('th', { text: h })));
  tbl.appendChild(el('thead', {}, head));
  const tbody = el('tbody');
  tbl.appendChild(tbody);
  body.appendChild(tbl);

  const picked = new Map<string, PickedBinding>();
  // The deepest topic prefix every ticked topic shares, as the suggested id.
  const suggestId = () => {
    const parts = [...picked.keys()].map(t => t.split('/'));
    const common: string[] = [];
    for (let i = 0; parts.length && parts.every(p => p.length > i + 1 && p[i] === parts[0][i]); i++) common.push(parts[0][i]);
    return explorerSlug(common[common.length - 1] || '');
  };
  let rows: any[] = [];
  const draw = () => {
    tbody.innerHTML = '';
    rows.forEach((t: any) => {
      const box = el('input', { type: 'checkbox' }) as HTMLInputElement;
      box.checked = picked.has(t.topic);
      box.onchange = () => {
        if (!box.checked) picked.delete(t.topic);
        else {
          const fields: string[] = (t.fields || []).map((f: any) => f.field);
          picked.set(t.topic, {
            key: t.topic, what: t.topic, fields,
            source: { Type: 'mqtt', Topic: t.topic, Metric: t.metric || 'realpower', Unit: t.unit || undefined, JsonField: fields.length === 1 ? fields[0] : undefined },
          });
        }
        footer.sync();
      };
      tbody.appendChild(el('tr', {},
        el('td', {}, box),
        el('td', {}, el('code', { text: t.topic })),
        el('td', { class: 'num', text: t.value != null ? formatNum(t.value) + (t.unit ? ' ' + t.unit : '') : (t.payload || '').slice(0, 48) }),
        el('td', { text: t.isJson ? `JSON · ${(t.fields || []).length} field(s)` : (t.metric ? metricLabel(t.metric) : '—') })));
    });
  };
  const footer = explorerFooter(picked, suggestId, draw, close);
  body.appendChild(footer.bar);

  const reload = async () => {
    const b = await fetchTopics(search.value.trim(), 100, filterIn.value.trim() || '#');
    if (b.granted === false) {
      status.style.color = 'var(--bad)';
      status.textContent = `The broker denied the subscription to “${b.filter || filterIn.value.trim()}”. Grant this MQTT account read permission on it, or narrow the filter.`;
      rows = []; draw();
      return;
    }
    status.style.color = 'var(--muted)';
    status.textContent = b.listening
      ? `${(b.topics || []).length} shown · ${b.indexed}/${b.capacity} indexed · subscribed to “${b.filter || '#'}”`
      : `waiting for the broker subscription to “${b.filter || filterIn.value.trim()}” to come up…`;
    rows = b.topics || [];
    draw();
  };

  let timer: any = null;
  search.oninput = () => { clearTimeout(timer); timer = setTimeout(reload, 250); };
  applyFilter.onclick = () => reload();
  filterIn.onkeydown = (e: any) => { if (e.key === 'Enter') reload(); };
  reload();
  // Keep the topic index's lease alive, and the values fresh, while the window is open.
  const poll = setInterval(() => { if (!document.body.contains(tbl)) { clearInterval(poll); return; } reload(); }, 5000);
}

/// The Modbus explorer: read a block of registers from a connection and tick the decoded values to create a node from.
export function openRegisterExplorer() {
  const conns: any[] = (state.data?.Modbus?.Connections) || [];
  const { body, close } = overlay('Modbus explorer');
  if (!conns.length) {
    body.appendChild(el('div', { class: 'desc', style: { color: 'var(--bad)' }, text: 'There are no Modbus connections. Add one on this page first.' }));
    return;
  }
  body.appendChild(el('div', { class: 'desc', text: 'One read per click. A gateway usually accepts a single client, and the worker is already polling it. Each register is decoded every way that makes sense; tick the values that match what the device reports, then create a node with a binding for each.' }));

  const bar = el('div', { class: 'ld-toolbar' });
  const connSel = el('select', { style: { width: 'auto' } }) as HTMLSelectElement;
  conns.forEach(c => connSel.appendChild(el('option', { value: c.Id, text: c.Name || c.Id })));
  connSel.value = conns[0].Id;
  const startIn = el('input', { type: 'number', value: 0, title: 'First register', style: { width: '90px' } }) as HTMLInputElement;
  const countIn = el('input', { type: 'number', value: 32, title: 'How many', style: { width: '70px' } }) as HTMLInputElement;
  const bankSel = el('select', { style: { width: 'auto' } }) as HTMLSelectElement;
  MODBUS_REGISTER_TYPES.forEach(t => bankSel.appendChild(el('option', { value: t, text: t })));
  bankSel.value = 'holding';
  const read = btn('Read', 'primary');
  const status = el('span', { class: 'desc', style: { margin: '0 0 0 8px' } });
  bar.append(connSel, startIn, countIn, bankSel, read, status);
  body.appendChild(bar);

  const tbl = el('table', { class: 'ld' });
  const head = el('tr');
  ['Register', 'uint16', 'int16', 'uint32', 'float32'].forEach(h => head.appendChild(el('th', { text: h })));
  tbl.appendChild(el('thead', {}, head));
  const tbody = el('tbody');
  tbl.appendChild(tbody);
  body.appendChild(tbl);

  const picked = new Map<string, PickedBinding>();
  const conn = () => conns.find(c => c.Id === connSel.value) || conns[0];
  let rows: any[] = [];
  let readFrom = { id: '', bank: 'holding' };

  const cell = (row: any, type: string) => {
    const td = el('td', { class: 'num' });
    if (row[type] == null) { td.textContent = '—'; td.style.color = 'var(--muted)'; return td; }
    const key = `${readFrom.id}|${readFrom.bank}|${row.register}|${type}`;
    const box = el('input', { type: 'checkbox', title: `Register ${row.register} as ${type}` }) as HTMLInputElement;
    box.checked = picked.has(key);
    const { id, bank } = readFrom;
    box.onchange = () => {
      if (!box.checked) picked.delete(key);
      else picked.set(key, {
        key, what: `${id} ${bank} ${row.register} as ${type} = ${formatNum(row[type])}`,
        source: { Type: 'modbus', Connection: id, Register: row.register, RegisterType: bank === 'holding' ? undefined : bank, DataType: type === 'uint16' ? undefined : type, Metric: 'realpower' },
      });
      footer.sync();
    };
    td.append(box, ' ', formatNum(row[type]));
    return td;
  };
  const draw = () => {
    tbody.innerHTML = '';
    rows.forEach((row: any) => {
      const tr = el('tr');
      tr.appendChild(el('td', {}, el('code', { text: String(row.register) })));
      tr.append(cell(row, 'uint16'), cell(row, 'int16'), cell(row, 'uint32'), cell(row, 'float32'));
      tbody.appendChild(tr);
    });
  };
  const footer = explorerFooter(picked, () => explorerSlug(readFrom.id), draw, close);
  body.appendChild(footer.bar);

  read.onclick = async () => {
    const c = conn();
    status.textContent = 'reading…';
    const r = await api('/api/modbus/scan', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        Host: c.Host, Port: c.Port, UnitId: c.UnitId, Framing: c.Framing, TimeoutMs: c.TimeoutMs,
        Start: parseInt(startIn.value) || 0, Count: parseInt(countIn.value) || 32, RegisterType: bankSel.value,
      }),
    });
    status.textContent = (r.body && r.body.message) || (r.body?.ok ? '' : 'read failed');
    status.style.color = r.body?.ok ? 'var(--muted)' : 'var(--bad)';
    readFrom = { id: c.Id, bank: bankSel.value };
    rows = (r.body && r.body.rows) || [];
    draw();
  };
  read.onclick(null as any);
}
