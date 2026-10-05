// Solar Array page: panels (tigo-bound nodes) wired into strings (pv-string nodes) wired into MPPTs.
let api     , btn     , el     , ensure     , toast     , state     , refreshDirty     , saveConfig     , openHistorySheet     , busyInSection     , timelineStrip     , stepToFit     ;
/// Temperatures are stored in °C; the host converts for display (Gui.TemperatureUnits).
let temp = { unit: () => '°C', to: (c        ) => c, from: (v        ) => v, fmt: (c        , d = 0) => `${(Number(c.toFixed(d)) || 0).toFixed(d)} °C` };

const STRING_TAG = 'pv-string';

/// [key, label, metric charted on click]
const SA_SHOWS                             = [
  ['power', 'Power', 'realpower'],
  ['vin', 'Volts', 'voltage'],
  ['iin', 'Amps', 'current'],
  ['temp', 'Temp', 'temperature'],
];

const saFlow = () => ensure(state.data, 'EnergyFlow', {});
const saNodes = ()        => ensure(saFlow(), 'Nodes', []);
const saLinks = ()        => ensure(saFlow(), 'Links', []);
const saSame = (a         , b         ) => (a || '').toLowerCase() === (b || '').toLowerCase();

const serialOf = (n     )                =>
  (n?.Sources || []).find((s     ) => saSame(s.Type, 'tigo') && s.Settings?.Optimizer)?.Settings.Optimizer || null;

/// Serial or label form (4-DFA5A5Y), as TigoPlugin.SameOptimizer.
function sameOptimizer(configured        , serial        )          {
  const c = (configured || '').trim();
  if (saSame(c, serial)) return true;
  const m = /^([0-9a-f])-([0-9a-f]{6})[a-z]$/i.exec(c);
  return !!m && (serial || '').length === 16 && serial[6].toLowerCase() === m[1].toLowerCase() && serial.toLowerCase().endsWith(m[2].toLowerCase());
}

/// Plugins.tigo.PanelTypes, edited on the Panel Types page.
const saTypes = ()        => state.data?.Plugins?.tigo?.PanelTypes || [];
const saTypeName = (t     ) => [t.Manufacturer, t.Model].filter(Boolean).join(' ') || t.Id;
const typeOf = (n     )                =>
  (n?.Sources || []).find((s     ) => saSame(s.Type, 'tigo') && s.Settings?.PanelType)?.Settings.PanelType || null;

function setType(n     , typeId               ) {
  (n?.Sources || []).filter((s     ) => saSame(s.Type, 'tigo')).forEach((s     ) => {
    s.Settings = s.Settings || {};
    if (typeId) s.Settings.PanelType = typeId; else delete s.Settings.PanelType;
  });
}

/// Series string at STC: Voc adds, Isc is the highest panel's, Pmax adds.
/// Panels without optimizers, per string: Plugins.tigo.StringPanels[stringId] = { PanelType, Panels }.
const untrackedOf = (stringId        )                                          =>
  state.data?.Plugins?.tigo?.StringPanels?.[stringId] || {};

function setUntracked(stringId        , value                                         ) {
  const all = ensure(ensure(ensure(state.data, 'Plugins', {}), 'tigo', {}), 'StringPanels', {});
  if (!value.Panels && !value.PanelType) delete all[stringId];
  else all[stringId] = value;
}

/// Per-string page layout: Plugins.tigo.Strings[stringId] = { Columns }. Hidden there is read for older configs.
const layoutOf = (stringId        )                                         =>
  state.data?.Plugins?.tigo?.Strings?.[stringId] || {};

const isHidden = (s     ) => !!s?.Hidden || !!layoutOf(s?.Id).Hidden;

function setLayout(stringId        , change                                        ) {
  const all = ensure(ensure(ensure(state.data, 'Plugins', {}), 'tigo', {}), 'Strings', {});
  const next      = { ...(all[stringId] || {}), ...change };
  Object.keys(next).forEach(k => { if (next[k] === undefined) delete next[k]; });
  if (Object.keys(next).length) all[stringId] = next; else delete all[stringId];
}

/// Plugins.tigo.GroupPanels: one EnergyFlow group per string, its panels as members (collapsed in Flow).
const groupingOn = () => !!state.data?.Plugins?.tigo?.GroupPanels;

let removedAt = new Map                ();

function syncGroups() {
  const groups        = ensure(saFlow(), 'Groups', []);
  const strings = stringsOf();
  const isString = (id        ) => strings.some(s => saSame(s.Id, id));
  for (let i = groups.length - 1; i >= 0; i--)
    if (isString(groups[i].Id) && !groupingOn()) {
      removedAt.set(String(groups[i].Id).toLowerCase(), i);
      groups.splice(i, 1);
    }
  if (!groupingOn()) return;
  const added                  = [];
  strings.forEach(s => {
    const members = panelsOf(s.Id);
    const g = groups.find(x => saSame(x.Id, s.Id));
    if (g) { g.Members = members; g.Label = s.Label || s.Id; }
    else {
      const parent = groups.find(x => (x.Members || []).some((m        ) => saSame(m, saMpptOf(s.Id))));
      const g = { Id: s.Id, Kind: 'solar', Label: s.Label || s.Id, Members: members, ...(parent ? { Parent: parent.Id } : {}) };
      added.push([removedAt.get(String(s.Id).toLowerCase()) ?? Infinity, g]);
    }
  });
  added.sort((a, b) => a[0] - b[0]).forEach(([i, g]) => groups.splice(Math.min(i, groups.length), 0, g));
}

