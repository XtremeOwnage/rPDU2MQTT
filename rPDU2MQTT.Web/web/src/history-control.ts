// The "show a past moment" control, its query (`at`, `span`) and the sentence describing what came back.
import { el, btn } from '../helpers.js';
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

/// The period chosen in the header or on any page, shared so it follows the reader from view to view.
/// 'live' is the current reading. Kept for the browser session, so a new visit opens live.
export type SharedRange = PeriodKey | 'live';
const RANGE_KEY = 'rpdu-range';
let sharedRange: SharedRange = (() => {
  try { const v = sessionStorage.getItem(RANGE_KEY); return PERIODS.some(([k]) => k === v) ? v as PeriodKey : 'live'; } catch { return 'live'; }
})();
/// Bumped on every change, so a page that was not showing can tell it has a change to catch up on.
let rangeVersion = sharedRange === 'live' ? 0 : 1;

export const currentRange = () => sharedRange;

/// Sets the shared period and tells every page. `seen` is the follower that made the change, which already shows it.
export function setRange(r: SharedRange, seen?: { v: number }) {
  if (r === sharedRange) return;
  sharedRange = r;
  rangeVersion++;
  if (seen) seen.v = rangeVersion;
  try { sessionStorage.setItem(RANGE_KEY, r); } catch { /* this page only */ }
  try { window.dispatchEvent?.(new CustomEvent('rpdu:range')); } catch { /* no CustomEvent: pages keep their own */ }
}

/// Applies the shared period to a page while it is showing: at once if it is, when it is next opened if not.
export function followRange(sec: HTMLElement, apply: (r: SharedRange) => void): { v: number } {
  const seen = { v: 0 };
  const sync = () => {
    if (seen.v === rangeVersion || !sec.classList.contains('active')) return;
    seen.v = rangeVersion;
    apply(sharedRange);
  };
  window.addEventListener?.('rpdu:range', sync);
  window.addEventListener?.('rpdu:activate', sync);
  return seen;
}

/// A row of one-click periods, with the one being shown marked.
/// `before`: buttons for windows shorter than a day, placed first.
/// `follow`: the page the row is on, so a period picked anywhere is picked here too; `live` returns it to now.
export function periodRow(onPick: (key: PeriodKey) => void, before: HTMLElement[] = [],
  follow?: { sec: HTMLElement, live?: () => void }): { row: HTMLElement; mark: (key: PeriodKey | null) => void; share: (r: SharedRange) => void } {
  const row = el('div', { class: 'ld-toolbar period-row', style: { gap: '6px', margin: '0 0 8px' } });
  row.appendChild(el('span', { class: 'desc', style: { margin: '0' }, text: 'Period:' }));
  before.forEach(b => row.appendChild(b));
  const seen = follow
    ? followRange(follow.sec, r => { if (r !== 'live') onPick(r); else follow.live?.(); })
    : { v: 0 };
  const share = (r: SharedRange) => { if (follow) setRange(r, seen); };
  const buttons = PERIODS.map(([key, label]) => {
    const b = btn(label);
    b.dataset.period = key;
    b.onclick = () => { share(key); onPick(key); };
    row.appendChild(b);
    return b;
  });
  return {
    row,
    mark: (key) => buttons.forEach(b => b.classList[b.dataset.period === key ? 'add' : 'remove']('primary')),
    share,
  };
}

/// The header's period picker: sets the shared period, and shows the one in use.
export function rangePicker(): HTMLElement {
  const sel = el('select', { class: 'range-pick', title: 'The period every page shows. It follows you from page to page.', 'aria-label': 'Period' }) as HTMLSelectElement;
  sel.appendChild(el('option', { value: 'live', text: 'Live' }));
  PERIODS.forEach(([key, label]) => sel.appendChild(el('option', { value: key, text: label })));
  const sync = () => {
    sel.value = sharedRange;
    // Only the present exists without a history backend.
    sel.classList[((state.data && state.data.History) || {}).Enabled ? 'remove' : 'add']('is-hidden');
  };
  sel.onchange = () => setRange(sel.value as SharedRange);
  window.addEventListener?.('rpdu:range', sync);
  window.addEventListener?.('rpdu:activate', sync);
  sync();
  return sel;
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
export function historyControl(onChange: (what: HistoryPick) => void): {
  row: HTMLElement, at: () => string, day: () => string, time: () => string, span: () => number,
  setNote: (t: string) => void, set: (day: string, days: number) => void, goLive: () => void
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

  row.append(badge, el('span', { class: 'desc', style: { margin: '0' }, text: 'At:' }), group,
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
    set: (day: string, days: number) => {
      input.value = day;
      timeIn.value = '';
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
