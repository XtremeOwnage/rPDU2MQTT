// The "show a past moment" control, its query (`at`, `span`) and the sentence describing what came back.
import { el, btn, openSheet, closeSheet } from '../helpers.js';
import { state } from '../state.js';

/// The periods people actually ask for. One click each, rather than a date, a time and a span to assemble.
export type PeriodKey = 'today' | 'yesterday' | 'week' | 'lastweek' | 'month' | 'lastmonth' | 'year';

/// Shortest first.
export const PERIODS: [PeriodKey, string][] = [
  ['today', 'Today'], ['yesterday', 'Yesterday'], ['week', 'This week'], ['lastweek', 'Last week'],
  ['month', 'This month'], ['lastmonth', 'Last month'], ['year', 'This year'],
];

/// Which day a period ends on, and how many days it covers — in the reader's own calendar, because that is
/// the calendar the words "this month" were said in.
export function periodWindow(key: PeriodKey, now: Date = new Date()): { day: string; days: number } {
  const iso = (d: Date) => d.toLocaleDateString('en-CA');
  if (key === 'yesterday') {
    const d = new Date(now.getTime());
    d.setDate(d.getDate() - 1);
    return { day: iso(d), days: 1 };
  }
  if (key === 'week') return { day: iso(now), days: now.getDay() + 1 };
  if (key === 'lastweek') {
    const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() - now.getDay() - 1);
    return { day: iso(end), days: 7 };
  }
  if (key === 'lastmonth') {
    const end = new Date(now.getFullYear(), now.getMonth(), 0);
    return { day: iso(end), days: end.getDate() };
  }
  if (key === 'month') return { day: iso(now), days: now.getDate() };
  if (key === 'year') {
    const jan1 = new Date(now.getFullYear(), 0, 1);
    // Whole days between two local midnights: the difference in ms divided by a day is off by an hour
    // twice a year, and rounding puts it back.
    return { day: iso(now), days: Math.round((now.setHours(0, 0, 0, 0) - jan1.getTime()) / 86_400_000) + 1 };
  }
  return { day: iso(now), days: 1 };
}

/// The time every data page shows, set from the header and followed by each page.
/// A preset period, or a day (optionally a time on it) and how many days to it.
export type SharedRange = { kind: 'live' } | { kind: 'period'; key: PeriodKey } | { kind: 'day'; day: string; time: string; days: number };
export const LIVE: SharedRange = { kind: 'live' };
const RANGE_KEY = 'rpdu-range';
const sameRange = (a: SharedRange, b: SharedRange) => JSON.stringify(a) === JSON.stringify(b);
// Kept for the browser session, so a new visit opens live.
let sharedRange: SharedRange = (() => {
  try {
    const r = JSON.parse(sessionStorage.getItem(RANGE_KEY) || 'null');
    if (r?.kind === 'period' && PERIODS.some(([k]) => k === r.key)) return { kind: 'period', key: r.key };
    if (r?.kind === 'day' && /^\d{4}-\d{2}-\d{2}$/.test(r.day)) return { kind: 'day', day: r.day, time: String(r.time || ''), days: Math.max(1, Number(r.days) || 1) };
  } catch { /* none kept */ }
  return LIVE;
})();
/// Bumped on every change, so a page that was not showing can tell it has a change to catch up on.
let rangeVersion = sharedRange.kind === 'live' ? 0 : 1;

export const currentRange = () => sharedRange;

/// The day a range ends on, the time on it ('' for the whole day) and the days it covers; null for live.
export function rangeSpan(r: SharedRange): { day: string; time: string; days: number } | null {
  if (r.kind === 'period') return { ...periodWindow(r.key), time: '' };
  if (r.kind === 'day') return { day: r.day, time: r.time, days: r.days };
  return null;
}

/// How the range reads on the header button.
export function rangeLabel(r: SharedRange): string {
  if (r.kind === 'live') return 'Live';
  if (r.kind === 'period') return (PERIODS.find(([k]) => k === r.key) || [, ''])[1] as string;
  const day = new Date(`${r.day}T12:00:00`).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
  if (r.days > 1) return `${r.days} days to ${day}`;
  return r.time ? `${day}, ${r.time.slice(0, 5)}` : day;
}