function ratingOf(panelIds          , stringId         )         {
  const types = saTypes();
  const rated = panelIds.map(id => types.find(t => t.Id === typeOf(saNode(id)))).filter(Boolean);
  const extra = stringId ? untrackedOf(stringId) : {};
  const extraType = types.find(t => t.Id === extra.PanelType);
  for (let i = 0; extraType && i < (extra.Panels || 0); i++) rated.push(extraType);
  const total = panelIds.length + (extra.Panels || 0);
  if (!rated.length) return '';
  const sum = (k        ) => rated.reduce((a        , t     ) => a + (Number(t[k]) || 0), 0);
  const parts = [];
  if (rated.some((t     ) => t.Voc)) parts.push(`Voc ${Math.round(sum('Voc'))} V`);
  if (rated.some((t     ) => t.Isc)) parts.push(`Isc ${Math.max(...rated.map((t     ) => Number(t.Isc) || 0)).toFixed(1)} A`);
  if (rated.some((t     ) => t.Watts)) parts.push(`${(sum('Watts') / 1000).toFixed(2)} kWp`);
  if (rated.length < total) parts.push(`${rated.length}/${total} typed`);
  return parts.join(' · ');
}

/// A string's rated electricals at STC, from typed panels; null when none is typed.
function electricalOf(stringId        ) {
  const types = saTypes();
  const rated        = panelsOf(stringId).map(id => types.find(t => t.Id === typeOf(saNode(id)))).filter(Boolean);
  const extra = untrackedOf(stringId);
  const extraType = types.find(t => t.Id === extra.PanelType);
  for (let i = 0; extraType && i < (extra.Panels || 0); i++) rated.push(extraType);
  if (!rated.length) return null;
  const sum = (k        ) => rated.reduce((a        , t     ) => a + (Number(t[k]) || 0), 0);
  const max = (k        ) => Math.max(...rated.map((t     ) => Number(t[k]) || 0));
  const minTemp = state.data?.Plugins?.tigo?.DesignMinTempC;
  // Voc rises as cells cool: coefficient (negative %/°C) × degrees below 25 °C.
  const cold = typeof minTemp === 'number' && rated.every((t     ) => Number(t.TempCoeffVoc))
    ? rated.reduce((a        , t     ) => a + (Number(t.Voc) || 0) * (1 + (Number(t.TempCoeffVoc) || 0) / 100 * (minTemp - 25)), 0)
    : null;
  return { voc: sum('Voc'), vocCold: cold, vmp: sum('Vmp'), isc: max('Isc'), imp: max('Imp'), complete: rated.length === panelsOf(stringId).length + (extra.Panels || 0) };
}

/// Per-MPPT limits: Plugins.tigo.Mppts[mpptNodeId] = { MaxVoltage, MinMpptVoltage, MaxMpptVoltage, MaxCurrent, MaxShortCircuitCurrent }.
const mpptLimits = (id        )      => state.data?.Plugins?.tigo?.Mppts?.[id] || {};

function setMpptLimit(id        , field        , value                    ) {
  const all = ensure(ensure(ensure(state.data, 'Plugins', {}), 'tigo', {}), 'Mppts', {});
  const next      = { ...(all[id] || {}) };
  if (value == null) delete next[field]; else next[field] = value;
  if (Object.keys(next).length) all[id] = next; else delete all[id];
}

/// What an MPPT's strings break: [level, text, stringId or null for the MPPT as a whole].
function mpptIssues(mpptId        )                                    {
  const lim = mpptLimits(mpptId);
  const strings = stringsOf().filter(st => saSame(saMpptOf(st.Id), mpptId));
  const out                                    = [];
  let isc = 0, imp = 0;
  strings.forEach(st => {
    const e = electricalOf(st.Id);
    if (!e) return;
    const name = st.Label || st.Id;
    isc += e.isc; imp += e.imp;
    const voc = e.vocCold ?? e.voc;
    const at = e.vocCold != null ? ` at ${temp.fmt(state.data.Plugins.tigo.DesignMinTempC)}` : ' at STC';
    if (lim.MaxVoltage && voc > lim.MaxVoltage) out.push(['bad', `${name}: Voc ${Math.round(voc)} V${at} exceeds the ${lim.MaxVoltage} V maximum`, st.Id]);
    else if (lim.MaxVoltage && voc > 0.95 * lim.MaxVoltage) out.push(['warn', `${name}: Voc ${Math.round(voc)} V${at} is within 5% of the ${lim.MaxVoltage} V maximum`, st.Id]);
    if (e.vmp && lim.MinMpptVoltage && e.vmp < lim.MinMpptVoltage) out.push(['warn', `${name}: Vmp ${Math.round(e.vmp)} V is below the ${lim.MinMpptVoltage} V MPPT range`, st.Id]);
    if (e.vmp && lim.MaxMpptVoltage && e.vmp > lim.MaxMpptVoltage) out.push(['warn', `${name}: Vmp ${Math.round(e.vmp)} V is above the ${lim.MaxMpptVoltage} V MPPT range`, st.Id]);
  });
  if (lim.MaxShortCircuitCurrent && isc > lim.MaxShortCircuitCurrent)
    out.push(['bad', `Isc ${isc.toFixed(1)} A from ${strings.length} string(s) exceeds the ${lim.MaxShortCircuitCurrent} A short-circuit maximum`, null]);
  if (lim.MaxCurrent && imp > lim.MaxCurrent)
    out.push(['warn', `Imp ${imp.toFixed(1)} A from ${strings.length} string(s) exceeds the ${lim.MaxCurrent} A usable input; output will clip`, null]);
  return out;
}

