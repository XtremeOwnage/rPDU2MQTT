// Locations: the site › floor › room/area tree, each place's totals, nodes and climate, and Home Assistant sync.

type LocPlace = {
  id: string; name: string; kind: string; site: string; floor: string | null; value: number | null; state: string;
  nodes: { id: string; label: string }[]; missing: { id: string; label: string }[]; split: { id: string; label: string }[];
  temperature?: number | null; humidity?: number | null;
};
type LocNode = { id: string; label: string; kind: string; value: number | null; location: string | null; via: string | null };
type LocSensor = { id: string; name: string; temperature: number | null; humidity: number | null };
type LocLive = { places: LocPlace[]; nodes: LocNode[]; sensors?: LocSensor[]; units: string; problems: string[]; message: string | null };

const LOC_STATE: Record<string, string> = { unmetered: 'Nothing metered here yet.', unknown: 'A reading is missing.' };
const LOC_TEMP = 'temperature', LOC_HUM = 'percent';
const LOC_VIA: Record<string, string> = { own: 'Node', rule: 'Rule', placement: 'Floor plan', circuit: 'Circuit' };
const LOC_SYNC: [string, string, [string, string][], string][] = [
  ['Areas', 'Rooms → areas', [['create', 'Create and update'], ['update', 'Update linked only'], ['off', 'Off']], 'create'],
  ['Floors', 'Floors → floors', [['create', 'Create and update'], ['update', 'Update linked only'], ['off', 'Off']], 'off'],
  ['DeviceAreas', 'Device areas', [['unset-only', 'Devices with no area'], ['off', 'Off']], 'unset-only'],
  ['AreaSensors', 'Area sensors', [['fill', 'Only when unset'], ['always', 'Always'], ['off', 'Off']], 'off'],
  ['Schedule', 'Publish', [['manual', 'Manually'], ['on-change', 'When config changes'], ['interval', 'On an interval']], 'manual'],
];