export function setRange(r: SharedRange) {
  if (sameRange(r, sharedRange)) return;
  sharedRange = r;
  rangeVersion++;
  try { sessionStorage.setItem(RANGE_KEY, JSON.stringify(r)); } catch { /* this page only */ }
  try { window.dispatchEvent?.(new CustomEvent('rpdu:range')); } catch { /* no CustomEvent: pages keep their own */ }
}

/// Applies the shared range to a page while it is showing: at once if it is, when it is next opened if not.
export function followRange(sec: HTMLElement, apply: (r: SharedRange) => void) {
  let seen = 0;
  const sync = () => {
    if (seen === rangeVersion || !sec.classList.contains('active')) return;
    seen = rangeVersion;
    apply(sharedRange);
  };
  window.addEventListener?.('rpdu:range', sync);
  window.addEventListener?.('rpdu:activate', sync);
}

/// The header's time control: "Back to live" while showing the past, and a button that opens the picker.
export function rangeBar(): HTMLElement {
  const wrap = el('span', { class: 'range-bar' });
  const live = el('button', { class: 'range-live', type: 'button', title: 'Back to the current reading' },
    el('span', { class: 'dot good' }), el('span', { text: 'Back to live' })) as HTMLButtonElement;
  const open = el('button', { class: 'range-open', type: 'button', title: 'Show a time in the past on every page' }) as HTMLButtonElement;
  // The arrows move by what is shown: a day at a time on a day, a week at a time on a week.
  const prev = el('button', { class: 'range-step', type: 'button', text: '◀' }) as HTMLButtonElement;
  const next = el('button', { class: 'range-step', type: 'button', text: '▶' }) as HTMLButtonElement;
  prev.onclick = () => stepRange(-1);
  next.onclick = () => stepRange(1);
  live.onclick = () => setRange(LIVE);
  open.onclick = () => openRangePicker();
  wrap.append(live, prev, open, next);
  const sync = () => {
    const past = sharedRange.kind !== 'live';
    live.hidden = prev.hidden = next.hidden = !past;
    const span = rangeSpan(sharedRange);
    const step = !span ? '' : span.days === 1 ? 'day' : span.days === 7 ? 'week' : `${span.days} days`;
    prev.title = `Previous ${step}`;
    next.title = `Next ${step}`;
    next.disabled = !!span && span.day >= new Date().toLocaleDateString('en-CA');
    open.textContent = '';
    open.append(el('span', { class: 'range-icon', text: '🕘', 'aria-hidden': 'true' }), el('span', { text: past ? rangeLabel(sharedRange) : 'Historical' }));
    open.classList[past ? 'add' : 'remove']('is-past');
    // The past exists only with a history backend.
    wrap.classList[((state.data && state.data.History) || {}).Enabled ? 'remove' : 'add']('is-hidden');
  };
  window.addEventListener?.('rpdu:range', sync);
  window.addEventListener?.('rpdu:activate', sync);
  syncRangeBar = sync;
  sync();
  return wrap;
}
let syncRangeBar = () => { };

/// Moves the shown range back or forward by its own length, never past today: nothing is recorded there.
function stepRange(dir: number) {
  const span = rangeSpan(sharedRange);
  if (!span) return;
  const d = new Date(span.day + 'T12:00:00');   // midday, so a DST shift cannot land on the previous day
  d.setDate(d.getDate() + dir * span.days);
  const today = new Date().toLocaleDateString('en-CA');
  const day = d.toLocaleDateString('en-CA');
  setRange({ kind: 'day', day: day > today ? today : day, time: span.time, days: span.days });
}
/// Re-reads whether History is on, once the configuration has loaded.
export const refreshRangeBar = () => syncRangeBar();

