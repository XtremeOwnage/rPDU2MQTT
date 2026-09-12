// Shared by the two Trends pages: the window, interval and metric controls, the fetch, and how the answer is read.
import { api, btn, el, activate, navLink, instanceSelector, withInstance } from '../helpers.js';
import { hideCard, type Line } from '../charts.js';
import { periodRow, periodWindow, type PeriodKey } from '../history-control.js';

export type Metric = { metric: string; units: string; epoch?: string };

/// A window that can be charted: its query, its name, the metric it implies, and roughly how long it is.
export type Range = { value: string; text: string; wants: 'power' | 'energy'; seconds: number };

export const RANGES: Range[] = [
  { value: 'today=1', text: 'today so far', wants: 'power', seconds: 86_400 },
  { value: 'today=1&back=1', text: 'yesterday', wants: 'power', seconds: 86_400 },
  { value: 'minutes=360', text: 'last 6 hours', wants: 'power', seconds: 21_600 },
  { value: 'minutes=1440', text: 'last 24 hours', wants: 'power', seconds: 86_400 },
  { value: 'days=7', text: 'last 7 days', wants: 'energy', seconds: 7 * 86_400 },
  { value: 'days=14', text: 'last 14 days', wants: 'energy', seconds: 14 * 86_400 },
  { value: 'days=30', text: 'last 30 days', wants: 'energy', seconds: 30 * 86_400 },
  { value: 'days=90', text: 'last 90 days', wants: 'energy', seconds: 90 * 86_400 },
];

/// Auto fits the samples to the chart; per day is one total for each day.
export const INTERVALS: [string, string][] = [
  ['auto', 'auto'], ['60', '1 min'], ['300', '5 min'], ['900', '15 min'], ['1800', '30 min'],
  ['3600', '1 hour'], ['10800', '3 hours'], ['21600', '6 hours'], ['43200', '12 hours'], ['day', 'per day'],
];

/// The steps a fitted interval snaps to.
const NICE_STEPS = [60, 300, 900, 1800, 3600, 10_800, 21_600, 43_200, 86_400];

/// The narrowest a sampled bar is drawn.
export const MIN_BAR_PX = 6;

export const LABELS: Record<string, string> = {
  realpower: 'power', apparentpower: 'apparent power', current: 'current', voltage: 'voltage',
  frequency: 'frequency', energy: 'energy',
};
export const RATES = ['W', 'VA', 'A', 'V', 'Hz'];

/// The smallest offered step that fits `seconds` into `points` samples.
export function stepToFit(seconds: number, points: number) {
  const raw = seconds / Math.max(1, points);
  return NICE_STEPS.find(s => s >= raw) ?? NICE_STEPS[NICE_STEPS.length - 1];
}

/// 3600 -> "1 hour".
export function durationText(seconds: number) {
  const named = INTERVALS.find(([v]) => Number(v) === seconds);
  if (named) return named[1];
  return seconds >= 3600 ? `${Math.round(seconds / 3600)} hours` : `${Math.round(seconds / 60)} min`;
}

/// The return lanes: battery charge and grid export.
export const isReturn = (s: any) => String(s.node || '').endsWith('#in');

/// A return lane is negative, because that is the direction it flows.
export const signed = (s: any): (number | null)[] =>
  isReturn(s) ? s.values.map((v: any) => (v == null ? null : -Math.abs(v))) : s.values;

export type TrendsPage = {
  sec: any; charts: any; status: any;
  body: () => any;
  load: () => Promise<void>;
  draw: () => void;
  days: () => string[];
  perDay: () => boolean;
  summable: () => boolean;
  rate: () => boolean;
  metricName: () => string;
  stacked: () => boolean;
  kind: () => 'bar' | 'line' | 'area';
  fitTo: () => number;
  leadHeight: () => number;
  section: (title: string, note: string, made: { svg: any; gaps: number }, legend: Line[]) => number;
  statusLine: (gaps: number) => string;
  showRange: (value: string) => void;
};

export type TrendsSpec = {
  label: string;
  icon: string;
  /// Whether the page offers the stacked choice; a page whose charts must net their signs always stacks.
  stackable: boolean;
  controls?: (page: TrendsPage) => any[];
  above?: (page: TrendsPage) => any[];
  below?: (page: TrendsPage) => any[];
  render: (page: TrendsPage) => void;
  loaded?: (page: TrendsPage) => void;
  /// On landing here; true when the page started its own load.
  activated?: (page: TrendsPage) => boolean;
};