export default function mount(sec: any, host: any) {
  ({ api, btn, el, ensure, toast, state, refreshDirty, formatMeasure, searchSelect, openSheet, closeSheet } = host);
  const fmtTemp = (c: number) => host.temp?.fmt ? host.temp.fmt(c, 1) : `${c} °C`;
  sec.classList.add('loc');

  const locIn = () => ensure(ensure(state.data, 'Plugins', {}), 'locations', {});
  const sitesIn = (): any[] => ensure(locIn(), 'Sites', []);
  const rulesIn = (): any[] => ensure(locIn(), 'AutoLocations', []);
  const haIn = () => ensure(locIn(), 'HomeAssistant', {});
  const sensorsIn = (): any[] => ensure(locIn(), 'Sensors', []);
  const flowNodes = (): any[] => ensure(ensure(state.data, 'EnergyFlow', {}), 'Nodes', []);
  const onScreen = () => JSON.stringify({ EnergyFlow: state.data?.EnergyFlow || {}, Plugins: { locations: locIn() } });

  type Ref = { kind: string; obj: any; list: any[]; site: any; floor: any };
  const refs = (): Ref[] => sitesIn().flatMap((s: any) => [
    { kind: 'site', obj: s, list: sitesIn(), site: s, floor: null },
    ...ensure(s, 'Floors', []).flatMap((f: any) => [
      { kind: 'floor', obj: f, list: s.Floors, site: s, floor: f },
      ...ensure(f, 'Rooms', []).map((r: any) => ({ kind: 'room', obj: r, list: f.Rooms, site: s, floor: f })),
      ...ensure(f, 'Areas', []).map((a: any) => ({ kind: 'area', obj: a, list: f.Areas, site: s, floor: f })),
    ]),
  ]);
  const refOf = (id: string | null) => id ? refs().find(r => r.obj.Id === id) || null : null;
  const label = (o: any) => o?.Name || o?.Id || '';
  const nameOf = (id: string | null) => { const r = refOf(id); return r ? label(r.obj) : (id || ''); };
  const within = (loc: string | null, place: string) => {
    if (!loc) return false;
    if (loc === place) return true;
    const p = refOf(place), l = refOf(loc);
    if (!p || !l) return false;
    if (p.kind === 'site') return l.site === p.obj;
    if (p.kind === 'floor') return l.floor === p.obj && l.kind !== 'floor';
    if (p.kind === 'area') return l.kind === 'room' && (p.obj.Rooms || []).includes(loc);
    return false;
  };
  const freshId = (base: string) => {
    const stem = (base || 'place').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'place';
    const taken = new Set(refs().map(r => r.obj.Id));
    let id = stem, n = 2;
    while (taken.has(id)) id = `${stem}_${n++}`;
    return id;
  };

  let selected = '';
  let live: LocLive | null = null;
  let today: LocLive | null = null;
  const fresh = new WeakSet<any>();

  const changed = () => { refreshDirty(); render(); schedule(); };
  let timer: any = null;
  const schedule = () => { clearTimeout(timer); timer = setTimeout(load, 400); };
  const call = async (query: string) => {
    const r: any = await api(`/api/integrations/locations/totals${query}`, { method: 'POST', body: onScreen() });
    const b = r?.body || {};
    return b.ok && b.result ? b.result : null;
  };
  const load = async () => {
    try { [live, today] = await Promise.all([call(''), call('?period=today')]); } catch { live = today = null; }
    render();
  };

  const publish = btn('Publish to Home Assistant…');
  publish.onclick = () => haPublishSheet(async (action: string) => {
    const r: any = await api(`/api/integrations/locations/${action}`, { method: 'POST', body: onScreen() });
    const b = r?.body || {};
    return { body: b.ok && b.result ? b.result : b };
  }, (rooms, floors) => {
    for (const r of refs()) {
      if (r.kind === 'room' && rooms[r.obj.Id]) r.obj.HaArea = rooms[r.obj.Id];
      if (r.kind === 'floor' && floors[r.obj.Id]) r.obj.HaFloor = floors[r.obj.Id];
    }
    changed();
  });
  sec.appendChild(el('div', { class: 'loc-head' },
    el('div', {}, el('h2', { text: 'Locations' }), el('div', { class: 'desc', text: 'Sites, floors, rooms and areas, and which nodes are in each.' })),
    publish));

  const tree = el('div', { class: 'loc-tree' });
  const sync = el('div', { class: 'loc-card loc-sync' });
  const sensorsCard = el('div', { class: 'loc-card loc-sensors' });
  const detail = el('div', { class: 'loc-detail' });
  sec.appendChild(el('div', { class: 'loc-body' }, el('div', { class: 'loc-side' }, tree, sensorsCard, sync), detail));

  const fmt = (v: number | null | undefined, units?: string) => v == null ? '—' : formatMeasure(Math.round(v * 100) / 100, units);
  const placeLive = (src: LocLive | null, id: string) => src?.places?.find(p => p.id === id) || null;
  const nodesOf = () => live?.nodes || [];

  function render() {
    if (!refOf(selected)) selected = refs()[0]?.obj.Id || '';
    renderTree(); renderDetail(); renderSensors(); renderSync();
  }

  function addPlace(kind: string, into: any[], extra: any = {}) {
    const id = freshId(kind);
    const place = { Id: id, Name: 'New ' + kind, ...extra };
    fresh.add(place); into.push(place);
    selected = id; changed();
  }

  function renderTree() {
    tree.innerHTML = '';
    for (const r of refs()) {
      const p = placeLive(live, r.obj.Id);
      const row = el('button', { class: `loc-row loc-${r.kind}` + (r.obj.Id === selected ? ' is-on' : '') + (p?.value == null ? ' is-empty' : ''), type: 'button' },
        el('span', { class: 'loc-name', text: label(r.obj) }),
        r.kind === 'area' ? el('span', { class: 'loc-tag', text: 'area' }) : null,
        el('span', { class: 'loc-val', text: p?.value == null ? '' : fmt(p.value, live?.units) }));
      row.onclick = () => { selected = r.obj.Id; render(); };
      tree.appendChild(row);
    }
    if (!sitesIn().length) tree.appendChild(el('div', { class: 'desc loc-none', text: 'Start with a site, then add its floors and rooms.' }));
    const addSite = btn('+ Site', sitesIn().length ? '' : 'primary');
    addSite.onclick = () => {
      const first = !sitesIn().length;
      const site = { Id: freshId(first ? 'home' : 'site'), Name: first ? 'Home' : 'New site', Floors: [] };
      fresh.add(site); sitesIn().push(site);
      selected = site.Id; changed();
    };
    tree.appendChild(el('div', { class: 'loc-tree-foot' }, addSite));
    if (live?.problems?.length) tree.appendChild(el('div', { class: 'loc-problems' }, ...live.problems.map(t => el('div', { text: '⚠ ' + t }))));
  }

  const card = (title: string, ...extra: any[]) => {
    const c = el('div', { class: 'loc-card' }, el('div', { class: 'loc-card-head' }, el('h4', { text: title }), ...extra));
    detail.appendChild(c);
    return c;
  };
  const field = (name: string, input: any, hint?: string) => el('label', { class: 'loc-field' }, el('span', { text: name }), input, hint ? el('small', { class: 'desc', text: hint }) : null);
  const text = (v: string, set: (v: string) => void, placeholder = '') => {
    const i = el('input', { type: 'text', value: v || '', placeholder });
    i.onchange = () => { set(i.value.trim()); changed(); };
    return i;
  };
  const remove = (onclick: () => void) => {
    const b = btn('×');
    b.title = 'Remove'; b.classList.add('loc-x');
    b.onclick = onclick;
    return b;
  };

  function renderDetail() {
    detail.innerHTML = '';
    const r = refOf(selected);
    if (!r) { detail.appendChild(el('div', { class: 'loc-empty' }, el('h3', { text: 'No places yet' }), el('div', { class: 'desc', text: 'Add a site on the left to begin.' }))); return; }
    const o = r.obj;

    const actions = el('div', { class: 'loc-actions' });
    if (r.kind === 'site') { const b = btn('+ Floor'); b.onclick = () => addPlace('floor', ensure(o, 'Floors', []), { Level: o.Floors?.length || 0 }); actions.appendChild(b); }
    if (r.kind === 'floor') {
      const room = btn('+ Room'), area = btn('+ Area');
      room.onclick = () => addPlace('room', ensure(o, 'Rooms', []));
      area.onclick = () => addPlace('area', ensure(o, 'Areas', []), { Rooms: [] });
      room.title = 'A room with walls'; area.title = 'A group of rooms, such as an open plan';
      actions.append(room, area);
    }
    const move = (d: number) => {
      const at = r.list.indexOf(o), to = at + d;
      if (to < 0 || to >= r.list.length) return;
      r.list.splice(at, 1); r.list.splice(to, 0, o);
      changed();
    };
    if (r.kind !== 'floor' && r.list.length > 1) {
      const up = btn('↑'), down = btn('↓');
      up.title = 'Move up'; down.title = 'Move down';
      up.onclick = () => move(-1); down.onclick = () => move(1);
      actions.append(up, down);
    }
    const del = btn('Delete', 'danger');
    del.onclick = () => {
      const inner = r.kind === 'site' || r.kind === 'floor' ? refs().filter(x => x.obj !== o && within(x.obj.Id, o.Id)) : [];
      if (!confirm(`Delete ${label(o)}${inner.length ? ` and ${inner.length} place(s) in it` : ''}?`)) return;
      forget([o.Id, ...inner.map(x => x.obj.Id)]);
      r.list.splice(r.list.indexOf(o), 1);
      selected = (r.floor && r.floor !== o ? r.floor.Id : r.kind === 'floor' ? r.site.Id : '') || ''; changed();
    };
    actions.appendChild(del);

    const path = [r.floor && r.floor !== o ? label(r.floor) : '', r.site !== o ? label(r.site) : ''].filter(Boolean).join(' · ');
    detail.appendChild(el('div', { class: 'loc-top' },
      el('div', { class: 'loc-title' }, el('h3', { text: label(o) }), el('span', { class: 'loc-chip', text: r.kind }), path ? el('span', { class: 'loc-path', text: path }) : null),
      actions));

    const p = placeLive(live, o.Id), t = placeLive(today, o.Id);
    const stat = (name: string, value: string, cls = '') => el('div', { class: 'loc-stat ' + cls }, el('span', { text: name }), el('strong', { text: value }));
    const stats = el('div', { class: 'loc-stats' },
      stat('Now', p ? fmt(p.value, live?.units) : '—'),
      stat('Today', t ? fmt(t.value, today?.units) : '—'));
    if (p?.temperature != null) stats.appendChild(stat('Temperature', fmtTemp(p.temperature)));
    if (p?.humidity != null) stats.appendChild(stat('Humidity', `${Math.round(p.humidity)} %`));
    detail.appendChild(stats);
    const notes = [p && p.value == null ? LOC_STATE[p.state] : '', p?.missing?.length ? 'Missing: ' + p.missing.map(n => n.label).join(', ') : '',
      p?.split?.length ? 'Split: ' + p.split.map(n => n.label).join(', ') : ''].filter(Boolean);
    if (notes.length) detail.appendChild(el('div', { class: 'loc-notes desc' }, ...notes.map(n => el('div', { text: n }))));

    const settings = card('Settings');
    const grid = el('div', { class: 'loc-grid' });
    grid.appendChild(field('Name', text(o.Name, v => {
      o.Name = v;
      if (!fresh.has(o) || !v) return;
      const old = o.Id;
      o.Id = ''; o.Id = freshId(v);
      remap(id => id === old ? o.Id : null);
      selected = o.Id;
    })));
    if (r.kind === 'floor') {
      const lvl = el('input', { type: 'number', value: String(o.Level ?? 0), step: '1' });
      lvl.onchange = () => { o.Level = Number(lvl.value) || 0; changed(); };
      grid.appendChild(field('Level', lvl));
      grid.appendChild(field('Home Assistant floor', text(o.HaFloor, v => { o.HaFloor = v; }, 'Set by Publish')));
    }
    if (r.kind === 'room') grid.appendChild(field('Home Assistant area', text(o.HaArea, v => { o.HaArea = v; }, 'Set by Publish')));
    settings.appendChild(grid);
    if (r.kind === 'area') {
      const box = el('div', { class: 'loc-chips' });
      for (const room of r.floor.Rooms || []) {
        const on = (o.Rooms || []).includes(room.Id);
        const chip = el('button', { type: 'button', class: 'loc-pickchip' + (on ? ' is-on' : ''), text: label(room) });
        chip.onclick = () => {
          const list = ensure(o, 'Rooms', []), at = list.indexOf(room.Id);
          at < 0 ? list.push(room.Id) : list.splice(at, 1);
          changed();
        };
        box.appendChild(chip);
      }
      if (!(r.floor.Rooms || []).length) box.appendChild(el('span', { class: 'desc', text: `${label(r.floor)} has no rooms yet.` }));
      settings.appendChild(field('Rooms in this area', box));
    }

    renderNodes(r);
    if (r.kind === 'room' || r.kind === 'area') renderClimate(o, r.kind);
    renderRules(o);
  }

  function renderNodes(r: Ref) {
    const o = r.obj;
    const add = btn('Add nodes…', 'primary');
    add.onclick = () => pickNodes(o);
    const c = card('Nodes', add);
    const nodes = nodesOf().filter(n => within(n.location, o.Id));
    if (!nodes.length) { c.appendChild(el('div', { class: 'desc', text: live ? 'No nodes here yet.' : 'Loading…' })); return; }
    const showPlace = r.kind !== 'room';
    const table = el('table', { class: 'loc-table' }, el('thead', {}, el('tr', {},
      el('th', { text: 'Node' }), showPlace ? el('th', { text: 'Place' }) : null, el('th', { text: 'Placed by' }), el('th', { class: 'num', text: 'Now' }), el('th', {}))));
    const tb = el('tbody');
    for (const n of nodes) {
      const direct = n.location === o.Id;
      const canRemove = direct && (n.via === 'own' || (n.via === 'rule' && !!exactRule(n.id)));
      tb.appendChild(el('tr', { class: 'loc-member' + (direct ? '' : ' is-inherited') },
        el('td', { text: n.label }),
        showPlace ? el('td', { class: 'loc-via', text: direct ? '' : nameOf(n.location) }) : null,
        el('td', { class: 'loc-via', text: LOC_VIA[n.via || ''] || '' }),
        el('td', { class: 'num', text: fmt(n.value, live?.units) }),
        el('td', { class: 'loc-cell-x' }, canRemove ? remove(() => { unassign(n.id); changed(); }) : null)));
    }
    table.appendChild(tb);
    c.appendChild(table);
  }

  function pickNodes(o: any) {
    const chosen = new Set<string>();
    const body = el('div', { class: 'loc-pick' });
    const q = el('input', { type: 'search', placeholder: 'Filter nodes' });
    const list = el('div', { class: 'loc-pick-list' });
    const go = btn('Add', 'primary');
    const all = nodesOf().filter(n => n.location !== o.Id)
      .sort((a, b) => Number(!!a.location) - Number(!!b.location) || a.label.localeCompare(b.label));
    const draw = () => {
      list.innerHTML = '';
      const f = q.value.trim().toLowerCase();
      const shown = all.filter(n => !f || n.label.toLowerCase().includes(f) || n.id.toLowerCase().includes(f) || nameOf(n.location).toLowerCase().includes(f));
      for (const n of shown) {
        const cb = el('input', { type: 'checkbox', checked: chosen.has(n.id) });
        cb.onchange = () => { cb.checked ? chosen.add(n.id) : chosen.delete(n.id); count(); };
        list.appendChild(el('label', { class: 'loc-pick-row' }, cb, el('span', { text: n.label }),
          el('span', { class: 'loc-via', text: n.location ? `in ${nameOf(n.location)}` : 'not placed' })));
      }
      if (!shown.length) list.appendChild(el('div', { class: 'desc', text: 'No matching nodes.' }));
    };
    const count = () => { go.textContent = chosen.size ? `Add ${chosen.size} to ${label(o)}` : 'Add'; go.disabled = !chosen.size; };
    q.oninput = draw;
    go.onclick = () => {
      for (const id of chosen) assignTo(id, o.Id);
      toast(`Added ${chosen.size} node(s) to ${label(o)}.`, true);
      closeSheet(); changed();
    };
    body.append(q, list, el('div', { class: 'loc-pick-foot' }, go));
    draw(); count();
    openSheet({ title: `Add nodes to ${label(o)}`, body });
  }

  function renderClimate(o: any, kind: string) {
    const c = card('Climate');
    const cl = ensure(o, 'Climate', {});
    const labelOf = (id: string) => label(sensorsIn().find(x => x.Id === id)) || nodesOf().find(n => n.id === id)?.label || id;
    for (const key of ['Temperature', 'Humidity']) {
      const list: string[] = ensure(cl, key, []);
      const box = el('div', { class: 'loc-chips' });
      for (const id of list) box.appendChild(el('span', { class: 'loc-sensor' }, el('span', { text: labelOf(id) }), remove(() => { list.splice(list.indexOf(id), 1); changed(); })));
      const rest = [...sensorsIn().filter(x => x.Id && !list.includes(x.Id)).map(x => ({ value: x.Id, label: label(x) })),
        ...nodesOf().filter(n => !list.includes(n.id)).map(n => ({ value: n.id, label: `${n.label} (node)` }))];
      if (rest.length) box.appendChild(searchSelect([{ value: '', label: `+ ${key.toLowerCase()} sensor` }, ...rest],
        '', (v: string) => { if (v) { list.push(v); changed(); } }, { placeholder: 'Search nodes…' }));
      c.appendChild(field(key, box, !list.length && kind === 'area' ? 'None: uses its rooms.' : undefined));
    }
    const how = el('select', {}, ...[['average', 'Average'], ['first', 'First'], ['min', 'Lowest'], ['max', 'Highest']]
      .map(([v, t]) => el('option', { value: v, text: t, selected: (cl.Combine || 'average') === v })));
    how.onchange = () => { cl.Combine = how.value; changed(); };
    c.appendChild(field('With more than one sensor', how));
  }

  function renderRules(o: any) {
    const add = btn('+ Rule');
    add.onclick = () => { rulesIn().push({ Match: '', Location: o.Id }); changed(); };
    const c = card('Rules', add);
    const rules = rulesIn().filter(x => x.Location === o.Id);
    if (!rules.length) { c.appendChild(el('div', { class: 'desc', text: 'Place every node whose id matches a pattern, such as outlet:rack1:*' })); return; }
    for (const rule of rules) {
      const hits = nodesOf().filter(n => n.location === o.Id && n.via === 'rule' && matches(rule.Match, n.id)).length;
      c.appendChild(el('div', { class: 'loc-rule' },
        text(rule.Match, v => { rule.Match = v; }, 'Node id, * matches anything'),
        el('span', { class: 'loc-via', text: `${hits} node${hits === 1 ? '' : 's'}` }),
        remove(() => { rulesIn().splice(rulesIn().indexOf(rule), 1); changed(); })));
    }
  }

  function renderSensors() {
    sensorsCard.innerHTML = '';
    const add = btn('+ Sensor');
    add.onclick = () => editSensor(null);
    sensorsCard.appendChild(el('div', { class: 'loc-card-head' }, el('h4', { text: 'Sensors' }), add));
    const list = sensorsIn();
    if (!list.length) { sensorsCard.appendChild(el('div', { class: 'desc', text: 'Thermometers and humidity sensors for room climate.' })); return; }
    for (const x of list) {
      const v = live?.sensors?.find(s => s.id === x.Id);
      const reading = [v?.temperature != null ? fmtTemp(v.temperature) : '', v?.humidity != null ? `${Math.round(v.humidity)} %` : ''].filter(Boolean).join(' · ');
      const row = el('button', { type: 'button', class: 'loc-row loc-sensor-row' + (reading ? '' : ' is-empty') },
        el('span', { class: 'loc-name', text: label(x) }), el('span', { class: 'loc-val', text: reading }));
      row.onclick = () => editSensor(x);
      sensorsCard.appendChild(row);
    }
  }

  /// One reading of a sensor: its source type, topic and field, or entity.
  const SENSOR_TYPES: [string, string][] = [['', 'None'], ['mqtt', 'MQTT topic'], ['homeassistant', 'Home Assistant entity']];
  function editSensor(x: any) {
    const isNew = !x;
    const draft: any = x ? JSON.parse(JSON.stringify(x)) : { Id: '', Name: '', Sources: [] };
    const body = el('div', { class: 'loc-sensor-edit' });
    const name = el('input', { type: 'text', value: draft.Name || '', placeholder: 'Garage' });
    body.appendChild(field('Name', name));
    const parts: (() => any)[] = [];
    for (const [metric, title] of [[LOC_TEMP, 'Temperature'], [LOC_HUM, 'Humidity']]) {
      const src = (draft.Sources || []).find((s: any) => s.Metric === metric) || {};
      const type = el('select', {}, ...SENSOR_TYPES.map(([v, t]) => el('option', { value: v, text: t, selected: (src.Type || '') === v })));
      const topic = el('input', { type: 'text', value: src.Topic || '', placeholder: 'rtl_433/Acurite-Tower/326' });
      const json = el('input', { type: 'text', value: src.JsonField || '', placeholder: metric === LOC_TEMP ? 'temperature_C' : 'humidity' });
      const entity = el('input', { type: 'text', value: src.Settings?.Entity || '', placeholder: 'sensor.garage_temperature' });
      const mqttRow = el('div', { class: 'loc-grid' }, field('Topic', topic), field('JSON field', json));
      const haRow = el('div', { class: 'loc-grid' }, field('Entity', entity));
      const show = () => { mqttRow.hidden = type.value !== 'mqtt'; haRow.hidden = type.value !== 'homeassistant'; };
      type.onchange = show; show();
      body.appendChild(el('div', { class: 'loc-card' }, el('div', { class: 'loc-card-head' }, el('h4', { text: title }), type), mqttRow, haRow));
      parts.push(() => {
        if (type.value === 'mqtt' && topic.value.trim()) return { ...src, Type: 'mqtt', Metric: metric, Topic: topic.value.trim(), JsonField: json.value.trim() || undefined };
        if (type.value === 'homeassistant' && entity.value.trim()) return { ...src, Type: 'homeassistant', Metric: metric, Topic: '', Settings: { ...(src.Settings || {}), Entity: entity.value.trim() } };
        return null;
      });
    }
    const save = btn(isNew ? 'Add sensor' : 'Save', 'primary');
    save.onclick = () => {
      const n = name.value.trim();
      if (!n) { toast('Give the sensor a name.', false); return; }
      const others = (draft.Sources || []).filter((s: any) => s.Metric !== LOC_TEMP && s.Metric !== LOC_HUM);
      const sources = [...others, ...parts.map(p => p()).filter(Boolean)];
      if (isNew) {
        const taken = new Set(sensorsIn().map(s => s.Id));
        const stem = n.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'sensor';
        let id = stem, i = 2;
        while (taken.has(id)) id = `${stem}_${i++}`;
        sensorsIn().push({ Id: id, Name: n, Sources: sources });
      } else { x.Name = n; x.Sources = sources; }
      closeSheet(); changed();
    };
    const foot = el('div', { class: 'loc-pick-foot' });
    if (!isNew) {
      const del = btn('Delete', 'danger');
      del.onclick = () => {
        if (!confirm(`Delete ${label(x)}?`)) return;
        sensorsIn().splice(sensorsIn().indexOf(x), 1);
        for (const r of refs()) for (const k of ['Temperature', 'Humidity']) {
          const l = r.obj.Climate?.[k];
          if (Array.isArray(l)) r.obj.Climate[k] = l.filter((id: string) => id !== x.Id);
        }
        closeSheet(); changed();
      };
      foot.appendChild(del);
    }
    foot.appendChild(save);
    body.appendChild(foot);
    openSheet({ title: isNew ? 'Add sensor' : label(x), body });
  }

  function renderSync() {
    sync.innerHTML = '';
    sync.appendChild(el('div', { class: 'loc-card-head' }, el('h4', { text: 'Home Assistant' })));
    const ha = haIn();
    for (const [key, name, opts, def] of LOC_SYNC) {
      const s = el('select', { 'data-key': key }, ...opts.map(([v, t]) => el('option', { value: v, text: t, selected: (ha[key] || def) === v })));
      s.onchange = () => { ha[key] = s.value; changed(); };
      sync.appendChild(field(name, s));
    }
    if ((ha.Schedule || 'manual') === 'interval') {
      const mins = el('input', { type: 'number', min: '5', max: '10080', step: '5', value: String(ha.IntervalMinutes ?? 60) });
      mins.onchange = () => { ha.IntervalMinutes = Math.min(10080, Math.max(5, Number(mins.value) || 60)); changed(); };
      sync.appendChild(field('Every (minutes)', mins));
    }
  }

  const matches = (pattern: string, id: string) => {
    const re = new RegExp('^' + (pattern || '').trim().split('*').map(s => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$', 'i');
    return re.test(id);
  };
  const exactRule = (id: string) => rulesIn().find(r => !(r.Match || '').includes('*') && (r.Match || '').trim().toLowerCase() === id.toLowerCase());
  const configNode = (id: string) => flowNodes().find(n => (n.Id || '').toLowerCase() === id.toLowerCase());

  function assignTo(id: string, place: string) {
    const n = configNode(id);
    if (n) { ensure(ensure(n, 'Ext', {}), 'locations', {}).Location = place; return; }
    const r = exactRule(id);
    if (r) r.Location = place; else rulesIn().push({ Match: id, Location: place });
  }

  function unassign(id: string) {
    const n = configNode(id);
    if (n?.Ext?.locations) n.Ext.locations.Location = '';
    const r = exactRule(id);
    if (r) rulesIn().splice(rulesIn().indexOf(r), 1);
  }

  /// Rewrites every reference to a place: `to` returns the new id, or '' to drop it.
  function remap(to: (id: string) => string | null) {
    const swap = (v: string) => { const n = v ? to(v) : null; return n == null ? v : n; };
    for (const n of flowNodes()) if (n?.Ext?.locations?.Location) n.Ext.locations.Location = swap(n.Ext.locations.Location);
    const rules = rulesIn();
    for (let i = rules.length - 1; i >= 0; i--) { rules[i].Location = swap(rules[i].Location); if (!rules[i].Location) rules.splice(i, 1); }
    for (const r of refs()) if (r.kind === 'area') r.obj.Rooms = (r.obj.Rooms || []).map(swap).filter(Boolean);
    for (const it of ensure(locIn(), 'Placements', [])) { it.Room = swap(it.Room || ''); it.Floor = swap(it.Floor || ''); }
    for (const p of ensure(ensure(state.data, 'EnergyFlow', {}), 'Panels', [])) {
      if (p?.Ext?.locations?.Location) p.Ext.locations.Location = swap(p.Ext.locations.Location);
      for (const b of p.Breakers || []) if (b?.Ext?.locations?.Rooms) b.Ext.locations.Rooms = b.Ext.locations.Rooms.map(swap).filter(Boolean);
    }
    for (const r of ensure(locIn(), 'Runs', [])) { r.Floor = swap(r.Floor || ''); }
  }
  const forget = (ids: string[]) => { const gone = new Set(ids); remap(id => gone.has(id) ? '' : null); };

  return { show: () => { render(); load(); } };
}