/// The picker: one-click periods, or a day, a time on it and how many days to it.
export function openRangePicker() {
  const body = el('div', { class: 'range-sheet' });
  const pick = (r: SharedRange) => { setRange(r); closeSheet(); };

  body.appendChild(el('div', { class: 'range-h', text: 'Periods' }));
  const grid = el('div', { class: 'range-grid' });
  PERIODS.forEach(([key, label]) => {
    const b = btn(label);
    if (sharedRange.kind === 'period' && sharedRange.key === key) b.classList.add('primary');
    b.onclick = () => pick({ kind: 'period', key });
    grid.appendChild(b);
  });
  body.appendChild(grid);

  body.appendChild(el('div', { class: 'range-h', text: 'A specific day' }));
  const today = new Date().toLocaleDateString('en-CA');
  const cur = sharedRange.kind === 'day' ? sharedRange : null;
  const day = el('input', { type: 'date', max: today, value: cur?.day || today }) as HTMLInputElement;
  const time = el('input', { type: 'time', value: cur?.time || '' }) as HTMLInputElement;
  const span = el('select') as HTMLSelectElement;
  [['1', 'that day'], ['7', '7 days to it'], ['14', '14 days to it'], ['30', '30 days to it'], ['90', '90 days to it']]
    .forEach(([v, t]) => span.appendChild(el('option', { value: v, text: t })));
  span.value = String(cur?.days || 1);
  if (span.value !== String(cur?.days || 1)) { span.appendChild(el('option', { value: String(cur!.days), text: `${cur!.days} days to it` })); span.value = String(cur!.days); }
  // A time within the day says nothing about a run of days.
  const syncTime = () => { time.disabled = span.value !== '1'; if (time.disabled) time.value = ''; };
  span.onchange = syncTime;
  syncTime();
  body.appendChild(el('div', { class: 'range-form' },
    el('label', {}, el('span', { text: 'Day' }), day),
    el('label', {}, el('span', { text: 'Time (optional)' }), time),
    el('label', {}, el('span', { text: 'Covering' }), span)));
  body.appendChild(el('div', { class: 'desc', text: 'Leave the time blank for the whole day\u2019s totals. Every data page shows this until you go back to live.' }));

  const apply = btn('Show this', 'primary');
  apply.onclick = () => {
    if (!day.value) return;
    pick({ kind: 'day', day: day.value > today ? today : day.value, time: time.value, days: Math.max(1, Number(span.value) || 1) });
  };
  const live = btn('Back to live');
  live.onclick = () => pick(LIVE);
  openSheet({ title: 'Show a time in the past', body, footer: [live, apply] });
}

/// The `at`/`span` part of a flow query, and the sentence that says what came back.
export function historyQuery(hist: { at: () => string, span: () => number }): string {
  const at = hist.at();
  if (!at) return '';
  const span = hist.span();
  return '&at=' + encodeURIComponent(at) + (span > 1 ? '&span=' + span : '');
}

export function historyNote(body: any): string {
  if (!body || !body.historical) return '';
  const when = new Date(body.at).toLocaleString();
  const days = Number(body.spanDays) || 1;
  const what = days > 1 ? `${days} days to ${new Date(body.at).toLocaleDateString()}` : when;
  // A window with days missing from it is not that window.
  const short = (body.incomplete || []) as { node: string, days: number }[];
  const gap = short.length
    ? ` · incomplete: ${short.slice(0, 4).map(x => `${x.node} ${x.days}/${days}d`).join(', ')}${short.length > 4 ? `, +${short.length - 4} more` : ''}`
    : '';
  return `showing ${what} from ${body.source}${gap}`;
}

/// Which part of the moment was just changed, so the caller can tell a whole day from an instant.
export type HistoryPick = 'day' | 'time' | 'span' | 'live';

