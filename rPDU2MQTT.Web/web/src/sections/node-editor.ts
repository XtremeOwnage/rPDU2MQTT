// Editing one node — name, kind, how it is valued, its live sources.
import { api, btn, el, ensure, formatNum, toast } from '../helpers.js';
import { state } from '../state.js';
import { refreshDirty } from '../dirty.js';
import { wouldLoop } from './flow.js';
import { sourceEditorFor, genericSourceEditor } from '../source-editors.js';
import { tagInput } from '../tags.js';
import { templateHelp } from '../template-field.js';
import { BALANCE_ROLES, balanceRoleOf, renameInBalance, setBalanceRole } from './balance.js';
import { locationChoices, circuitChoices, choiceSelect } from '../location-options.js';
import {
  DIRECTIONAL_METRICS, LIVE_HINT, MODBUS_DATATYPES, MODBUS_REGISTER_TYPES, MODBUS_WORDORDERS,
  NODE_KINDS, NODE_MODES, SIGNED_METRICS, feedsNothing, sourceTypes,
  isAdditiveMetric, kindMeta, metricLabel, metricMeta, sourceMetricKey,
} from '../flow-vocabulary.js';

// --- Browsing what's out there: MQTT topics, and a Modbus device's registers ----------------------

let pickerSeq = 0;

/// A modal panel over the page. Returns the body to fill; closes on the button, the backdrop, or Escape.
export function overlay(title: string, onClose?: () => void, opts: { footer?: any, className?: string, sub?: string } = {}): { body: any, close: () => void } {
  const back = el('div', { class: 'sheet-backdrop' });
  // The node editor's widest row is a table of eleven columns, which wants about 1,640px. At 75vw that
  // overflowed a 2,039px screen by ~110px and the Remove button rendered as "Re…", so the sheet takes what
  // the screen actually has. Vertical scrolling only: the table below manages its own width.
  // overflowX was hidden, on the reasoning that the table below manages its own width. Nothing did: the
  // widest row wants ~1,640px, so on a phone the panel clipped it at ~340px with no way to reach the rest.
  // Both axes scroll; the sizing is in .sheet-panel so a phone can be given different numbers.
  const panel = el('div', { class: 'sheet-panel' + (opts.className ? ' ' + opts.className : '') });
  // Header and footer stay put while the body scrolls under them: Close and Save are always in reach.
  const head = el('div', { class: 'sheet-head' });
  const titles = el('div', { class: 'sheet-titles' }, el('h4', { text: title }));
  if (opts.sub) titles.appendChild(el('code', { class: 'sheet-sub', text: opts.sub }));
  head.appendChild(titles);
  const x = el('button', { class: 'sheet-x', type: 'button', text: '✕', title: 'Close (Esc)' }) as HTMLButtonElement;
  x.setAttribute('aria-label', 'Close');
  head.appendChild(x);
  const body = el('div');
  // Every edit inside a sheet reports itself, once, here.
  //
  // The controls in this file write straight into the config object and most of them returned without
  // telling the dirty tracker, so the save bar stayed silent until something else happened to refresh it —
  // closing the sheet, or a control that did remember. Editing a topic and looking at the save bar said
  // nothing had changed. Adding refreshDirty() to two dozen handlers fixes today's controls and not
  // tomorrow's; `change` bubbles, so one listener on the sheet covers every control it will ever contain.
  //
  // refreshDirty() diffs the whole document, so it does not matter which control fired: what changed is
  // read off the document rather than reported by the handler.
  body.addEventListener('change', () => refreshDirty());
  panel.append(head, body);
  if (opts.footer) panel.appendChild(el('div', { class: 'sheet-foot sheet-sticky-foot' }, opts.footer));
  back.appendChild(panel);
  document.body.appendChild(back);

  const close = () => { back.remove(); document.removeEventListener('keydown', onKey); };
  const dismiss = () => { close(); if (onClose) onClose(); };
  const onKey = (e: any) => { if (e.key === 'Escape') dismiss(); };
  x.onclick = dismiss;
  back.onclick = (e: any) => { if (e.target === back) dismiss(); };
  document.addEventListener('keydown', onKey);
  return { body, close };
}

export async function fetchTopics(q: string, limit = 50, filter?: string): Promise<any> {
  const f = filter ? `&filter=${encodeURIComponent(filter)}` : '';
  const r = await api(`/api/mqtt/topics?q=${encodeURIComponent(q || '')}&limit=${limit}${f}`);
  return (r.body && r.body.ok) ? r.body : { topics: [], listening: false, indexed: 0 };
}

async function fetchTopicDetail(topic: string): Promise<any | null> {
  if (!topic) return null;
  const r = await api(`/api/mqtt/topic?topic=${encodeURIComponent(topic)}`);
  return (r.body && r.body.ok) ? r.body : null;
}

/// Inline autocomplete for a topic input: a datalist kept in step with what you've typed.
function topicSuggester(input: any, onExactPick: () => void) {
  const list = el('datalist', { id: 'topics-' + (++pickerSeq) });
  input.setAttribute('list', list.id);
  let timer: any = null;
  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const body = await fetchTopics(input.value.trim());
      list.innerHTML = '';
      (body.topics || []).forEach((t: any) => list.appendChild(el('option', { value: t.topic })));
      // Picking from the dropdown fires 'input', not 'change', so treat an exact hit as a choice.
      if ((body.topics || []).some((t: any) => t.topic === input.value.trim())) onExactPick();
    }, 250);
  });
  return { list };
}

/// Inline autocomplete for the JSON field, read from the chosen topic's own payload.
function jsonFieldSuggester(input: any, topicOf: () => string) {
  const list = el('datalist', { id: 'fields-' + (++pickerSeq) });
  input.setAttribute('list', list.id);
  const fill = async () => {
    const detail = await fetchTopicDetail(topicOf());
    list.innerHTML = '';
    ((detail && detail.fields) || []).forEach((f: any) => list.appendChild(el('option', { value: f.field })));
  };
  input.addEventListener('focus', fill);
  return list;
}

/// Fill in what the payload tells us about a freshly chosen topic — without overwriting deliberate choices.
async function applyTopicHint(src: any, topic: string, fieldIn: any, rerender: () => void) {
  const detail = await fetchTopicDetail(topic);
  if (!detail) return;

  const notes: string[] = [];
  // Only infer where the user hasn't already decided: an untouched binding still reads 'realpower'.
  if (detail.metric && (!src.Metric || src.Metric === 'realpower') && detail.metric !== src.Metric) {
    src.Metric = detail.metric; src.Unit = undefined; notes.push(metricLabel(detail.metric));
  }
  if (detail.unit && !src.Unit && detail.unit !== metricMeta(src.Metric || 'realpower')[2]) {
    src.Unit = detail.unit; notes.push(detail.unit);
  }
  if (detail.isJson && !src.JsonField && (detail.fields || []).length === 1) {
    src.JsonField = detail.fields[0].field;
    if (fieldIn) fieldIn.value = src.JsonField;
    notes.push('field ' + src.JsonField);
  }

  const sample = detail.value != null ? `${formatNum(detail.value)}` : (detail.payload || '').slice(0, 40);
  toast(notes.length ? `Read ${sample} — set ${notes.join(', ')}.` : `Last value: ${sample}`, true);
  if (notes.length) rerender();
}

