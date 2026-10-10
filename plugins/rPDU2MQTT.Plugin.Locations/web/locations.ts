// Locations: the site › floor › room/area tree, each place's total and members, and bulk assignment.

type LocPlace = {
  id: string; name: string; kind: string; site: string; floor: string | null; value: number | null; state: string;
  nodes: { id: string; label: string }[]; missing: { id: string; label: string }[]; split: { id: string; label: string }[];
};
type LocNode = { id: string; label: string; kind: string; value: number | null; location: string | null; via: string | null };
type LocLive = { places: LocPlace[]; nodes: LocNode[]; units: string; problems: string[]; message: string | null };

const LOC_STATE: Record<string, string> = { unmetered: 'Nothing metered here.', unknown: 'A reading is missing.' };
const LOC_VIA: Record<string, string> = { own: 'set', rule: 'rule', placement: 'floor plan', circuit: 'circuit' };
const LOC_KINDS = ['site', 'floor', 'room', 'area'];

export default function mount(sec: any, host: any) {
  ({ api, btn, el, ensure, toast, state, refreshDirty, formatMeasure, searchSelect } = host);
  sec.classList.add('loc');
  sec.appendChild(el('h2', { text: 'Locations' }));

  const locIn = () => ensure(ensure(state.data, 'Plugins', {}), 'locations', {});
  const sitesIn = (): any[] => ensure(locIn(), 'Sites', []);
  const rulesIn = (): any[] => ensure(locIn(), 'AutoLocations', []);
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
  const nameOf = (id: string | null) => { const r = refOf(id); return r ? (r.obj.Name || r.obj.Id) : (id || ''); };
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
  const picked = new Set<string>();
  const fresh = new WeakSet<any>();
  let filter = '';

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

  const bar = el('div', { class: 'row loc-bar' });
  const body = el('div', { class: 'loc-body' });
  const tree = el('div', { class: 'loc-tree' });
  const detail = el('div', { class: 'loc-detail' });
  const assign = el('div', { class: 'loc-assign' });
  body.append(tree, detail);
  sec.append(bar, body, assign);

  const addSite = btn('Add site', 'primary');
  addSite.onclick = () => {
    const id = freshId(sitesIn().length ? 'site' : 'home');
    const site = { Id: id, Name: sitesIn().length ? 'New site' : 'Home', Floors: [] };
    fresh.add(site); sitesIn().push(site);
    selected = id; changed();
  };
  bar.append(addSite);

  const fmt = (v: number | null | undefined, units?: string) => v == null ? '—' : formatMeasure(Math.round(v * 100) / 100, units);
  const placeLive = (src: LocLive | null, id: string) => src?.places?.find(p => p.id === id) || null;

  function render() {
    renderTree(); renderDetail(); renderAssign();
  }

  function renderTree() {
    tree.innerHTML = '';
    const list = refs();
    if (!list.length) { tree.appendChild(el('div', { class: 'desc', text: 'No sites yet.' })); return; }
    for (const r of list) {
      const p = placeLive(live, r.obj.Id);
      const row = el('button', { class: `loc-row loc-${r.kind}` + (r.obj.Id === selected ? ' is-on' : ''), type: 'button' },
        el('span', { class: 'loc-name', text: (r.obj.Name || r.obj.Id) + (r.kind === 'area' ? ' (area)' : '') }),
        el('span', { class: 'loc-val' + (p?.value == null ? ' is-nodata' : ''), text: p ? fmt(p.value, live?.units) : '' }));
      row.onclick = () => { selected = r.obj.Id; render(); };
      tree.appendChild(row);
    }
    if (live?.problems?.length) tree.appendChild(el('div', { class: 'loc-problems' }, ...live.problems.map(t => el('div', { text: '⚠ ' + t }))));
  }

  const field = (label: string, input: any) => el('label', { class: 'loc-field' }, el('span', { text: label }), input);
  const text = (v: string, set: (v: string) => void) => {
    const i = el('input', { type: 'text', value: v || '' });
    i.onchange = () => { set(i.value.trim()); changed(); };
    return i;
  };

  function renderDetail() {
    detail.innerHTML = '';
    const r = refOf(selected);
    if (!r) { detail.appendChild(el('div', { class: 'desc', text: 'Select a place.' })); return; }
    const o = r.obj;
    detail.appendChild(el('h3', { text: o.Name || o.Id }));
    detail.appendChild(el('div', { class: 'loc-kind', text: `${r.kind} · ${o.Id}` }));

    const actions = el('div', { class: 'row' });
    const add = (label: string, into: () => any[], extra: any = {}) => {
      const b = btn(label);
      b.onclick = () => {
        const kind = label.replace('Add ', '');
        const id = freshId(kind);
        const place = { Id: id, Name: 'New ' + kind, ...extra };
        fresh.add(place); into().push(place);
        selected = id; changed();
      };
      actions.appendChild(b);
    };
    if (r.kind === 'site') add('Add floor', () => ensure(o, 'Floors', []), { Level: o.Floors?.length || 0 });
    if (r.kind === 'floor') { add('Add room', () => ensure(o, 'Rooms', [])); add('Add area', () => ensure(o, 'Areas', []), { Rooms: [] }); }
    const move = (d: number) => {
      const at = r.list.indexOf(o), to = at + d;
      if (to < 0 || to >= r.list.length) return;
      r.list.splice(at, 1); r.list.splice(to, 0, o);
      changed();
    };
    if (r.kind !== 'floor') {
      const up = btn('↑'), down = btn('↓');
      up.title = 'Move up'; down.title = 'Move down';
      up.onclick = () => move(-1); down.onclick = () => move(1);
      actions.append(up, down);
    }
    const del = btn('Delete', 'danger');
    del.onclick = () => {
      const inner = r.kind === 'site' || r.kind === 'floor' ? refs().filter(x => x.obj !== o && within(x.obj.Id, o.Id)) : [];
      if (!confirm(`Delete ${o.Name || o.Id}${inner.length ? ` and ${inner.length} place(s) in it` : ''}?`)) return;
      forget([o.Id, ...inner.map(x => x.obj.Id)]);
      r.list.splice(r.list.indexOf(o), 1);
      selected = ''; changed();
    };
    actions.appendChild(del);
    detail.appendChild(actions);

    detail.appendChild(field('Name', text(o.Name, v => {
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
      detail.appendChild(field('Level', lvl));
    }
    if (r.kind === 'room') detail.appendChild(field('Home Assistant area', text(o.HaArea, v => { o.HaArea = v; })));
    if (r.kind === 'area') {
      const box = el('div', { class: 'loc-checks' });
      for (const room of r.floor.Rooms || []) {
        const cb = el('input', { type: 'checkbox', checked: (o.Rooms || []).includes(room.Id) });
        cb.onchange = () => {
          const list = ensure(o, 'Rooms', []), at = list.indexOf(room.Id);
          if (cb.checked && at < 0) list.push(room.Id);
          if (!cb.checked && at >= 0) list.splice(at, 1);
          changed();
        };
        box.appendChild(el('label', { class: 'loc-check' }, cb, el('span', { text: room.Name || room.Id })));
      }
      detail.appendChild(field('Rooms', box));
    }

    const p = placeLive(live, o.Id), t = placeLive(today, o.Id);
    const stats = el('div', { class: 'loc-stats' },
      el('div', {}, el('span', { text: 'Now' }), el('strong', { text: p ? fmt(p.value, live?.units) : '—' })),
      el('div', {}, el('span', { text: 'Today' }), el('strong', { text: t ? fmt(t.value, today?.units) : '—' })));
    detail.appendChild(stats);
    if (p && p.value == null && LOC_STATE[p.state]) detail.appendChild(el('div', { class: 'desc', text: LOC_STATE[p.state] }));
    if (p?.missing?.length) detail.appendChild(el('div', { class: 'desc', text: 'Missing: ' + p.missing.map(n => n.label).join(', ') }));
    if (p?.split?.length) detail.appendChild(el('div', { class: 'desc', text: 'Split: ' + p.split.map(n => n.label).join(', ') }));

    detail.appendChild(el('h4', { text: 'Members' }));
    const nodes = (live?.nodes || []).filter(n => within(n.location, o.Id));
    if (!nodes.length) detail.appendChild(el('div', { class: 'desc', text: 'None.' }));
    const ul = el('div', { class: 'loc-members' });
    for (const n of nodes) {
      const direct = n.location === o.Id;
      const row = el('div', { class: 'loc-member' + (direct ? '' : ' is-inherited') },
        el('span', { text: n.label }),
        el('span', { class: 'loc-via', text: direct ? LOC_VIA[n.via || ''] || '' : nameOf(n.location) }),
        el('span', { class: 'loc-val', text: fmt(n.value, live?.units) }));
      if (direct && (n.via === 'own' || (n.via === 'rule' && exactRule(n.id)))) {
        const rm = btn('Remove');
        rm.onclick = () => { unassign(n.id); changed(); };
        row.appendChild(rm);
      }
      ul.appendChild(row);
    }
    detail.appendChild(ul);
    const others = (live?.nodes || []).filter(n => n.location !== o.Id);
    if (others.length) {
      detail.appendChild(searchSelect([{ value: '', label: 'Add a node…' }, ...others.map(n => ({ value: n.id, label: n.location ? `${n.label} (${nameOf(n.location)})` : n.label }))],
        '', (v: string) => { if (v) { assignTo(v, o.Id); changed(); } }, { placeholder: 'Search nodes…' }));
    }

    detail.appendChild(el('h4', { text: 'Rules' }));
    const rules = rulesIn().filter(x => x.Location === o.Id);
    for (const rule of rules) {
      const hits = (live?.nodes || []).filter(n => n.location === o.Id && n.via === 'rule' && matches(rule.Match, n.id)).length;
      const rm = btn('Remove');
      rm.onclick = () => { rulesIn().splice(rulesIn().indexOf(rule), 1); changed(); };
      detail.appendChild(el('div', { class: 'loc-member' },
        Object.assign(text(rule.Match, v => { rule.Match = v; }), { placeholder: 'Node id, * matches anything' }), el('span', { class: 'loc-via', text: `${hits} node(s)` }), rm));
    }
    const addRule = btn('Add rule');
    addRule.onclick = () => { rulesIn().push({ Match: '', Location: o.Id }); changed(); };
    detail.appendChild(addRule);
  }

  function renderAssign() {
    assign.innerHTML = '';
    assign.appendChild(el('h3', { text: 'Assign' }));
    const nodes = live?.nodes || [];
    if (!nodes.length) { assign.appendChild(el('div', { class: 'desc', text: live ? 'No nodes.' : 'Loading…' })); return; }
    const top = el('div', { class: 'row' });
    const q = el('input', { type: 'search', placeholder: 'Filter', value: filter });
    q.oninput = () => { filter = q.value; drawRows(); };
    const places = refs();
    const to = el('select', {}, el('option', { value: '', text: 'Move selected to…' }), el('option', { value: '-', text: '(none)' }),
      ...places.map(r => el('option', { value: r.obj.Id, text: `${'  '.repeat(Math.min(LOC_KINDS.indexOf(r.kind), 2))}${r.obj.Name || r.obj.Id}` })));
    to.onchange = () => {
      if (!to.value || !picked.size) return;
      for (const id of picked) to.value === '-' ? unassign(id) : assignTo(id, to.value);
      toast(`Moved ${picked.size} node(s).`, true);
      picked.clear(); changed();
    };
    top.append(q, to);
    assign.appendChild(top);
    const table = el('div', { class: 'loc-rows' });
    assign.appendChild(table);
    const drawRows = () => {
      table.innerHTML = '';
      const f = filter.trim().toLowerCase();
      for (const n of nodes.filter(n => !f || n.label.toLowerCase().includes(f) || n.id.toLowerCase().includes(f) || nameOf(n.location).toLowerCase().includes(f))) {
        const cb = el('input', { type: 'checkbox', checked: picked.has(n.id) });
        cb.onchange = () => { cb.checked ? picked.add(n.id) : picked.delete(n.id); };
        table.appendChild(el('label', { class: 'loc-member' }, cb, el('span', { text: n.label }),
          el('span', { class: 'loc-via', text: n.location ? `${nameOf(n.location)} · ${LOC_VIA[n.via || ''] || ''}` : '—' })));
      }
    };
    drawRows();
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