/// A "show this moment instead of now" control (#372). Returns the ISO instant to request, or '' for live.
/// `headless` keeps the controls out of the page: only the LIVE/HISTORICAL badge and the note are shown, and the
/// header's picker sets the moment through `set`.
export function historyControl(onChange: (what: HistoryPick) => void, headless = false): {
  row: HTMLElement, at: () => string, day: () => string, time: () => string, span: () => number,
  setNote: (t: string) => void, set: (day: string, days: number, time?: string) => void, goLive: () => void
} {
  const row = el('div', { class: 'ld-toolbar history-bar', style: { flexWrap: 'wrap', gap: '8px', margin: '0 0 8px' } });
  // Separate date and time inputs, not a datetime-local: that control reports '' until both halves are filled.
  const input = el('input', { type: 'date' }) as HTMLInputElement;
  const timeIn = el('input', { type: 'time', step: '1' }) as HTMLInputElement;
  const prev = btn('◀');
  const next = btn('▶');
  const live = btn('Live', 'primary');
  // Which of the two things you are looking at, said plainly and in the same place every time.
  const badge = el('span', { class: 'pill good', text: 'LIVE' });
  const note = el('span', { class: 'desc', style: { margin: '0' } });


  live.title = 'Back to the current reading';

  const today = () => new Date().toLocaleDateString('en-CA');   // yyyy-mm-dd in local time
  const spanDays = () => Math.max(1, Number(spanSel.value) || 1);

  // The arrows move by whatever is being shown: a day at a time on a single day.
  const step = (dir: number) => {
    const from = input.value || today();
    const d = new Date(from + 'T12:00:00');   // midday, so a DST shift cannot land on the previous day
    d.setDate(d.getDate() + dir * spanDays());
    const iso = d.toLocaleDateString('en-CA');
    input.value = iso > today() ? today() : iso;   // no future days: there is nothing recorded there
    onChange('day');
  };

  input.onchange = () => onChange('day');
  timeIn.onchange = () => onChange('time');
  prev.onclick = () => step(-1);
  next.onclick = () => step(1);
  const stepLabel = () => { const n = spanDays(); return n === 1 ? 'day' : n === 7 ? 'week' : `${n} days`; };
  live.onclick = () => { input.value = ''; timeIn.value = ''; spanSel.value = '1'; syncSpan(); note.textContent = ''; onChange('live'); };

  // The picker exists only if there is a backend to read from.
  const historyOn = () => !!((state.data && state.data.History) || {}).Enabled;
  const syncEnabled = () => {
    const on = historyOn();
    row.classList[on ? 'remove' : 'add']('is-hidden');
    // A day still selected when the feature is switched off has to stop being requested.
    if (!on && input.value) { input.value = ''; timeIn.value = ''; spanSel.value = '1'; note.textContent = ''; onChange('live'); }
  };

  // One control rather than five: the arrows and inputs share a border and only the outer corners round.
  const group = el('div', { class: 'input-group' }, prev, input, timeIn, next);

  // How much of the past to add up.
  const spanSel = el('select', { title: 'Add up the daily totals over this many days, ending on the chosen day.' }) as HTMLSelectElement;
  [['1', 'that day'], ['7', '7 days to it'], ['30', '30 days to it']]
    .forEach(([v, t]) => spanSel.appendChild(el('option', { value: v, text: t })));
  spanSel.onchange = () => { syncSpan(); onChange('span'); };

  // A time within the day says nothing about a week of them, so the two cannot both be set.
  const syncSpan = () => {
    prev.title = 'Previous ' + stepLabel();
    next.title = 'Next ' + stepLabel();
    const many = spanDays() > 1;
    timeIn.disabled = many;
    if (many) timeIn.value = '';
    timeIn.title = many
      ? 'Not used over a span of days — each day is counted whole.'
      : 'Optional. Leave blank for the end of the day — the day’s complete totals.';
  };

  if (headless) row.append(badge, note);
  else row.append(badge, el('span', { class: 'desc', style: { margin: '0' }, text: 'At:' }), group,
    el('span', { class: 'desc', style: { margin: '0' }, text: 'covering' }), spanSel, live, note);
  syncSpan();
  syncEnabled();
  window.addEventListener?.('rpdu:activate', syncEnabled);
  return {
    row,
    /// Back to the current reading, as the Live button does.
    goLive: () => live.onclick!({} as any),
    /// Show a period: the day it ends on, and how many days it covers. A span the fixed list does not offer
    /// (this month is however many days into the month it is) is added to it, so the control still reads as
    /// one setting rather than going blank.
    set: (day: string, days: number, time = '') => {
      input.value = day;
      timeIn.value = days > 1 ? '' : time;
      const want = String(Math.max(1, days));
      if (!Array.from(spanSel.children).some((o: any) => o.value === want))
        spanSel.appendChild(el('option', { value: want, text: `${want} days to it` }));
      spanSel.value = want;
      syncSpan();
    },
    /// The instant to ask for.
    at: () => {
      if (!historyOn() || !input.value) return '';
      const when = new Date(`${input.value}T${timeIn.value || '23:59:59'}`);
      const now = new Date();
      return (when > now ? now : when).toISOString();
    },
    day: () => (historyOn() ? input.value : ''),
    time: () => timeIn.value,
    /// Days to add up, ending on the chosen day. 1 is the plain "that moment" view.
    span: () => (historyOn() && input.value ? spanDays() : 1),
    setNote: (t: string) => {
      note.textContent = t;
      // The badge follows what was actually rendered.
      const past = !!t;
      badge.className = 'pill ' + (past ? 'warn' : 'good');
      badge.textContent = past ? 'HISTORICAL' : 'LIVE';
      badge.title = past ? t : 'These are the latest readings.';
    },
  };
}

// The tag selected on the diagram, kept across redraws: the Sankey repaints on every live push.