/// The topic browser: search what's on the broker, see each topic's last value, click to bind it.
function openTopicPicker(current: string, onPick: (topic: string) => void) {
  const { body, close } = overlay('Browse broker topics');
  body.appendChild(el('div', { class: 'desc', text: 'Live topics seen on the broker while this window is open. Nothing is indexed in the background — the subscription starts when you browse and stops when you stop.' }));

  // Which broker filter to subscribe to.
  const filterBar = el('div', { class: 'ld-toolbar' });
  const filterIn = el('input', { type: 'text', value: '#', placeholder: '# (everything)', style: { width: '220px' } }) as HTMLInputElement;
  filterIn.title = 'The topic filter to subscribe to while browsing. If the broker denies “#”, narrow it (e.g. solar_assistant/#).';
  const applyFilter = btn('Browse this');
  filterBar.append(el('span', { class: 'desc', style: { margin: '0' }, text: 'Subscribe to:' }), filterIn, applyFilter);
  body.appendChild(filterBar);

  const bar = el('div', { class: 'ld-toolbar' });
  const search = el('input', { type: 'search', value: current || '', placeholder: 'filter the shown topics…', style: { width: '320px' } }) as HTMLInputElement;
  const status = el('span', { class: 'desc', style: { margin: '0 0 0 8px' } });
  bar.append(search, status);
  body.appendChild(bar);

  const tbl = el('table', { class: 'ld' });
  const head = el('tr');
  ['Topic', 'Last value', 'Looks like', ''].forEach(h => head.appendChild(el('th', { text: h })));
  tbl.appendChild(el('thead', {}, head));
  const tbody = el('tbody');
  tbl.appendChild(tbody);
  body.appendChild(el('div', { class: 'sheet-scroll' }, tbl));

  const load = async () => {
    const b = await fetchTopics(search.value.trim(), 100, filterIn.value.trim() || '#');
    tbody.innerHTML = '';
    if (b.granted === false) {
      // The broker refused the subscription — say so plainly instead of a mysterious empty list.
      status.style.color = 'var(--bad)';
      status.textContent = `The broker denied the subscription to “${b.filter || filterIn.value.trim()}”. Your MQTT account lacks read permission on it — grant it, or narrow the filter above to a prefix you can read (e.g. solar_assistant/#).`;
      return;
    }
    status.style.color = 'var(--muted)';
    status.textContent = b.listening
      ? `${(b.topics || []).length} shown · ${b.indexed}/${b.capacity} indexed · subscribed to “${b.filter || '#'}”`
      : `waiting for the broker subscription to “${b.filter || filterIn.value.trim()}” to come up…`;
    (b.topics || []).forEach((t: any) => {
      const tr = el('tr');
      tr.appendChild(el('td', {}, el('code', { text: t.topic })));
      tr.appendChild(el('td', { class: 'num', text: t.value != null ? formatNum(t.value) + (t.unit ? ' ' + t.unit : '') : (t.payload || '').slice(0, 48) }));
      tr.appendChild(el('td', { text: t.isJson ? `JSON · ${(t.fields || []).length} field(s)` : (t.metric ? metricLabel(t.metric) : '—') }));
      const use = btn('Use', 'primary');
      use.onclick = () => { onPick(t.topic); close(); };
      tr.appendChild(el('td', {}, use));
      tbody.appendChild(tr);
    });
  };

  let timer: any = null;
  search.oninput = () => { clearTimeout(timer); timer = setTimeout(load, 250); };
  applyFilter.onclick = () => load();
  filterIn.onkeydown = (e: any) => { if (e.key === 'Enter') load(); };
  load();
  // Keep the index's lease alive (and the list fresh) for as long as the window is open.
  const poll = setInterval(() => { if (!document.body.contains(tbl)) { clearInterval(poll); return; } load(); }, 5000);
}

/// Every feed on the EmonCMS server, fetched once per page and shared by every binding's picker.
///
/// One request rather than one per row: a node with eight bindings would otherwise ask the server for the
/// same list eight times the moment its editor opened.
let emonFeeds: Promise<any[]> | null = null;
function emonCmsFeeds(force = false): Promise<any[]> {
  if (force || !emonFeeds) {
    // The route wraps a handler's answer as { ok, result }, so the feeds are one level in.
    emonFeeds = api('/api/integrations/emoncms-source/feeds', { method: 'POST' })
      .then(r => (r.body?.result?.feeds || []) as any[])
      .catch(() => [] as any[]);
  }
  return emonFeeds;
}

/// Pick a feed off the server rather than typing a name from another browser tab.
function openEmonCmsPicker(current: string, onPick: (feed: any) => void) {
  const { body, close } = overlay('Browse EmonCMS feeds');
  body.appendChild(el('div', { class: 'desc', text: 'Feeds on the EmonCMS server this bridge is configured for, with their latest value. Picking one stores its name — or its id, when the name is not unique.' }));

  const bar = el('div', { class: 'ld-toolbar' });
  const search = el('input', { type: 'search', value: current || '', placeholder: 'filter by name or tag…', style: { width: '320px' } }) as HTMLInputElement;
  const status = el('span', { class: 'desc', style: { margin: '0 0 0 8px' } });
  bar.append(search, status);
  body.appendChild(bar);

  const tbl = el('table', { class: 'ld' });
  const head = el('tr');
  ['Tag', 'Feed', 'Latest', 'Updated', ''].forEach(h => head.appendChild(el('th', { text: h })));
  tbl.appendChild(el('thead', {}, head));
  const tbody = el('tbody');
  tbl.appendChild(tbody);
  body.appendChild(el('div', { class: 'sheet-scroll' }, tbl));

  const draw = (feeds: any[]) => {
    const q = search.value.trim().toLowerCase();
    const shown = feeds.filter(f => !q || (f.name || '').toLowerCase().includes(q) || (f.tag || '').toLowerCase().includes(q));
    // A name that exists under several tags cannot be stored as a bare name, so the row that offers it
    // stores the id instead — the ambiguity is settled here rather than reported later as a missing value.
    const counts = new Map<string, number>();
    feeds.forEach(f => counts.set(f.name, (counts.get(f.name) || 0) + 1));

    status.textContent = `${shown.length} of ${feeds.length} feed(s)`;
    tbody.innerHTML = '';
    shown.slice(0, 300).forEach(f => {
      const tr = el('tr');
      tr.appendChild(el('td', { text: f.tag || '—' }));
      tr.appendChild(el('td', {}, el('code', { text: f.name })));
      tr.appendChild(el('td', { class: 'num', text: f.value != null ? formatNum(f.value) + (f.unit ? ' ' + f.unit : '') : '—' }));
      tr.appendChild(el('td', { class: 'desc', text: f.at ? new Date(f.at).toLocaleString() : 'never' }));
      const use = btn('Use', 'primary');
      if ((counts.get(f.name) || 0) > 1) use.title = `Several feeds are called “${f.name}”, so this stores its id (${f.id}).`;
      use.onclick = () => { onPick(f); close(); };
      tr.appendChild(el('td', {}, use));
      tbody.appendChild(tr);
    });
    if (!feeds.length)
      tbody.appendChild(el('tr', {}, el('td', { colspan: '5', class: 'desc',
        text: 'No feeds came back. Check that EmonCMS.Url and an API key that can read feeds are set, then use Test on the EmonCMS feeds card.' })));
  };

  emonCmsFeeds().then(draw);
  search.oninput = () => emonCmsFeeds().then(draw);
}