const typeSelect = (current               , empty        ) => {
  const pick = el('select', { class: 'sa-type' })                     ;
  pick.appendChild(el('option', { value: '', text: empty }));
  saTypes().forEach(t => pick.appendChild(el('option', { value: t.Id, text: saTypeName(t) })));
  pick.value = current && saTypes().some(t => t.Id === current) ? current : '';
  pick.onclick = (e     ) => e.stopPropagation?.();
  return pick;
};

/// Reorder strings among themselves; every other node keeps its place.
function placeString(stringId        , before               ) {
  const nodes = saNodes();
  const ids = stringsOf().map(x => x.Id);
  const slots = nodes.map((n, i) => ids.some(id => saSame(id, n.Id)) ? i : -1).filter(i => i >= 0);
  const order = slots.map(i => nodes[i]).filter(n => !saSame(n.Id, stringId));
  const moving = nodes.find(n => saSame(n.Id, stringId));
  if (!moving) return;
  const at = before ? order.findIndex(n => saSame(n.Id, before)) : -1;
  order.splice(at >= 0 ? at : order.length, 0, moving);
  slots.forEach((slot, k) => { nodes[slot] = order[k]; });
}

const saNode = (id        ) => saNodes().find(n => saSame(n.Id, id));
const saIsPanel = (id        ) => !!serialOf(saNode(id));

function stringsOf()        {
  const fedByPanel = new Set(saLinks().filter(l => saIsPanel(l.From)).map(l => (l.To || '').toLowerCase()));
  return saNodes().filter(n => (n.Tags || []).includes(STRING_TAG) || fedByPanel.has((n.Id || '').toLowerCase()));
}
const panelsOf = (stringId        )           => saLinks().filter(l => saSame(l.To, stringId) && saIsPanel(l.From)).map(l => l.From);
const saMpptOf = (stringId        )         => saLinks().find(l => saSame(l.From, stringId))?.To || '';

const saSlug = (s        ) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'string';

function placePanel(panelId        , stringId        , before               ) {
  const links = saLinks();
  for (let i = links.length - 1; i >= 0; i--) if (saSame(links[i].From, panelId) && !saIsPanel(links[i].To)) links.splice(i, 1);
  const link = { From: panelId, To: stringId };
  const at = before ? links.findIndex(l => saSame(l.From, before) && saSame(l.To, stringId)) : -1;
  if (at >= 0) links.splice(at, 0, link);
  else {
    let last = -1;
    links.forEach((l, i) => { if (saSame(l.To, stringId) && saIsPanel(l.From)) last = i; });
    links.splice(last >= 0 ? last + 1 : links.length, 0, link);
  }
}

function adoptOptimizer(serial        , stringId        , label        ) {
  const id = 'tigo_' + serial.toLowerCase();
  if (!saNode(id)) {
    const bind = (Metric        ) => ({ Type: 'tigo', Metric, Settings: { Optimizer: serial } });
    saNodes().push({ Id: id, Label: label, Kind: 'solar', Sources: ['realpower', 'voltage', 'current', 'temperature'].map(bind) });
  }
  placePanel(id, stringId, null);
  return id;
}

/// e.g. A1, A2…
function saNextLabel(stringNode     ) {
  const letter = ((stringNode?.Label || stringNode?.Id || 'S').match(/[A-Za-z0-9]/)?.[0] || 'S').toUpperCase();
  return `${letter}${panelsOf(stringNode.Id).length + 1}`;
}