export function trendsPage(nav: any, sections: any, spec: TrendsSpec) {
  const link = navLink(nav, spec.label, spec.icon);
  link.dataset.section = 'EnergyFlow';
  const sec = el('div', { class: 'section' }); sections.appendChild(sec);
  sec.appendChild(el('h2', { text: spec.label }));
  // Written when the answer arrives, so it describes what was actually charted.
  const desc = el('div', { class: 'desc' });
  sec.appendChild(desc);

  const bar = el('div', { class: 'ld-toolbar' });
  const refresh = btn('Refresh');
  const instSel = instanceSelector(() => load());
  const status = el('span', { class: 'ld-count' });
  const charts = el('div');
  let body: any = null;

  const rangeSel = el('select', { title: 'How far back to chart.' }) as HTMLSelectElement;
  RANGES.forEach(r => rangeSel.appendChild(el('option', { value: r.value, text: r.text })));
  rangeSel.value = 'days=30';
  // Windows the period buttons add, which RANGES does not list.
  const added = new Map<string, Range>();
  const rangeOf = (): Range => RANGES.find(r => r.value === rangeSel.value) || added.get(rangeSel.value)
    || { value: rangeSel.value, text: rangeSel.value, wants: 'power', seconds: 86_400 };
  const multiDay = () => rangeSel.value.startsWith('days=');

  const intervalSel = el('select', { title: 'How far apart the samples are. Auto fits them to the width of the chart; per day is one total for each day.' }) as HTMLSelectElement;
  INTERVALS.forEach(([v, t]) => intervalSel.appendChild(el('option', { value: v, text: t })));
  intervalSel.value = 'auto';
  // Per day only exists across days.
  const syncIntervals = () => {
    const perDayOpt: any = Array.from(intervalSel.children).find((o: any) => o.value === 'day');
    if (perDayOpt) perDayOpt.disabled = !multiDay();
    if (!multiDay() && intervalSel.value === 'day') intervalSel.value = 'auto';
  };
  intervalSel.onchange = () => load();

  const fitTo = () => charts.clientWidth || 1200;
  const maxPoints = () => Math.max(24, Math.floor((fitTo() - 64) / MIN_BAR_PX));
  // The step asked for and the step used once the window is fitted to what the chart can draw; null is per day.
  const plan = (): { asked: number | null; used: number | null } => {
    const choice = intervalSel.value;
    if (choice === 'day' || (choice === 'auto' && multiDay())) return { asked: null, used: null };
    const fit = stepToFit(rangeOf().seconds, maxPoints());
    if (choice === 'auto') return { asked: null, used: fit };
    const asked = Number(choice);
    return { asked, used: Math.max(asked, fit) };
  };

  let METRICS: Metric[] = [
    { metric: 'realpower', units: 'W', epoch: 'instant' },
    { metric: 'energy', units: 'kWh', epoch: 'lifetime' },
  ];
  const metricSel = el('select', { title: 'Which measurement to chart. What the history backend was given is what it can be asked for.' }) as HTMLSelectElement;
  let metricChosen = false;
  const unitsOf = (m: string) => (METRICS.find(x => x.metric === m) || { units: '' }).units;
  const epochOf = (m: string) => (METRICS.find(x => x.metric === m) || {}).epoch || '';
  const rate = () => RATES.includes(unitsOf(metricSel.value));
  const metricName = () => LABELS[metricSel.value] || metricSel.value;
  // Only power and the energy counter are offered; a per-day bar is the counter's rise across that day.
  const chartable = () => METRICS.filter(m => epochOf(m.metric) !== 'period');
  const energyFor = (_range: string) => chartable().find(m => !RATES.includes(m.units));
  const impliedMetric = () => {
    const found = rangeOf().wants === 'power' ? chartable().find(m => RATES.includes(m.units)) : energyFor(rangeSel.value);
    return (found || chartable()[0]).metric;
  };
  const fillMetrics = () => {
    metricSel.innerHTML = '';
    chartable().forEach(m => metricSel.appendChild(el('option', { value: m.metric, text: `${LABELS[m.metric] || m.metric} (${m.units})` })));
    if (!metricChosen) metricSel.value = impliedMetric();
  };
  metricSel.onchange = () => { metricChosen = true; load(); };

  const chartSel = el('select', { title: 'Draw the series as bars, lines or filled areas.' }) as HTMLSelectElement;
  [['bar', 'bars'], ['line', 'lines'], ['area', 'areas']].forEach(([v, t]) => chartSel.appendChild(el('option', { value: v, text: t })));
  const stackBox = el('input') as HTMLInputElement;
  stackBox.type = 'checkbox';
  stackBox.checked = true;
  stackBox.title = 'Stack the series on top of each other. Off, bars sit side by side and areas overlap.';
  // Lines are never stacked.
  const syncStack = () => { stackBox.disabled = chartSel.value === 'line'; };
  chartSel.onchange = () => { syncStack(); draw(); };
  stackBox.onchange = () => draw();

  const periods = periodRow((key: PeriodKey) => {
    const { days } = periodWindow(key);
    const range = key === 'yesterday' ? 'today=1&back=1' : days < 2 ? 'today=1' : `days=${days}`;
    if (days >= 2 && !RANGES.some(r => r.value === range) && !added.has(range)) {
      const text = `${key === 'week' ? 'this week' : key === 'month' ? 'this month' : 'this year'} (${days} days)`;
      added.set(range, { value: range, text, wants: 'energy', seconds: days * 86_400 });
      rangeSel.appendChild(el('option', { value: range, text }));
    }
    rangeSel.value = range;
    syncIntervals();
    const energy = energyFor(range);
    if (energy) { metricSel.value = energy.metric; metricChosen = true; }
    periods.mark(key);
    load();
  });
  rangeSel.onchange = () => { periods.mark(null); syncIntervals(); if (!metricChosen) metricSel.value = impliedMetric(); load(); };

  // A counter's readings are not a per-bar quantity; the differences between them are, and a fall is a gap.
  const toDeltas = (b: any) => {
    (b.series || []).forEach((s: any) => {
      const raw = s.values as (number | null)[];
      s.values = raw.map((v, i) => {
        if (i === 0 || v == null) return null;
        const prev = raw[i - 1];
        if (prev == null) return null;
        return v - prev < 0 ? null : v - prev;
      });
    });
    b.deltas = true;
  };

  const perDay = () => !!body?.days;
  const summable = () => (perDay() || !!body?.deltas) && !rate();
  const running = () => !rangeSel.value.includes('back=');
  const leadHeight = () => Math.max(240, Math.min(Math.round((window.innerHeight || 900) * 0.34), 420));

  // A day carries the server's period key; a sampled instant is named in the reader's clock, with its date past a day.
  const days = (): string[] => {
    if (body?.days) return body.days;
    const at: string[] = body?.at || [];
    const long = at.length > 1 && new Date(at[at.length - 1]).getTime() - new Date(at[0]).getTime() > 36 * 3_600_000;
    return at.map(iso => long
      ? new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
      : new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
  };

  // Where a sampled window fell, in the reader's own clock.
  const windowNote = (at: string[] | undefined) => {
    if (perDay() || !at?.length) return '';
    const from = new Date(at[0]), to = new Date(at[at.length - 1]);
    const clock = (d: Date) => d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return ` · ${from.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${clock(from)} → ${clock(to)}`;
  };

  const describe = () => {
    const from = 'read from the history backend.';
    if (perDay()) {
      desc.textContent = `Daily ${metricName()} totals over time, ${from} A day the backend has no reading `
        + 'for is left empty rather than drawn as zero, and is left out of every total.';
      return;
    }
    const every = body?.stepSeconds ? `every ${durationText(body.stepSeconds)}` : 'sampled';
    const name = `${metricName().charAt(0).toUpperCase()}${metricName().slice(1)}`;
    if (body?.deltas) {
      desc.textContent = `${name} ${every} through the window, ${from} Each bar is what changed between two `
        + 'readings of the counter, so the bars add up rather than each restating it. An interval either reading is missing from is left empty.';
      return;
    }
    desc.textContent = `${name} ${every} through the window, ${from} A sample the backend has no reading `
      + 'for is left empty rather than drawn as zero.'
      + (rate() ? ' These are instantaneous readings, so they are not added up.' : '');
  };

  const section = (title: string, note: string, made: { svg: any; gaps: number }, legend: Line[]) => {
    const box = el('div', { style: { margin: '18px 0 4px' } });
    box.appendChild(el('h3', { text: title, style: { margin: '4px 0', fontSize: '15px' } }));
    if (note) box.appendChild(el('div', { class: 'desc', text: note }));
    const scroll = el('div', { style: { overflowX: 'auto', paddingBottom: '4px' } });
    scroll.appendChild(made.svg);
    box.appendChild(scroll);
    if (legend.length) {
      const row = el('div', { class: 'ld-toolbar', style: { flexWrap: 'wrap', gap: '10px' } });
      legend.forEach(l => row.appendChild(el('span', { class: 'desc', style: { margin: '0' } },
        el('span', { class: 'trend-swatch', style: { background: l.color } }), l.label)));
      box.appendChild(row);
    }
    charts.appendChild(box);
    // A window still filling opens at its newest bars; one that has ended opens at its start.
    if (running()) scroll.scrollLeft = scroll.scrollWidth;
    return made.gaps;
  };

  const statusLine = (gaps: number) => {
    const p = plan();
    const widened = p.asked != null && p.used != null && p.used > p.asked
      ? ` · interval widened from ${durationText(p.asked)} to ${durationText(p.used)} to fit the chart` : '';
    const capped = body?.requestedStepSeconds && body?.stepSeconds > body.requestedStepSeconds
      ? ` · sampled every ${durationText(body.stepSeconds)}, the finest this window allows` : '';
    return `${days().length} ${perDay() ? 'day(s)' : 'sample(s)'} from ${body.source}`
      + windowNote(body.at)
      + (gaps ? ` · ${gaps} with no reading` : '')
      + (body.partial ? ` · ${body.partial} still in progress` : '')
      + widened + capped;
  };

  const showRange = (value: string) => {
    const clean = value.replace(/&step=\d+/g, '');
    if (!RANGES.some(r => r.value === clean)) return;
    rangeSel.value = clean;
    syncIntervals();
    if (!metricChosen) metricSel.value = impliedMetric();
  };

  const draw = () => { hideCard(); charts.innerHTML = ''; describe(); spec.render(page); };

  const load = async () => {
    status.textContent = 'loading…';
    const p = plan();
    const counterEpoch = epochOf(metricSel.value);
    // A counter's first day needs the reading before it, so one more day-end is asked for and dropped after differencing.
    const lead = p.used == null && counterEpoch === 'lifetime';
    const range = lead ? rangeSel.value.replace(/days=(\d+)/, (_, n) => `days=${Number(n) + 1}`) : rangeSel.value;
    const query = range + (p.used != null ? `&step=${p.used}` : '') + '&metric=' + encodeURIComponent(metricSel.value);
    let r: any;
    try { r = await api(withInstance('/api/flow/series?' + query, instSel)); }
    catch (e: any) { r = { body: { ok: false, message: 'Could not reach the bridge: ' + (e?.message || 'the request failed') } }; }
    body = r.body;
    if (body?.ok && (counterEpoch === 'lifetime' || (!body.days && counterEpoch === 'period'))) toDeltas(body);
    if (body?.ok && lead && body.days?.length > 1) {
      body.days = body.days.slice(1);
      if (body.at) body.at = body.at.slice(1);
      (body.series || []).forEach((x: any) => { x.values = x.values.slice(1); });
    }
    if (!body?.ok) {
      draw();
      status.textContent = '';
      charts.appendChild(el('div', { class: 'desc', style: { color: 'var(--bad)' }, text: body?.message || 'Could not load the series.' }));
      return;
    }
    spec.loaded?.(page);
    draw();
  };

  const page: TrendsPage = {
    sec, charts, status, body: () => body, load, draw, days, perDay, summable, rate, metricName,
    stacked: () => stackBox.checked && chartSel.value !== 'line',
    kind: () => chartSel.value as 'bar' | 'line' | 'area', fitTo, leadHeight, section, statusLine, showRange,
  };

  sec.appendChild(periods.row);
  bar.append(refresh,
    el('label', { class: 'ld-inst' }, 'Show ', rangeSel),
    el('label', { class: 'ld-inst' }, 'every ', intervalSel),
    el('label', { class: 'ld-inst' }, 'of ', metricSel),
    el('label', { class: 'ld-inst' }, 'as ', chartSel),
    ...(spec.stackable ? [el('label', { class: 'ld-inst' }, stackBox, ' stacked')] : []),
    ...(spec.controls?.(page) || []),
    instSel.wrap, status);
  sec.appendChild(bar);
  (spec.above?.(page) || []).forEach(x => sec.appendChild(x));
  sec.appendChild(charts);
  (spec.below?.(page) || []).forEach(x => sec.appendChild(x));
  fillMetrics();
  syncIntervals();
  syncStack();

  refresh.onclick = () => load();
  let metricsAsked = false;
  const loadMetrics = async () => {
    if (metricsAsked) return;
    metricsAsked = true;
    try {
      const r: any = await api('/api/flow/metrics');
      if (r?.body?.ok && r.body.metrics?.length) { METRICS = r.body.metrics; fillMetrics(); }
    } catch { /* the page still works with the metrics it was seeded with */ }
  };

  link.onclick = () => { activate(link, sec); loadMetrics(); if (!spec.activated?.(page) && !body) load(); };
  // Landing here from another page's click is collected when this section becomes visible.
  window.addEventListener('rpdu:activate', () => { if (sec.classList.contains('active')) spec.activated?.(page); });
  return { link, sec, page };
}