/// The Source and Details cells for an EmonCMS binding: which feed, and what it currently reads.
function emonCmsSourceEditor(src: any, onChange: () => void): [any, any] {
  const feedIn = el('input', { type: 'text', value: src.Feed || '', placeholder: 'feed name or id', style: { width: '220px' } }) as HTMLInputElement;
  feedIn.title = 'The feed to read: its name (e.g. 1_power), tag/name when the name is not unique, or its numeric id.';
  feedIn.onchange = () => { src.Feed = feedIn.value.trim() || undefined; onChange(); redraw(); };

  const browse = btn('Browse…');
  browse.title = 'List the feeds on the EmonCMS server and pick one.';
  browse.onclick = () => openEmonCmsPicker(feedIn.value.trim(), f => {
    // Stored by name where the name identifies it, so the binding survives a re-provision that renumbers
    // the feed; by id only where a name would be ambiguous.
    emonCmsFeeds().then(all => {
      const dupes = all.filter(o => o.name === f.name).length > 1;
      feedIn.value = dupes ? String(f.id) : f.name;
      src.Feed = feedIn.value;
      onChange();
      redraw();
    });
  });

  // What the named feed reads right now, so a wrong name is obvious here instead of as a blank node later.
  const detail = el('div', { class: 'desc', style: { margin: '0' }, text: '' });
  const redraw = () => {
    const wanted = (src.Feed || '').trim();
    if (!wanted) { detail.textContent = 'No feed chosen — this binding will supply nothing.'; detail.style.color = 'var(--muted)'; return; }
    emonCmsFeeds().then(all => {
      const matches = all.filter(f => String(f.id) === wanted || f.name === wanted || `${f.tag}/${f.name}` === wanted);
      if (!matches.length) {
        detail.style.color = 'var(--bad)';
        detail.textContent = all.length
          ? `No feed on the server is called “${wanted}”.`
          : 'Could not list the server’s feeds, so this name cannot be checked here.';
        return;
      }
      if (matches.length > 1) {
        detail.style.color = 'var(--bad)';
        detail.textContent = `“${wanted}” names ${matches.length} feeds (${matches.map(f => `${f.tag}/${f.name}`).join(', ')}). Use its tag, or its id.`;
        return;
      }
      const f = matches[0];
      detail.style.color = 'var(--muted)';
      detail.textContent = (f.value != null ? `${formatNum(f.value)}${f.unit ? ' ' + f.unit : ''}` : 'no value logged yet')
        + (f.at ? ` · ${new Date(f.at).toLocaleString()}` : '');
    });
  };
  redraw();

  return [el('td', {}, feedIn, ' ', browse), el('td', {}, detail)];
}

/// The Modbus explorer: read a block of registers off the device and pick the one that looks right.
function openModbusExplorer(src: any, onPick: () => void) {
  const conns: any[] = (state.data?.Modbus?.Connections) || [];
  const conn = conns.find(c => c.Id === src.Connection);
  const { body } = overlay('Modbus explorer' + (conn ? ` · ${conn.Name || conn.Id}` : ''));

  if (!conn) {
    body.appendChild(el('div', { class: 'desc', style: { color: 'var(--bad)' }, text: 'Pick a Modbus connection for this binding first (they are defined in the Modbus section).' }));
    return;
  }

  body.appendChild(el('div', { class: 'desc', text: 'One read per click — a gateway usually accepts a single client, and the worker is already polling it. Each register is decoded every way that makes sense; click the value that matches what the device should be reporting.' }));

  const bar = el('div', { class: 'ld-toolbar' });
  const startIn = el('input', { type: 'number', value: src.Register ?? 0, title: 'First register', style: { width: '90px' } }) as HTMLInputElement;
  const countIn = el('input', { type: 'number', value: 32, title: 'How many', style: { width: '70px' } }) as HTMLInputElement;
  const bankSel = el('select', { style: { width: 'auto' } }) as HTMLSelectElement;
  MODBUS_REGISTER_TYPES.forEach(t => bankSel.appendChild(el('option', { value: t, text: t })));
  bankSel.value = src.RegisterType || 'holding';
  const read = btn('Read', 'primary');
  const status = el('span', { class: 'desc', style: { margin: '0 0 0 8px' } });
  bar.append(startIn, countIn, bankSel, read, status);
  body.appendChild(bar);

  const tbl = el('table', { class: 'ld' });
  const head = el('tr');
  ['Register', 'uint16', 'int16', 'uint32', 'float32'].forEach(h => head.appendChild(el('th', { text: h })));
  tbl.appendChild(el('thead', {}, head));
  const tbody = el('tbody');
  tbl.appendChild(tbody);
  body.appendChild(el('div', { class: 'sheet-scroll' }, tbl));

  const pick = (register: number, dataType: string) => {
    src.Register = register;
    src.RegisterType = bankSel.value === 'holding' ? undefined : bankSel.value;
    src.DataType = dataType === 'uint16' ? undefined : dataType;
    toast(`Bound register ${register} as ${dataType}.`, true);
    onPick();
  };

  const cell = (row: any, key: string) => {
    const td = el('td', { class: 'num' });
    if (row[key] == null) { td.textContent = '—'; td.style.color = 'var(--muted)'; return td; }
    const link = el('span', { text: formatNum(row[key]), style: { cursor: 'pointer', color: 'var(--accent, #4f8cff)' }, title: `Use register ${row.register} as ${key}` });
    link.onclick = () => pick(row.register, key);
    td.appendChild(link);
    return td;
  };

  read.onclick = async () => {
    status.textContent = 'reading…';
    const r = await api('/api/modbus/scan', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        Host: conn.Host, Port: conn.Port, UnitId: conn.UnitId, Framing: conn.Framing, TimeoutMs: conn.TimeoutMs,
        Start: parseInt(startIn.value) || 0, Count: parseInt(countIn.value) || 32, RegisterType: bankSel.value,
      }),
    });
    status.textContent = (r.body && r.body.message) || (r.body?.ok ? '' : 'read failed');
    status.style.color = r.body?.ok ? 'var(--muted)' : 'var(--bad)';
    tbody.innerHTML = '';
    ((r.body && r.body.rows) || []).forEach((row: any) => {
      const tr = el('tr');
      tr.appendChild(el('td', {}, el('code', { text: String(row.register) })));
      tr.append(cell(row, 'uint16'), cell(row, 'int16'), cell(row, 'uint32'), cell(row, 'float32'));
      tbody.appendChild(tr);
    });
  };
  read.onclick(null);
}