function mount(sec     , host     ) {
  ({ api, btn, el, ensure, toast, state, refreshDirty, saveConfig, openHistorySheet, busyInSection, timelineStrip, stepToFit } = host);
  if (host.temp) temp = host.temp;

  const total = el('span', { class: 'sa-total' });
  const head = el('div', { class: 'sa-head' }, el('h2', { text: 'Solar Array' }), total);
  const showSel = el('div', { class: 'sa-show', role: 'group' });
  let show = 'power';
  try { show = localStorage.getItem('rpdu-solar-show') || 'power'; } catch { /* default */ }
  const editBtn = btn('Edit');
  const save = btn('Save', 'primary');
  const grouping = el('input', { type: 'checkbox' })                    ;
  const groupLabel = el('label', { class: 'sa-hide', title: 'Adds a Flow group per string. Its panels show when the group is expanded.' }, grouping, ' Flow group per string');
  grouping.onchange = () => {
    ensure(ensure(state.data, 'Plugins', {}), 'tigo', {}).GroupPanels = grouping.checked || undefined;
    if (!grouping.checked) delete state.data.Plugins.tigo.GroupPanels;
    changed();
  };
  head.append(showSel, groupLabel, editBtn, save);
  sec.appendChild(head);
  const pastOn = el('input', { type: 'checkbox', class: 'switch' })                    ;
  const windowSel = el('select', { class: 'sa-step', title: 'How far back the timeline reaches' })                     ;
  [['60', '1 hour'], ['360', '6 hours'], ['1440', '24 hours'], ['10080', '7 days']].forEach(([v, t]) => windowSel.appendChild(el('option', { value: v, text: t })));
  windowSel.value = '1440';
  const dayIn = el('input', { type: 'date', class: 'sa-when', title: 'The day the timeline ends on. Blank for now.' })                    ;
  const pastTools = el('span', { class: 'sa-time-tools' }, windowSel, el('span', { class: 'sa-time-label', text: 'ending' }), dayIn);
  sec.appendChild(el('div', { class: 'sa-time' }, el('label', { class: 'sa-hide', title: 'Show the array at a moment picked on a timeline' }, pastOn, ' Point in time'), pastTools));
  const strip = timelineStrip ? timelineStrip((span     ) => { if (span) goTo(new Date(span.from)); }, undefined, { moment: true }) : null;
  if (strip) sec.appendChild(strip.el);
  const stripWait = el('div', { class: 'sa-note', text: 'Loading the timeline…', hidden: true });
  sec.appendChild(stripWait);
  const syncTime = () => {
    const on = pastOn.checked;
    pastTools.hidden = !on;
    if (strip) strip.el.hidden = !on || !stripLoaded;
    stripWait.hidden = !on || stripLoaded || !stripLoading;
  };
  let stripLoaded = false;
  let stripLoading = false;
  const goTo = (d             ) => {
    at = d;
    if (at) loadAt(); else { hist = {}; histFailed = null; load(); }
  };
  const loadStrip = async () => {
    const minutes = Number(windowSel.value) || 1440;
    const step = stepToFit ? stepToFit(minutes * 60, 300) : 300;
    const now = Date.now();
    const end = dayIn.value ? Math.min(now, new Date(`${dayIn.value}T23:59:59`).getTime()) : now;
    let r     ;
    stripLoading = true; syncTime();
    const only = stringsOf().map(st => st.Id).join(',');
    try {
      r = await api(`/api/flow/series?from=${encodeURIComponent(new Date(end - minutes * 60_000).toISOString())}`
        + `&to=${encodeURIComponent(new Date(end).toISOString())}&step=${step}&metric=realpower&nodes=${encodeURIComponent(only)}`);
    } catch (e     ) { r = { body: { ok: false, message: String(e?.message || e) } }; }
    stripLoading = false;
    const b = r?.body;
    const points = ((b?.at || [])            ).map(iso => new Date(iso).getTime());
    if (!b?.ok || points.length < 2) {
      stripLoaded = false;
      histFailed = b?.message || 'No history for that window.';
      at = new Date(end); hist = {};
      render();
      return;
    }
    const ids = stringsOf().map(st => st.Id.toLowerCase());
    const colours = ['#3987e5', '#d95926', '#199e70', '#c98a1a', '#8e5cd9', '#d04f8a'];
    const lines = (b.series || []).filter((x     ) => ids.includes(String(x.node).toLowerCase()))
      .slice(0, colours.length).map((x     , i        ) => ({ label: x.label || x.node, color: colours[i], values: x.values }));
    stripLoaded = true;
    syncTime();
    strip?.draw({ lines, points, bounds: { from: points[0], to: points[points.length - 1] }, width: 1200 });
    const keep = at && at.getTime() >= points[0] && at.getTime() <= points[points.length - 1] ? at.getTime() : points[points.length - 1];
    strip?.set({ from: keep, to: keep });
    goTo(new Date(keep));
  };
  pastOn.onchange = () => { if (pastOn.checked) loadStrip(); else goTo(null); syncTime(); };
  windowSel.onchange = () => loadStrip();
  dayIn.onchange = () => { at = null; loadStrip(); };
  const buses = el('div', { class: 'sa-buses' });
  const array = el('div', { class: 'sa-array' });
  const loose = el('div', { class: 'sa-loose' });
  sec.append(buses, array, loose);

  let snap      = null;
  let at              = null;
  let hist                      = {};
  let histFailed                = null;
  // The MPPTs' own readings (their bound sources), live and at the picked moment.
  let mpptNow                      = {};
  let mpptAt                      = {};
  const mpptIds = () => [...new Set(stringsOf().map(st => saMpptOf(st.Id)).filter(Boolean))];
  const MPPT_METRICS                     = [['realpower', 'power'], ['voltage', 'volts'], ['current', 'amps']];
  const mpptReading = (id        ) => (at ? mpptAt : mpptNow)[id];
  const mpptText = (id        ) => {
    const m = mpptReading(id);
    if (!m) return '';
    const parts = [];
    if (m.volts != null) parts.push(`${Math.round(m.volts)} V`);
    if (m.amps != null) parts.push(`${m.amps.toFixed(1)} A`);
    if (m.power != null) parts.push(`${(m.power / 1000).toFixed(2)} kW`);
    return parts.length ? `${saNode(id)?.Label || id} reads ${parts.join(' · ')}` : '';
  };
  const parseMppt = (values       ) => {
    const out                      = {};
    const ids = mpptIds().map(x => x.toLowerCase());
    (values || []).forEach((v     ) => {
      if (v.value == null || !ids.includes(String(v.node).toLowerCase())) return;
      const field = MPPT_METRICS.find(([m]) => m === v.metric)?.[1];
      if (field) (out[v.node] = out[v.node] || {})[field] = v.value;
    });
    return out;
  };
  const mpptQuery = () => mpptIds().flatMap(id => MPPT_METRICS.map(([Metric]) => ({ Node: id, Metric })));
  let failed                = null;
  let editing = false;
  let dragged                = null;
  let draggedString                = null;
  let legacyCols                         = {};
  try { legacyCols = JSON.parse(localStorage.getItem('rpdu-solar-cols') || '{}') || {}; } catch { legacyCols = {}; }
  const colsOf = (id        ) => layoutOf(id).Columns || legacyCols[id.toLowerCase()] || 3;

  SA_SHOWS.forEach(([key, label]) => {
    const b = el('button', { type: 'button', class: 'sa-show-btn', text: label })                     ;
    b.dataset.show = key;
    b.onclick = () => { show = key; try { localStorage.setItem('rpdu-solar-show', key); } catch { /* this view */ } render(); };
    showSel.appendChild(b);
  });
  editBtn.onclick = () => { editing = !editing; render(); };
  save.onclick = () => saveConfig(() => render());

  const live = (serial               ) => (snap?.optimizers || []).find((o     ) => !!serial && sameOptimizer(serial, o.serial));
  const readingOf = (panelId        ) => at ? hist[panelId] : live(serialOf(saNode(panelId)));
  const fmt = (o     , key        ) => o == null ? '—'
    : key === 'power' ? `${Math.round(o.power)} W` : key === 'vin' ? `${o.vin.toFixed(1)} V`
    : key === 'iin' ? `${o.iin.toFixed(2)} A` : temp.fmt(o.temp);
  const short = (o     , key        ) => key === 'power' ? `${Math.round(o.power)}W` : key === 'vin' ? `${o.vin.toFixed(1)}V` : `${o.iin.toFixed(1)}A`;
  const stale = (o     ) => !o || o.ageSeconds > (snap?.staleSeconds ?? 180);
  const changed = () => { syncGroups(); refreshDirty(); render(); };

  const tile = (panelId        , stringId        , scale                                 ) => {
    const node = saNode(panelId);
    const serial = serialOf(node);
    const o = readingOf(panelId);
    const quiet = stale(o);
    const t = el('div', { class: 'sa-panel' + (quiet ? ' is-quiet' : '') });
    t.dataset.node = panelId;
    const value = o && !quiet ? (show === 'power' ? o.power : show === 'vin' ? o.vin : show === 'iin' ? o.iin : o.temp) : 0;
    const frac = scale.max > 0 ? Math.max(0, Math.min(1, value / scale.max)) : 0;
    t.style.setProperty?.('--sa-fill', String(frac));
    if (!quiet && show === 'power' && scale.median > 20 && o.power < 0.75 * scale.median) t.classList.add('is-low');
    const [num, unit] = quiet ? ['—', ''] : fmt(o, show).split(' ');
    const others = quiet ? (o ? 'quiet' : 'not heard')
      : SA_SHOWS.filter(([k]) => k !== show && k !== 'temp').slice(0, 2).map(([k]) => short(o, k)).join(' ');
    t.append(
      el('div', { class: 'sa-panel-label', text: node?.Label || panelId }),
      el('div', { class: 'sa-panel-value' }, num + (unit ? ' ' : ''), el('span', { class: 'sa-unit', text: unit })),
      el('div', { class: 'sa-panel-sub', text: others }));
    if (editing || !o) t.append(el('div', { class: 'sa-panel-serial', text: serial || '' }));
    t.append(el('div', { class: 'sa-bar' }, el('i', { style: { width: `${Math.round(frac * 100)}%` } })));
    const type = saTypes().find(x => x.Id === typeOf(node));
    t.title = `${node?.Label || panelId} · optimizer ${serial}` + (type ? ` · ${saTypeName(type)}` : '')
      + (o ? ` · reported ${Math.round(o.ageSeconds)} s ago` : ' · not heard on the bus');

    if (editing) {
      t.draggable = true;
      t.classList.add('is-editing');
      t.addEventListener('dragstart', (e     ) => { e.stopPropagation?.(); dragged = panelId; e.dataTransfer?.setData('text/plain', panelId); t.classList.add('is-dragging'); });
      t.addEventListener('dragend', () => { t.classList.remove('is-dragging'); sec.querySelectorAll?.('.is-drop').forEach((x     ) => x.classList.remove('is-drop')); });
      t.addEventListener('dragenter', () => { if (dragged && dragged !== panelId) t.classList.add('is-drop'); });
      t.addEventListener('dragleave', () => t.classList.remove('is-drop'));
      t.addEventListener('dragover', (e     ) => e.preventDefault());
      t.addEventListener('drop', (e     ) => { e.preventDefault(); e.stopPropagation?.(); if (dragged && dragged !== panelId) { placePanel(dragged, stringId, panelId); dragged = null; changed(); } });
      const order = panelsOf(stringId);
      const at = order.findIndex(id => saSame(id, panelId));
      const move = (to        ) => { const before = order.filter(id => !saSame(id, panelId))[to] ?? null; placePanel(panelId, stringId, before); changed(); };
      const left = btn('‹'); left.title = 'Move left'; left.disabled = at <= 0; left.onclick = (e     ) => { e.stopPropagation?.(); move(at - 1); };
      const right = btn('›'); right.title = 'Move right'; right.disabled = at >= order.length - 1; right.onclick = (e     ) => { e.stopPropagation?.(); move(at + 1); };
      const name = el('input', { type: 'text', value: node?.Label || '', class: 'sa-panel-name', title: 'Panel label' })                    ;
      name.onclick = (e     ) => e.stopPropagation?.();
      name.onchange = () => { node.Label = name.value.trim() || undefined; changed(); };
      const to = el('select', { class: 'sa-panel-move', title: 'Move to another string, or take it out' })                     ;
      to.appendChild(el('option', { value: '', text: 'Move to…' }));
      stringsOf().filter(s => !saSame(s.Id, stringId)).forEach(s => to.appendChild(el('option', { value: s.Id, text: s.Label || s.Id })));
      to.appendChild(el('option', { value: '__remove', text: 'Take out of the array' }));
      to.onclick = (e     ) => e.stopPropagation?.();
      to.onchange = () => {
        if (to.value === '__remove') {
          if (!confirm(`Remove ${node?.Label || panelId} and its node from the array?`)) { to.value = ''; return; }
          const links = saLinks();
          for (let i = links.length - 1; i >= 0; i--) if (saSame(links[i].From, panelId) || saSame(links[i].To, panelId)) links.splice(i, 1);
          const nodes = saNodes();
          nodes.splice(nodes.findIndex(n => saSame(n.Id, panelId)), 1);
        } else if (to.value) placePanel(panelId, to.value, null);
        changed();
      };
      const kind = typeSelect(typeOf(node), 'Type…');
      kind.title = 'Panel type';
      kind.onchange = () => { setType(node, kind.value || null); changed(); };
      t.append(name, el('div', { class: 'sa-panel-edit' }, left, to, right), kind);
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
    showSel.querySelectorAll?.('.sa-show-btn').forEach((b     ) => b.classList.toggle('is-on', b.dataset.show === show));
    editBtn.textContent = editing ? 'Done' : 'Edit';
    grouping.checked = groupingOn();
    groupLabel.hidden = !editing;
    editBtn.classList.toggle('primary', editing);

    buses.innerHTML = '';
    syncTime();
    if (at) buses.appendChild(el('div', { class: 'sa-note', text: histFailed || `Showing ${at.toLocaleString()}. Untick Point in time to return to live.` }));
    if (failed) buses.appendChild(el('div', { class: 'sa-note is-bad', text: failed }));
    (at ? [] : snap?.connections || []).forEach((c     ) => {
      const st = c.state || { level: 'warn', summary: c.connected ? 'connected' : 'not connected', detail: c.error || '' };
      const state = `${st.summary} — ${st.detail}`;
      buses.appendChild(el('div', { class: 'sa-bus' + (st.level === 'good' ? ' is-good' : ' is-warn') },
        el('strong', { text: c.name || c.id }), el('span', { text: state })));
    });

    const heard = snap?.optimizers || [];
    const panels = saNodes().map(serialOf).filter(Boolean)            ;
    if (panels.length && heard.length && !heard.some((o     ) => o.named))
      buses.appendChild(el('div', { class: 'sa-note', text: `${heard.length} optimizers heard, none named yet. Names come from the TAP's node table, which the CCA reads at startup: power-cycle the CCA.` }));

    array.innerHTML = '';
    array.classList.toggle('is-editing', editing);
    const strings = stringsOf();
    const all = (at ? Object.values(hist) : snap?.optimizers || []).filter((o     ) => !stale(o));
    const valueOf = (o     ) => show === 'power' ? o.power : show === 'vin' ? o.vin : show === 'iin' ? o.iin : o.temp;
    const max = all.reduce((m        , o     ) => Math.max(m, valueOf(o)), 0);
    const placed = strings.flatMap(st => panelsOf(st.Id));
    const placedLive = placed.map(readingOf).filter((o     ) => o && !stale(o));
    total.textContent = placedLive.length
      ? `${(placedLive.reduce((w        , o     ) => w + o.power, 0) / 1000).toFixed(2)} kW · ${placedLive.length}/${placed.length} reporting` : '';
    const cards                                        = [];
    strings.forEach(s => {
      const panels = panelsOf(s.Id);
      const extra = untrackedOf(s.Id);
      if (!editing && (isHidden(s) || (!panels.length && !extra.Panels))) return;
      const readings = panels.map(readingOf).filter((o     ) => o && !stale(o));
      const watts = readings.reduce((sum        , o     ) => sum + o.power, 0);
      const sorted = readings.map((o     ) => o.power).sort((a        , b        ) => a - b);
      const median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
      const volts = readings.some((o     ) => o.vout != null) ? readings.reduce((sum        , o     ) => sum + (o.vout || 0), 0) : null;

      const card = el('div', { class: 'sa-string' + (isHidden(s) ? ' is-string-hidden' : '') });
      card.dataset.node = s.Id;
      const mppt = saMpptOf(s.Id);
      const headRow = el('div', { class: 'sa-string-head' });
      if (editing) {
        const name = el('input', { type: 'text', value: s.Label || s.Id, class: 'sa-string-name', title: 'String name' })                    ;
        name.onchange = () => { s.Label = name.value.trim() || undefined; changed(); };
        const to = el('select', { class: 'sa-mppt', title: 'The MPPT this string feeds' })                     ;
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
        const across = el('select', { class: 'sa-cols', title: 'Columns' })                     ;
        for (let n = 1; n <= 12; n++) across.appendChild(el('option', { value: String(n), text: `${n} column${n === 1 ? '' : 's'}` }));
        across.value = String(colsOf(s.Id));
        across.onchange = () => {
          setLayout(s.Id, { Columns: Number(across.value) });
          refreshDirty();
          render();
        };
        const kinds = typeSelect(null, 'Set all panels to…');
        kinds.title = 'Panel type for every panel in this string';
        kinds.disabled = !panels.length || !saTypes().length;
        kinds.onchange = () => { panels.forEach(id => setType(saNode(id), kinds.value || null)); changed(); };
        const order = strings.map(x => x.Id);
        const at = order.findIndex(id => saSame(id, s.Id));
        const earlier = btn('‹'); earlier.title = 'Move string left'; earlier.disabled = at <= 0;
        earlier.onclick = () => { placeString(s.Id, order[at - 1]); changed(); };
        const later = btn('›'); later.title = 'Move string right'; later.disabled = at >= order.length - 1;
        later.onclick = () => { placeString(s.Id, order[at + 2] ?? null); changed(); };
        const grip = el('span', { class: 'sa-grip', text: '⠿', title: 'Drag to reorder strings' });
        grip.draggable = true;
        grip.addEventListener('dragstart', (e     ) => { draggedString = s.Id; e.dataTransfer?.setData('text/plain', s.Id); card.classList.add('is-dragging'); });
        grip.addEventListener('dragend', () => { draggedString = null; card.classList.remove('is-dragging'); sec.querySelectorAll?.('.is-drop').forEach((x     ) => x.classList.remove('is-drop')); });
        const hide = el('input', { type: 'checkbox', checked: isHidden(s) })                    ;
        hide.onchange = () => { s.Hidden = hide.checked || undefined; setLayout(s.Id, { Hidden: undefined }); changed(); };
        const hideLabel = el('label', { class: 'sa-hide', title: 'Hide here and on the flow diagrams' }, hide, ' Hidden');
        headRow.append(grip, name, el('span', { class: 'sa-arrow', text: '→' }), to, across, kinds, hideLabel, earlier, later);
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
        headRow.append(el('strong', { class: 'sa-string-title', text: s.Label || s.Id }));
      }
      const count = panels.length + (extra.Panels || 0);
      headRow.appendChild(el('span', { class: 'sa-string-total', text: readings.length
        ? `${(watts / 1000).toFixed(2)} kW` + (volts != null ? ` · ${Math.round(volts)} V` : '') + (readings.length < panels.length ? ` · ${readings.length}/${panels.length}` : '')
        : `${count} panel${count === 1 ? '' : 's'}` }));
      card.appendChild(headRow);
      if (editing) {
        const count = el('input', { type: 'number', min: '0', step: '1', value: String(extra.Panels || 0), class: 'sa-untracked-count', title: 'Panels in this string without an optimizer' })                    ;
        const kind = typeSelect(extra.PanelType || null, 'Type…');
        kind.title = 'Their panel type';
        const apply = () => { setUntracked(s.Id, { Panels: Math.max(0, Math.round(Number(count.value) || 0)) || undefined, PanelType: kind.value || undefined }); changed(); };
        count.onchange = apply;
        kind.onchange = apply;
        card.appendChild(el('div', { class: 'sa-untracked-edit' }, el('span', { text: 'Without optimizers:' }), count, kind));
      }
      const rating = ratingOf(panels, s.Id);
      if (rating) card.appendChild(el('div', { class: 'sa-string-rating', text: rating
        + (electricalOf(s.Id)?.vocCold != null ? ` · cold Voc ${Math.round(electricalOf(s.Id) .vocCold )} V` : '') }));
      if (mppt) mpptIssues(mppt).filter(([, , who]) => who && saSame(who, s.Id)).forEach(([level, text]) =>
        card.appendChild(el('div', { class: `sa-issue is-${level}`, text: (level === 'bad' ? '⛔ ' : '⚠ ') + text })));

      const row = el('div', { class: 'sa-panels' });
      row.style.setProperty?.('--sa-cols', String(colsOf(s.Id)));
      panels.forEach(id => row.appendChild(tile(id, s.Id, { max, median })));
      for (let i = 0; i < (extra.Panels || 0); i++)
        row.appendChild(el('div', { class: 'sa-panel is-untracked', title: 'No optimizer' },
          el('div', { class: 'sa-panel-label', text: `#${panels.length + i + 1}` }),
          el('div', { class: 'sa-panel-value', text: '—' }),
          el('div', { class: 'sa-panel-sub', text: 'no optimizer' })));
      if (!panels.length && !extra.Panels) row.appendChild(el('div', { class: 'sa-empty', text: 'Drop panels here, or add optimizers from the list below.' }));
      if (editing) {
        row.addEventListener('dragover', (e     ) => e.preventDefault());
        row.addEventListener('drop', (e     ) => { e.preventDefault(); if (dragged) { placePanel(dragged, s.Id, null); dragged = null; changed(); } });
        card.addEventListener('dragover', (e     ) => { if (draggedString || dragged) e.preventDefault(); });
        card.addEventListener('dragenter', () => { if ((draggedString && draggedString !== s.Id) || dragged) card.classList.add('is-drop'); });
        card.addEventListener('dragleave', (e     ) => { if (!card.contains?.(e.relatedTarget)) card.classList.remove('is-drop'); });
        card.addEventListener('drop', (e     ) => {
          e.preventDefault();
          if (draggedString && draggedString !== s.Id) { placeString(draggedString, s.Id); draggedString = null; changed(); }
          else if (dragged) { placePanel(dragged, s.Id, null); dragged = null; changed(); }
        });
      }
      card.appendChild(row);
      cards.push({ s, card, mppt });
    });

    // One box per MPPT, its strings inside; strings wired to none last.
    const FIELDS                     = [['MaxVoltage', 'Max input voltage (V)'], ['MinMpptVoltage', 'MPPT range min (V)'],
      ['MaxMpptVoltage', 'MPPT range max (V)'], ['MaxCurrent', 'Max usable current (A)'], ['MaxShortCircuitCurrent', 'Max short-circuit current (A)']];
    const nameOf = (id        ) => saNode(id)?.Label || id;
    const boxIds = [...new Set(cards.map(c => c.mppt))]
      .sort((a, b) => (!a ? 1 : !b ? -1 : nameOf(a).localeCompare(nameOf(b), undefined, { numeric: true })));
    if (editing) {
      const stored = state.data?.Plugins?.tigo?.DesignMinTempC;
      const coldest = el('input', { type: 'number', step: '1', value: typeof stored === 'number' ? String(Math.round(temp.to(stored))) : '', class: 'sa-limit' })                    ;
      coldest.onchange = () => {
        const tigo = ensure(ensure(state.data, 'Plugins', {}), 'tigo', {});
        const v = parseFloat(coldest.value);
        if (Number.isFinite(v)) tigo.DesignMinTempC = Math.round(temp.from(v) * 10) / 10; else delete tigo.DesignMinTempC;
        changed();
      };
      array.appendChild(el('div', { class: 'sa-mppts' },
        el('label', { class: 'sa-limit-field', title: 'Record low at the array, for cold Voc' }, el('span', { text: `Coldest temperature (${temp.unit()})` }), coldest)));
    }
    boxIds.forEach(id => {
      const inBox = cards.filter(c => c.mppt === id);
      const box = el('div', { class: 'sa-mppt-box sa-mppt-card' });
      const head = el('div', { class: 'sa-mppt-head' }, el('strong', { text: id ? nameOf(id) : 'Not wired to an MPPT' }));
      if (id) {
        const es = inBox.map(c => electricalOf(c.s.Id)).filter(Boolean)         ;
        const sumOf = (k        ) => es.reduce((a, e) => a + (e[k] || 0), 0);
        const stc = es.length ? Math.max(...es.map(e => e.voc)) : 0;
        const coldVoc = es.some(e => e.vocCold != null) ? Math.max(...es.map(e => e.vocCold ?? e.voc)) : null;
        if (mpptText(id)) head.appendChild(el('span', { class: 'sa-mppt-now', text: mpptText(id).replace(/^.*? reads /, '') }));
        if (es.length) head.appendChild(el('span', { class: 'sa-mppt-sum',
          text: `Voc ${Math.round(stc)} V${coldVoc != null ? ` (cold ${Math.round(coldVoc)} V)` : ''} · Isc ${sumOf('isc').toFixed(1)} A · Imp ${sumOf('imp').toFixed(1)} A` }));
      }
      box.appendChild(head);
      if (id) {
        const lim = mpptLimits(id);
        if (editing) {
          const grid = el('div', { class: 'sa-limit-grid' });
          FIELDS.forEach(([k, t]) => {
            const input = el('input', { type: 'number', step: '0.1', value: lim[k] ?? '', class: 'sa-limit' })                    ;
            input.onchange = () => { const v = parseFloat(input.value); setMpptLimit(id, k, Number.isFinite(v) ? v : undefined); changed(); };
            grid.appendChild(el('label', { class: 'sa-limit-field' }, el('span', { text: t }), input));
          });
          box.appendChild(grid);
        } else {
          const limits = FIELDS.filter(([k]) => lim[k] != null).map(([k, t]) => `${t.replace(/ \(.*\)$/, '')} ${lim[k]}`).join(' · ');
          box.appendChild(el('div', { class: 'desc sa-mppt-limits', text: limits || 'No limits set. Add them in Edit.' }));
        }
        mpptIssues(id).filter(([, , who]) => !who).forEach(([level, text]) =>
          box.appendChild(el('div', { class: `sa-issue is-${level}`, text: (level === 'bad' ? '⛔ ' : '⚠ ') + text })));
      }
      const inner = el('div', { class: 'sa-mppt-strings' });
      inBox.forEach(c => inner.appendChild(c.card));
      box.appendChild(inner);
      array.appendChild(box);
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

    loose.innerHTML = '';
    const bound = saNodes().map(serialOf).filter(Boolean)            ;
    const unbound = (snap?.optimizers || []).filter((o     ) => !bound.some(b => sameOptimizer(b, String(o.serial))));
    if (unbound.length) {
      loose.appendChild(el('h3', { text: `Not in the array (${unbound.length})` }));
      loose.appendChild(el('div', { class: 'desc', text: 'Optimizers heard on the bus. Put each into a string; its label can be changed after.' }));
      unbound.forEach((o     ) => {
        const pick = el('select', { class: 'sa-adopt' })                     ;
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

  const HIST_METRICS                     = [['realpower', 'power'], ['voltage', 'vin'], ['current', 'iin'], ['temperature', 'temp']];
  const loadAt = async () => {
    const asked = at;
    if (!asked) return;
    const ids = stringsOf().flatMap(st => panelsOf(st.Id));
    const query = ids.flatMap(id => HIST_METRICS.map(([Metric]) => ({ Node: id, Metric }))).concat(mpptQuery());
    let r     ;
    try {
      r = await api(`/api/flow/live?at=${encodeURIComponent(asked.toISOString())}`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(query) });
    } catch (e     ) { r = { body: { ok: false, message: String(e?.message || e) } }; }
    if (at !== asked) return;
    const body = r?.body;
    const next                      = {};
    if (body?.ok) {
      (body.values || []).forEach((v     ) => {
        if (v.value == null) return;
        const field = HIST_METRICS.find(([m]) => m === v.metric)?.[1];
        if (!field) return;
        (next[v.node] = next[v.node] || { ageSeconds: 0, power: 0, vin: 0, iin: 0, temp: 0 })[field] = v.value;
      });
      mpptAt = parseMppt(body.values);
      for (const id of Object.keys(mpptAt)) delete next[id];
      histFailed = Object.keys(next).length ? null : `No history recorded for ${asked.toLocaleString()}.`;
    } else histFailed = body?.message || 'History could not be read.';
    hist = next;
    render();
  };

  const load = async () => {
    let r     ;
    try { r = await api('/api/integrations/tigo/optimizers', { method: 'POST' }); }
    catch (e     ) { r = { body: { ok: false, message: String(e?.message || e) } }; }
    const body = r?.body;
    if (body?.ok && body.result?.ok) { snap = body.result; failed = null; }
    else {
      snap = snap || null;
      failed = body?.message || 'The optimizers could not be read.';
    }
    if (snap && !(snap.connections || []).length)
      failed = 'No TAP bus is set up. Add one on the Tigo TAP settings page.';
    const q = mpptQuery();
    if (q.length) {
      try {
        const m = await api('/api/flow/live', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(q) });
        if (m?.body?.ok && !at) mpptNow = parseMppt(m.body.values);
      } catch { /* keep the last readings */ }
    }
    render();
  };

  setInterval(() => { if (sec.classList.contains('active') && !at && !dragged && !draggedString && !busyInSection(sec)) load(); }, 5000);
  render();
  return { show: () => (at ? loadAt() : load()) };
}
return mount;