/// Rename a node and carry its wiring with it; the id is the node's identity everywhere.
export function openRenameDialog(node: any, flow: any, existingIds: Set<string>, onRenamed: (id: string) => void) {
  const { body, close } = overlay(`Rename ${node.Label || node.Id}`);
  const links: any[] = ensure(flow, 'Links', []);
  const parents: any = ensure(flow, 'Parents', {});
  const wired = links.filter(l => l.From === node.Id || l.To === node.Id).length
    + Object.entries(parents).filter(([c, p]) => c === node.Id || p === node.Id).length;

  body.appendChild(el('div', { class: 'desc', text: `Its ${wired} wiring reference(s) move with it automatically.` }));

  // The id is what every integration keys off, so a rename is a rename downstream too.
  const warn = el('div', {
    class: 'desc',
    style: { border: '1px solid var(--bad)', borderRadius: '6px', padding: '8px', margin: '8px 0', color: 'var(--fg)' },
  });
  warn.appendChild(el('b', { text: 'This changes how the node appears downstream.' }));
  warn.appendChild(el('div', { text: 'The MQTT topic, the Home Assistant entity/unique id, the Prometheus series and the EmonCMS feed are all derived from the id. Anything already recording under the old name — HA history, an energy dashboard entry, a Grafana query, an emonCMS feed — will see this as a new thing and stop following the old one. Rename deliberately, and fix those up afterwards.' }));
  body.appendChild(warn);

  const row = el('div', { class: 'ld-toolbar' });
  const idIn = el('input', { type: 'text', value: node.Id, style: { width: '260px' } }) as HTMLInputElement;
  const apply = btn('Rename', 'primary');
  const err = el('span', { class: 'desc', style: { margin: '0 0 0 8px', color: 'var(--bad)' } });
  row.append(idIn, apply, err);
  body.appendChild(row);

  apply.onclick = () => {
    const next = (idIn.value || '').trim();
    if (!next) { err.textContent = 'An id is required.'; return; }
    if (next === node.Id) { close(); return; }
    if (existingIds.has(next)) { err.textContent = 'That id already exists.'; return; }

    const from = node.Id;
    node.Id = next;
    links.forEach(l => { if (l.From === from) l.From = next; if (l.To === from) l.To = next; });
    // It keeps its place in the energy balance and in any group that holds it.
    renameInBalance(flow, from, next);
    (flow.Groups || []).forEach((g: any) => { g.Members = (g.Members || []).map((m: string) => m === from ? next : m); });
    // The legacy Parents map keys by child id and stores the parent id, so both sides can name this node.
    Object.keys(parents).forEach(child => {
      if (parents[child] === from) parents[child] = next;
      if (child === from) { parents[next] = parents[child]; delete parents[child]; }
    });

    toast(`Renamed ${from} → ${next}; ${wired} reference(s) updated. Save to apply.`, true);
    close();
    onRenamed(next);
  };
  idIn.onkeydown = (e: any) => { if (e.key === 'Enter') apply.onclick(null); };
}

// A labelled field (label above a control) for the node editor's form grid.
export function field(labelText: string, control: HTMLElement, hint?: string) {
  const f = el('div', { style: { display: 'flex', flexDirection: 'column', gap: '3px' } });
  f.appendChild(el('label', { text: labelText, style: { fontSize: '11px', color: 'var(--muted)' } }));
  f.appendChild(control);
  if (hint) f.appendChild(el('div', { class: 'desc', text: hint, style: { margin: '0', fontSize: '11px' } }));
  return f;
}

// Per-node editor (#129): what the node is, where its readings come from, and how it is wired.
//
// Laid out as sections a phone can stack: the basics, then one card per live binding, then the wiring,
// then the filing details (tags, place, EmonCMS) folded away until wanted. The bindings were a table of
// up to eleven columns — about 1,640px — which a phone could only show by scrolling it sideways.
export function renderNodeEditor(node: any, links: any[], cand: Map<string, any>, rerender: (close?: boolean) => void) {
  const meta = kindMeta(node.Kind);
  const allowed = meta[2];
  // No frame and no header of its own: this renders into a modal panel that already carries the node's name.
  const box = el('div', { class: 'node-editor' });
  const section = (title: string, ...extra: any[]) => {
    const s = el('section', { class: 'ne-section' });
    s.appendChild(el('div', { class: 'ne-section-head' }, el('h5', { text: title }), ...extra));
    box.appendChild(s);
    return s;
  };

  // --- What it is ---
  const basics = section('Node');
  const grid = el('div', { class: 'node-editor-fields' });

  const labIn = el('input', { type: 'text', value: node.Label || '', placeholder: node.Id });
  labIn.onchange = () => { node.Label = labIn.value.trim() || undefined; };
  grid.appendChild(field('Name', labIn));

  const kindSel = el('select');
  NODE_KINDS.forEach(([v, label]) => kindSel.appendChild(el('option', { value: v, text: label })));
  kindSel.value = node.Kind || 'node';
  kindSel.onchange = () => { node.Kind = kindSel.value === 'node' ? undefined : kindSel.value; rerender(); };
  grid.appendChild(field('Kind', kindSel));

  // What it counts toward is not what it is: stored in EnergyFlow.Balance, so the Balance page and this
  // field are one setting and a node sits under one total at most.
  const flowCfg = ensure(state.data, 'EnergyFlow', {});
  const roleSel = el('select') as HTMLSelectElement;
  roleSel.appendChild(el('option', { value: '', text: 'Nothing' }));
  BALANCE_ROLES.forEach(([role, , label]) => roleSel.appendChild(el('option', { value: role, text: label })));
  roleSel.value = balanceRoleOf(flowCfg, node.Id);
  roleSel.onchange = () => setBalanceRole(flowCfg, node.Id, roleSel.value);
  grid.appendChild(field('Counts toward', roleSel, 'Site total it is summed into.'));

  const modeSel = el('select');
  NODE_MODES.forEach(([v, label, desc]) => { const o = el('option', { value: v, text: label }); o.title = desc; modeSel.appendChild(o); });
  modeSel.value = node.Mode || 'auto';
  modeSel.onchange = () => {
    node.Mode = modeSel.value === 'auto' ? undefined : modeSel.value;
    if (node.Mode !== 'static') node.Value = undefined;  // a fixed value only belongs to a static node
    rerender();  // toggle the Fixed value field
  };
  grid.appendChild(field('Mode', modeSel, 'Value with no measurement.'));

  // The fixed value only makes sense for a static leaf — show it only in that mode.
  if ((node.Mode || 'auto') === 'static') {
    const valIn = el('input', { type: 'number', step: 'any', value: node.Value ?? '', placeholder: '—' });
    valIn.onchange = () => { const v = +valIn.value; node.Value = (valIn.value !== '' && !isNaN(v)) ? v : undefined; };
    grid.appendChild(field('Fixed value', valIn, 'Used unless a binding reports.'));
  }

  // The gauge's ceiling, for the kinds the Energy page draws a dial for.
  if (['solar', 'battery', 'grid', 'load', 'inverter'].includes(node.Kind || 'node')) {
    const maxIn = el('input', { type: 'number', step: 'any', min: '0', value: node.Max ?? '', placeholder: '—' });
    maxIn.onchange = () => { const v = +maxIn.value; node.Max = (maxIn.value !== '' && !isNaN(v) && v > 0) ? v : undefined; };
    grid.appendChild(field('Gauge max (W)', maxIn, 'Energy page gauge full scale. Blank: plain reading.'));
  }

  if ((node.Kind || 'node') === 'battery') {
    const stoIn = el('input', { type: 'number', step: 'any', value: node.StorageKwh ?? '', placeholder: 'kWh' });
    stoIn.onchange = () => { const v = +stoIn.value; node.StorageKwh = (stoIn.value !== '' && !isNaN(v)) ? v : undefined; };
    grid.appendChild(field('Storage (kWh)', stoIn));
  }
  basics.appendChild(grid);

  // --- Where its readings come from: one card per binding ---
  const sources: any[] = ensure(node, 'Sources', []);
  const addBind = btn('+ Add binding', 'primary');
  addBind.onclick = () => {
    // Default to the first metric this kind offers that isn't bound yet, so a click rarely needs a re-pick.
    const used = new Set(sources.map((s: any) => s.Metric || 'realpower'));
    const metric = allowed.find((m: string) => !used.has(m)) || allowed[0];
    sources.push({ Type: 'mqtt', Metric: metric, Topic: '' });
    rerender();
  };
  const liveStatus = el('span', { class: 'ne-status' });
  const liveSlot = el('span', { class: 'ne-head-actions' });
  const bindSec = section('Live value bindings', el('span', { class: 'ne-count', text: sources.length ? String(sources.length) : '' }), liveSlot);
  bindSec.appendChild(el('div', { class: 'desc ne-desc', text: 'One binding per metric. MQTT topic, Modbus register or another source. Applies on save, no restart.' }));

  // Battery and grid flow both ways.
  const bidirectional = (node.Kind === 'battery' || node.Kind === 'grid');
  const dirLabels: Record<string, string> = node.Kind === 'battery' ? { out: 'Discharge', in: 'Charge', split: 'Split: + discharge / − charge' }
    : node.Kind === 'grid' ? { out: 'Import', in: 'Export', split: 'Split: + import / − export' }
    : { out: 'Out', in: 'In', split: 'Split: + out / − in' };

  /// A small labelled control inside a binding card. `name` marks what it is, for the page checks.
  const slot = (label: string, name: string, ...controls: any[]) => {
    const s = el('div', { class: 'ne-slot' });
    s.dataset.field = name;
    s.appendChild(el('span', { class: 'ne-slot-label', text: label }));
    controls.forEach(c => s.appendChild(c));
    return s;
  };

  const list = el('div', { class: 'ne-bindings' });
  // Cells that a live probe fills in, keyed to their source so a refresh can update them in place.
  const liveCells: { src: any, cell: any }[] = [];
  sources.forEach((src: any) => {
    const card = el('div', { class: 'ne-binding' });
    const metric = src.Metric || 'realpower';
    const type = (src.Type || 'mqtt').toLowerCase();

    // Head: what is measured, from what kind of source, and what it reads now.
    const head = el('div', { class: 'ne-bind-head' });
    const metricSel = el('select', { class: 'ne-metric', title: 'Metric' });
    const opts = allowed.includes(metric) ? allowed : [metric, ...allowed];
    opts.forEach((m: string) => metricSel.appendChild(el('option', { value: m, text: metricLabel(m) })));
    metricSel.value = metric;
    metricSel.onchange = () => { src.Metric = metricSel.value; src.Unit = undefined; rerender(); };
    const typeSel = el('select', { class: 'ne-type', title: 'Source type' });
    sourceTypes(state.schema).forEach(([v, label]) => typeSel.appendChild(el('option', { value: v, text: label })));
    typeSel.value = src.Type || 'mqtt';
    typeSel.onchange = () => { src.Type = typeSel.value; rerender(); };  // the source fields differ per type
    const liveCell = el('span', { class: 'ne-live', text: '…', title: LIVE_HINT });
    liveCells.push({ src, cell: liveCell });
    const rm = el('button', { class: 'ne-remove', type: 'button', text: '✕', title: 'Remove this binding' }) as HTMLButtonElement;
    rm.setAttribute('aria-label', 'Remove');
    rm.onclick = () => { sources.splice(sources.indexOf(src), 1); rerender(); };
    head.append(metricSel, typeSel, liveCell, rm);
    card.appendChild(head);
    // Said at the point of choosing that this one won't roll up.
    if (!isAdditiveMetric(metric))
      card.appendChild(el('div', { class: 'desc ne-note', text: 'Per-node only — not summed up the tree.',
        title: `${metricLabel(metric)} describes a condition at a point, so it is never added up the tree.` }));

    // Body: where it reads from, then how the reading is taken.
    const bodyRow = el('div', { class: 'ne-bind-body' });
    if (type === 'derived') {
      // Nothing to point at: the value comes from this node's other bindings. Which sum it will actually
      // do, and what it still needs to do any of them, are the useful things to say.
      const m = metric.toLowerCase();
      const rule = (state.derivations || []).find((d: any) => d.metric === m);
      const bound = (x: string) => sources.some((o: any) => o !== src
        && (o.Type || 'mqtt').toLowerCase() !== 'derived'
        && (o.Metric || 'realpower').toLowerCase() === x);
      // An operand may itself be worked out, so "have I got it" is asked the same way the backend asks.
      const have = (x: string, seen: Set<string> = new Set()): boolean => {
        if (bound(x)) return true;
        if (seen.has(x)) return false;
        seen.add(x);
        const r = (state.derivations || []).find((d: any) => d.metric === x);
        return (r?.from || []).some((f: any) => have(f.a, seen) && have(f.b, seen));
      };
      // Seeded with the metric being worked out, or it can be "reached" through a relation that needs
      // itself — which would offer a sum the backend will not do.
      const reach = (x: string) => have(x, new Set([m]));
      const usable = (rule?.from || []).find((f: any) => reach(f.a) && reach(f.b));
      const what = el('div', { class: 'ne-derived' });
      // A backend that does not serve the relations (an older one, mid-rollout) leaves us unable to say
      // which sum this is — but "cannot be calculated" would be a claim, and we do not have it to make.
      if (!(state.derivations || []).length) {
        what.appendChild(el('span', { class: 'desc', style: { margin: '0' }, text: 'calculated from this node’s other readings' }));
      } else if (!rule) {
        what.appendChild(el('span', { class: 'desc', style: { margin: '0' }, text: `'${metricLabel(m)}' cannot be calculated` }));
        what.appendChild(el('div', { class: 'desc', style: { margin: '2px 0 0', color: 'var(--bad)' },
          text: `These can: ${(state.derivations || []).map((d: any) => d.name).join(', ')}.` }));
      } else if (usable) {
        what.appendChild(el('span', { class: 'desc', style: { margin: '0' }, text: `= ${usable.label}` }));
        if (usable.assumes)
          what.appendChild(el('div', { class: 'desc', style: { margin: '2px 0 0', color: 'var(--warn)' }, text: `assumes ${usable.assumes}` }));
      } else {
        what.appendChild(el('span', { class: 'desc', style: { margin: '0' }, text: `= ${(rule.from[0] || {}).label || ''}` }));
        what.appendChild(el('div', { class: 'desc', style: { margin: '2px 0 0', color: 'var(--bad)' },
          text: 'Needs ' + (rule.from || []).map((f: any) => `${metricLabel(f.a)} and ${metricLabel(f.b)}`).join(', or ') + ' on this node.' }));
      }
      bodyRow.appendChild(slot('Calculated', 'source', what));
    }
    else if (type === 'emoncms' || sourceEditorFor(type) || (type !== 'mqtt' && type !== 'modbus')) {
      // Editors shared with other pages hand back two cells: which feed or setting, and what it reads.
      const make = type === 'emoncms' ? emonCmsSourceEditor : (sourceEditorFor(type) || genericSourceEditor);
      const [srcCell, detailCell] = make(src, () => refreshDirty());
      bodyRow.append(slot(type === 'emoncms' ? 'Feed' : 'Source', 'source', srcCell), slot('Details', 'details', detailCell));
    }
    else if (type === 'modbus') {
      const connections: any[] = (state.data?.Modbus?.Connections) || [];
      const connSel = el('select');
      connSel.appendChild(el('option', { value: '', text: connections.length ? '— pick a connection —' : 'none — add one in Modbus' }));
      connections.forEach((c: any) => connSel.appendChild(el('option', { value: c.Id, text: c.Name || c.Id })));
      connSel.value = src.Connection || '';
      connSel.onchange = () => { src.Connection = connSel.value || undefined; };
      const regIn = el('input', { type: 'number', value: src.Register ?? 0, class: 'ne-narrow' });
      regIn.onchange = () => { const v = +regIn.value; src.Register = !isNaN(v) ? v : 0; };
      const regTypeSel = el('select');
      MODBUS_REGISTER_TYPES.forEach(t => regTypeSel.appendChild(el('option', { value: t, text: t })));
      regTypeSel.value = src.RegisterType || 'holding';
      regTypeSel.onchange = () => { src.RegisterType = regTypeSel.value === 'holding' ? undefined : regTypeSel.value; };
      const dtSel = el('select');
      MODBUS_DATATYPES.forEach(t => dtSel.appendChild(el('option', { value: t, text: t })));
      dtSel.value = src.DataType || 'uint16';
      const woSel = el('select');
      MODBUS_WORDORDERS.forEach(t => woSel.appendChild(el('option', { value: t, text: t })));
      woSel.value = src.WordOrder || 'big';
      woSel.onchange = () => { src.WordOrder = woSel.value === 'big' ? undefined : woSel.value; };
      // Word order only matters for 32-bit types; keep it enabled only then.
      const is32 = () => ['uint32', 'int32', 'float32'].includes(dtSel.value);
      woSel.disabled = !is32();
      dtSel.onchange = () => { src.DataType = dtSel.value === 'uint16' ? undefined : dtSel.value; woSel.disabled = !is32(); };
      // Rather than guessing a register from a PDF, read the device and pick the value that looks right.
      const explore = btn('Browse…');
      explore.title = 'Read a block of registers from the device and choose one.';
      explore.onclick = () => openModbusExplorer(src, rerender);
      bodyRow.append(slot('Connection', 'source', connSel), slot('Register', 'register', regIn), slot('Bank', 'bank', regTypeSel),
        slot('Type', 'datatype', dtSel), slot('Word order', 'wordorder', woSel), slot(' ', 'browse', explore));
    } else {
      // The topic, with autocomplete off what the broker is actually carrying.
      const topicIn = el('input', { type: 'text', value: src.Topic || '', placeholder: 'solar_assistant/inverter_1/pv_power/state' }) as HTMLInputElement;
      const fieldIn = el('input', { type: 'text', value: src.JsonField || '', placeholder: 'optional', class: 'ne-narrow' }) as HTMLInputElement;
      const suggest = topicSuggester(topicIn, () => {
        src.Topic = topicIn.value.trim();
        applyTopicHint(src, topicIn.value.trim(), fieldIn, rerender);
      });
      topicIn.onchange = () => { src.Topic = topicIn.value.trim(); applyTopicHint(src, src.Topic, fieldIn, rerender); };
      const browse = btn('Browse');
      browse.title = 'Browse the topics currently on the broker and pick one.';
      browse.onclick = () => openTopicPicker(topicIn.value.trim(), picked => {
        topicIn.value = picked;
        src.Topic = picked;
        applyTopicHint(src, picked, fieldIn, rerender);
      });
      const topicRow = el('div', { class: 'ne-topic' }, topicIn, browse);
      const topicSlot = slot('Topic', 'source', topicRow, suggest.list);
      topicSlot.classList.add('ne-grow');
      fieldIn.onchange = () => { src.JsonField = fieldIn.value.trim() || undefined; };
      bodyRow.append(topicSlot, slot('JSON field', 'details', fieldIn, jsonFieldSuggester(fieldIn, () => src.Topic || '')));
    }
    card.appendChild(bodyRow);

    // How the reading is taken: only the settings that mean something for this metric.
    const opt = el('div');
    if (bidirectional && DIRECTIONAL_METRICS.includes(metric)) {
      const dirs = SIGNED_METRICS.includes(metric) ? ['out', 'in', 'split'] : ['out', 'in'];
      const dirSel = el('select');
      dirs.forEach(d => dirSel.appendChild(el('option', { value: d, text: dirLabels[d] })));
      dirSel.value = dirs.includes(src.Direction) ? src.Direction : 'out';
      dirSel.title = 'What this source measures: the node supplying or drawing. Split takes one signed value and fans it into both.';
      dirSel.onchange = () => { src.Direction = dirSel.value === 'out' ? undefined : dirSel.value; rerender(); };
      opt.appendChild(slot('Direction', 'direction', dirSel));
    }
    // Does this counter run forever, or does the device reset it every day?
    if (metric === 'energy') {
      const accSel = el('select');
      [['lifetime', 'Lifetime'], ['period', 'Daily']].forEach(([v, t]) => accSel.appendChild(el('option', { value: v, text: t })));
      accSel.value = src.Accumulation === 'period' ? 'period' : 'lifetime';
      accSel.title = 'Lifetime: a total that only rises; its daily figure is its rise since midnight. Daily: the device resets it itself.';
      accSel.onchange = () => { src.Accumulation = accSel.value === 'lifetime' ? undefined : accSel.value; refreshDirty(); };
      opt.appendChild(slot('Counter', 'counter', accSel));
    }
    // Input unit → converted to the metric's canonical unit on ingest. Store only a non-canonical choice.
    const [, , canonical, units] = metricMeta(metric);
    if (units.length > 1) {
      const unitSel = el('select');
      units.forEach((u: string) => unitSel.appendChild(el('option', { value: u, text: u || '—' })));
      unitSel.value = src.Unit || canonical;
      unitSel.onchange = () => { src.Unit = unitSel.value === canonical ? undefined : unitSel.value; };
      opt.appendChild(slot('Unit', 'unit', unitSel));
    }
    if (type !== 'derived') {
      // Scale carries the magnitude; Invert carries the sign.
      const scaleIn = el('input', { type: 'number', step: 'any', value: Math.abs(src.Scale ?? 1), class: 'ne-narrow' });
      const setScale = (magnitude: number, invert: boolean) => {
        const v = (invert ? -1 : 1) * (isNaN(magnitude) || magnitude === 0 ? 1 : Math.abs(magnitude));
        src.Scale = v === 1 ? undefined : v;
      };
      scaleIn.onchange = () => setScale(+scaleIn.value, (src.Scale ?? 1) < 0);
      opt.appendChild(slot('Scale', 'scale', scaleIn));
      // Sign only means anything where the value has a direction — power and current, not voltage/energy.
      if (SIGNED_METRICS.includes(metric)) {
        const inv = el('input', { type: 'checkbox' }) as HTMLInputElement;
        inv.checked = (src.Scale ?? 1) < 0;
        inv.onchange = () => setScale(+scaleIn.value, inv.checked);
        const s = slot('Invert', 'invert', el('span', { class: 'ne-check' }, inv, el('span', { text: 'flip sign' })));
        s.title = 'Flip the sign of this reading, for a source that publishes export or discharge the other way round.';
        opt.appendChild(s);
      }
    }
    // On one line with the source where there is room; a phone wraps it under.
    [...opt.children].forEach((c: any) => bodyRow.appendChild(c));
    list.appendChild(card);
  });
  if (sources.length) bindSec.appendChild(list);
  else bindSec.appendChild(el('div', { class: 'ne-empty', text: 'No bindings. The node is valued by its mode and what it feeds.' }));
  bindSec.appendChild(el('div', { class: 'ne-add' }, addBind));

  // Live values for every binding.
  if (liveCells.length) {
    const setCell = (cell: any, value: number | null, err?: string, metric?: string) => {
      cell.classList.remove('is-good', 'is-bad');
      if (value == null) { cell.textContent = err ? 'err' : '—'; if (err) cell.classList.add('is-bad'); cell.title = err || ('No live value yet. ' + LIVE_HINT); }
      else { const cu = metricMeta(metric)[2]; cell.textContent = `${formatNum(value)} ${cu}`.trim(); cell.classList.add('is-good'); cell.title = LIVE_HINT; }
    };
    // A Modbus device is a shared serial resource — many gateways accept only one client at a time.
    const refresh = async (probe = false) => {
      let probeMsg = '';
      if (probe) {
        const modbus = liveCells.filter(lc => (lc.src.Type || 'mqtt') === 'modbus');
        const conns: any[] = (state.data?.Modbus?.Connections) || [];
        const byConn = new Map<string, { src: any, cell: any }[]>();
        modbus.forEach(lc => { const id = lc.src.Connection || ''; (byConn.get(id) || byConn.set(id, []).get(id)!).push(lc); });
        for (const [connId, cells] of byConn) {
          const conn = conns.find(c => c.Id === connId);
          if (!conn) { cells.forEach(lc => setCell(lc.cell, null, 'pick a connection')); probeMsg = 'Pick a Modbus connection.'; continue; }
          try {
            const r = await api('/api/modbus/probe', { method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ Host: conn.Host, Port: conn.Port, UnitId: conn.UnitId, Framing: conn.Framing, TimeoutMs: conn.TimeoutMs, Items: cells.map(lc => lc.src) }) });
            if (!r.body.ok) { cells.forEach(lc => setCell(lc.cell, null, 'err')); probeMsg = r.body.message || 'probe failed'; continue; }
            const readings = r.body.readings || [];
            cells.forEach((lc, i) => setCell(lc.cell, readings[i]?.value ?? null, readings[i]?.error, lc.src.Metric));
            const firstErr = readings.find((rd: any) => rd?.error)?.error;
            if (firstErr) probeMsg = (r.body.message || '') + ' — ' + firstErr;
          } catch (e: any) { cells.forEach(lc => setCell(lc.cell, null, 'err')); probeMsg = String(e?.message || e); }
        }
      }
      // Every binding not just device-probed reads the shared live cache the running ingests fill.
      const cached = probe ? liveCells.filter(lc => (lc.src.Type || 'mqtt') !== 'modbus') : liveCells;
      if (cached.length) {
        try {
          const reqs: any[] = [];
          const plan = cached.map(lc => {
            const m = lc.src.Metric || 'realpower';
            if (lc.src.Direction === 'split') { const i0 = reqs.length; reqs.push({ Node: node.Id, Metric: m }, { Node: node.Id, Metric: m + '#in' }); return { lc, split: true, i0 }; }
            const i0 = reqs.length; reqs.push({ Node: node.Id, Metric: sourceMetricKey(lc.src) }); return { lc, split: false, i0 };
          });
          const r = await api('/api/flow/live', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(reqs) });
          const vals = (r.body && r.body.values) || [];
          plan.forEach(p => {
            if (p.split) {
              const o = vals[p.i0]?.value, iv = vals[p.i0 + 1]?.value;
              setCell(p.lc.cell, (o == null && iv == null) ? null : (o || 0) - (iv || 0), undefined, p.lc.src.Metric);
            } else setCell(p.lc.cell, vals[p.i0]?.value ?? null, undefined, p.lc.src.Metric);
          });
        } catch (e: any) { cached.forEach(lc => setCell(lc.cell, null, 'err')); }
      }
      liveStatus.textContent = probeMsg || `live · ${new Date().toLocaleTimeString()}`;
      liveStatus.classList.toggle('is-bad', !!probeMsg);
    };
    const hasModbus = liveCells.some(lc => (lc.src.Type || 'mqtt') === 'modbus');
    const refreshBtn = btn(hasModbus ? 'Test device read' : 'Refresh values', 'small');
    if (hasModbus) refreshBtn.title = 'Open a one-off connection to the device to test these bindings. The worker polls it anyway — avoid hammering a gateway that allows only one client.';
    refreshBtn.onclick = () => refresh(true);
    liveSlot.append(liveStatus, refreshBtn);
    refresh(false);
    // Self-cleaning: once this editor is replaced/closed its box leaves the DOM and the poll stops.
    const timer = setInterval(() => { if (!document.body.contains(box)) { clearInterval(timer); return; } refresh(false); }, 2000);
  }

  // --- Feeders & children (wiring) — the parent/child specification, alongside the visual Flow tab. ---
  const wireSec = section('Feeders & children');
  wireSec.appendChild(el('div', { class: 'desc ne-desc', text: 'Same wiring as the Flow tab. A load cannot feed anything.' }));

  const nm = (id: string) => (cand.get(id) || {}).label || id;
  const addLink = (from: string, to: string) => {
    if (from === to || links.some(l => l.From === from && l.To === to)) return;
    if (wouldLoop(links, from, to)) { toast('That would create a feeder loop.', false); return; }
    // A panel is fed from one place. Two feeders split its power across both on the diagram and count a
    // supply that is not there, so the second one is refused rather than quietly wired.
    const already = (cand.get(to) || {}).kind === 'panel' ? links.find(l => l.To === to) : null;
    if (already) { toast(`${nm(to)} is a panel, and a panel is fed from one place — it is already fed by ${nm(already.From)}. Drop that first.`, false); return; }
    links.push({ From: from, To: to });
  };
  const removeLink = (from: string, to: string) => { const i = links.findIndex(l => l.From === from && l.To === to); if (i >= 0) links.splice(i, 1); };
  const wireRow = (title: string, current: string[], onAdd: (o: string) => void, onRemove: (o: string) => void, offer: (id: string) => boolean = () => true) => {
    const row = el('div', { class: 'ne-wire' });
    row.appendChild(el('span', { class: 'ne-wire-label', text: title }));
    const chips = el('div', { class: 'ne-wire-chips' });
    current.forEach(other => {
      const chip = el('span', { class: 'ne-chip' });
      const x = el('button', { class: 'ne-chip-x', type: 'button', text: '✕', title: `Remove ${nm(other)}` });
      x.onclick = () => { onRemove(other); rerender(); };
      chip.append(nm(other), x); chips.appendChild(chip);
    });
    if (!current.length) chips.appendChild(el('span', { class: 'ne-none', text: 'none' }));
    // The picker lists every node in the hierarchy, which on a real install is hundreds of outlets.
    const options = [...cand.keys()].filter(id => id !== node.Id && !current.includes(id) && offer(id)).sort((a, b) => nm(a).localeCompare(nm(b)));
    const search = el('input', { type: 'search', placeholder: 'search…', class: 'ne-wire-search' }) as HTMLInputElement;
    const sel = el('select', { class: 'ne-wire-pick' }) as HTMLSelectElement;
    const matches = () => {
      const f = (search.value || '').trim().toLowerCase();
      return f ? options.filter(id => (id + ' ' + nm(id)).toLowerCase().includes(f)) : options;
    };
    const fill = () => {
      const m = matches();
      sel.innerHTML = '';
      sel.appendChild(el('option', { value: '', text: m.length ? `+ add… (${m.length})` : 'no match' }));
      m.forEach(id => sel.appendChild(el('option', { value: id, text: nm(id) })));
    };
    search.oninput = fill;
    search.onkeydown = (e: any) => {
      if (e.key !== 'Enter') return;
      const m = matches();
      if (m.length === 1) { onAdd(m[0]); rerender(); }
    };
    fill();
    sel.onchange = () => { if (sel.value) { onAdd(sel.value); rerender(); } };
    row.append(chips, el('div', { class: 'ne-wire-add' }, search, sel));
    return row;
  };
  wireSec.appendChild(wireRow('Fed by', links.filter(l => l.To === node.Id).map(l => l.From), o => addLink(o, node.Id), o => removeLink(o, node.Id),
    id => !feedsNothing((cand.get(id) || {}).kind)));
  wireSec.appendChild(wireRow('Feeds', links.filter(l => l.From === node.Id).map(l => l.To), o => addLink(node.Id, o), o => removeLink(node.Id, o)));

  // --- Filing: tags, where it is, and where its EmonCMS feeds go. Folded until something is set. ---
  const more = el('details', { class: 'ne-more' }) as HTMLDetailsElement;
  const filed = [(node.Tags || []).length, node.Location, node.Circuit, node.EmonCmsTag, node.EmonCmsVirtualTag].filter(Boolean).length;
  more.open = filed > 0 || nodeEditorFilingOpen;
  more.addEventListener('toggle', () => { nodeEditorFilingOpen = more.open; });
  more.appendChild(el('summary', { class: 'ne-more-summary' },
    el('span', { text: 'Tags, location & EmonCMS' }),
    el('span', { class: 'ne-count', text: filed ? `${filed} set` : '' })));
  const moreGrid = el('div', { class: 'node-editor-fields' });

  // Tags (#342). Every kind can be tagged — a panel or a plain node is exactly the sort of thing an
  // export filter names.
  const tags = ensure(node, 'Tags', []);
  moreGrid.appendChild(field('Tags', tagInput(tags, {
    placeholder: 'critical, rack-1',
    onChange: () => { if (!tags.length) node.Tags = undefined; rerender(); },
  }), 'Filter, highlight and export by tag. Never changes a reading.'));

  // Where it is and which circuit it is plugged into (#461, #465).
  const locSel = choiceSelect(locationChoices(), node.Location || '', '— not placed —');
  locSel.onchange = () => { node.Location = locSel.value || undefined; };
  moreGrid.appendChild(field('Location', locSel, 'Counted there on Floor Plans.'));
  const circSel = choiceSelect(circuitChoices(), node.Circuit || '', '— not known —');
  circSel.onchange = () => { node.Circuit = circSel.value || undefined; };
  moreGrid.appendChild(field('Circuit', circSel, 'Breaker it is on. Counted among its metered devices.'));

  // Where this node's EmonCMS feeds are filed; blank uses the EmonCMS page's tags.
  const emonTag = el('input', { type: 'text', value: node.EmonCmsTag || '', placeholder: 'EmonCMS default' }) as HTMLInputElement;
  emonTag.onchange = () => { node.EmonCmsTag = emonTag.value.trim() || undefined; };
  // Previewed with this node's own id, label and kind: the tag it will actually get.
  const nodeVars = { node: node.Id, label: node.Label || node.Id, kind: node.Kind || 'node' };
  const emonTagField = field('EmonCMS tag', emonTag);
  emonTagField.appendChild(templateHelp(emonTag, ['node', 'label', 'kind'], { examples: nodeVars, whenBlank: 'EmonCMS page default' }));
  emonTagField.classList.add('ne-wide');
  moreGrid.appendChild(emonTagField);
  const emonVirtualTag = el('input', { type: 'text', value: node.EmonCmsVirtualTag || '', placeholder: 'EmonCMS default' }) as HTMLInputElement;
  emonVirtualTag.onchange = () => { node.EmonCmsVirtualTag = emonVirtualTag.value.trim() || undefined; };
  const emonVirtualField = field('EmonCMS virtual-feed tag', emonVirtualTag);
  emonVirtualField.appendChild(templateHelp(emonVirtualTag, ['node', 'label', 'kind'], { examples: nodeVars, whenBlank: 'EmonCMS page default' }));
  emonVirtualField.classList.add('ne-wide');
  moreGrid.appendChild(emonVirtualField);
  more.appendChild(moreGrid);
  box.appendChild(more);

  return box;
}

/// Whether the filing section was left open, so a redraw after an edit inside it does not fold it away.
let nodeEditorFilingOpen = false;
