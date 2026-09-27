// Which circuit is this load on? Switch the load itself on and off, and watch which channel steps with it.
// The maths only (#471, #494): the readings between taps become states, each toggle is a step per channel,
// and a step counts when it clears that channel's own noise.

/// One reading of every channel, on the server's clock (ms).
export type Sample = { t: number; v: Record<string, number> };

/// A tap: from this moment (server clock, ms) the load is in this state.
export type Tap = { t: number; on: boolean };

/// One state of the load: what each channel read while it lasted — the median, how many readings, and how
/// much they wandered (a robust standard deviation; null with fewer than three readings).
export type Level = {
  on: boolean;
  from: number;
  to: number;
  mean: Record<string, number>;
  n: Record<string, number>;
  spread: Record<string, number | null>;
};

/// A channel, scored on how it moved with the load.
export type Candidate = {
  node: string;
  label: string;
  /// Toggles it followed: moved the right way, by more than its noise, by a plausible amount.
  matched: number;
  /// Its typical step in the load's direction (median over toggles), in watts.
  step: number;
  /// Its noise, in watts, when there were readings enough to tell.
  noise: number | null;
  missed: number;
  /// How strongly it moved with the load, over every toggle: each toggle adds its step in noise widths
  /// (capped), and a step the wrong way takes away. A load that misses a toggle loses some, not everything.
  score: number;
  /// Its typical step in noise widths.
  clarity: number;
};

export type Finding = {
  toggles: number;
  /// Every channel that moved with the load at all, strongest first.
  candidates: Candidate[];
  /// The channel that stands out, or the two legs of a 240 V breaker; empty while none does.
  found: Candidate[];
  done: boolean;
  verdict: string;
  /// Why nothing stands out, in watts, when nothing does.
  why: string | null;
};

/// The smallest step ever called a change, in watts, whatever a channel's noise.
export const NOISE_FLOOR = 5;

/// How many noise widths a step must clear. Three keeps a channel's own wander from passing as a load.
export const CLEAR_BY = 3;

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

/// Scaled median absolute deviation: a standard deviation that a single odd reading does not drag about.
const robustSpread = (xs: number[]) => {
  if (xs.length < 3) return null;
  const m = median(xs);
  return 1.4826 * median(xs.map(x => Math.abs(x - m)));
};

/// The states the taps mark out. A state's first poll after its tap may still be the old state (the PDU had
/// not read the switch yet), and its last seconds may already be the next one (switched, not yet tapped), so
/// both ends are left out — unless that leaves nothing, when the whole stretch is used and the median copes.
export function levelsFrom(samples: Sample[], taps: Tap[], opts: { now: number; settleMs: number; guardMs: number }): Level[] {
  return taps.map((tap, i) => {
    const open = i + 1 >= taps.length;
    const end = open ? opts.now : taps[i + 1].t;
    // The state still open runs up to now, inclusive; a closed one stops short of the tap that ended it.
    const before = (t: number, margin: number) => open ? t <= end : t < end - margin;
    const inner = samples.filter(s => s.t >= tap.t + opts.settleMs && before(s.t, opts.guardMs));
    const used = inner.length ? inner : samples.filter(s => s.t >= tap.t && before(s.t, 0));
    const per: Record<string, number[]> = {};
    used.forEach(s => Object.entries(s.v).forEach(([k, v]) => { if (Number.isFinite(v)) (per[k] ||= []).push(v); }));
    const level: Level = { on: tap.on, from: tap.t, to: end, mean: {}, n: {}, spread: {} };
    Object.entries(per).forEach(([k, xs]) => { level.mean[k] = median(xs); level.n[k] = xs.length; level.spread[k] = robustSpread(xs); });
    return level;
  });
}

/// A channel's noise: the typical spread of its readings within a state, over the states that had enough.
export function noiseOf(levels: Level[], node: string): number | null {
  const spreads = levels.map(l => l.spread[node]).filter((x): x is number => x != null);
  return spreads.length ? median(spreads) : null;
}

/// A load's own draw bounds the step to expect; without it, anything that clears the noise counts.
const expected = (watts?: number | null) => watts && watts > 0 ? { least: 0.4 * watts, most: 2.5 * watts } : { least: 0, most: Infinity };

/// The smallest step that clears this channel's noise between two states of these sizes.
const threshold = (noise: number | null, n1: number, n2: number) =>
  Math.max(NOISE_FLOOR, noise == null ? 0 : CLEAR_BY * noise * Math.sqrt(1 / Math.max(1, n1) + 1 / Math.max(1, n2)));

/// Two channels stepping by roughly the same amount are the two legs of one 240 V breaker.
const paired = (a: Candidate, b: Candidate) => Math.abs(a.step - b.step) <= 0.3 * Math.max(a.step, b.step);

/// How far ahead the leader has to be to be called: its score against the next one's.
export const STANDS_OUT = 2;

export function analyse(levels: Level[], opts: { watts?: number | null; labels?: Record<string, string>; offered?: (node: string) => boolean } = {}): Finding {
  const labels = opts.labels || {};
  const offered = opts.offered || (() => true);
  const { least, most } = expected(opts.watts);
  const toggles = Math.max(0, levels.length - 1);
  const nodes = new Set<string>();
  levels.forEach(l => Object.keys(l.mean).forEach(k => { if (offered(k)) nodes.add(k); }));

  const all: Candidate[] = [];
  nodes.forEach(node => {
    const noise = noiseOf(levels, node);
    const steps: number[] = [], widths: number[] = [];
    let matched = 0, score = 0;
    for (let i = 1; i < levels.length; i++) {
      const before = levels[i - 1].mean[node], after = levels[i].mean[node];
      if (before == null || after == null) continue;
      // On should raise a channel and off should lower it; a change the other way is not this load.
      const step = (levels[i].on ? 1 : -1) * (after - before);
      const need = threshold(noise, levels[i - 1].n[node], levels[i].n[node]);
      // In noise widths: CLEAR_BY is the line between a step and a wobble.
      const width = CLEAR_BY * step / need;
      const plausible = step >= least && step <= most;
      steps.push(step);
      widths.push(width);
      if (width >= CLEAR_BY && plausible) matched++;
      // Capped, so one huge toggle cannot outvote several; a step of the wrong size for a known draw counts
      // for nothing either way.
      score += plausible ? Math.max(-10, Math.min(20, width)) : Math.min(0, width);
    }
    if (!steps.length) return;
    all.push({ node, label: labels[node] || node, matched, step: median(steps), noise, missed: steps.length - matched,
      score, clarity: median(widths) });
  });

  const candidates = all.filter(c => c.score > 0).sort((a, b) => b.score - a.score || b.step - a.step);
  const [first, second, third] = candidates;
  // Ahead: it followed more toggles than the next channel, or as many and scored well above it. Channels
  // that followed the same toggles by the same amount — the panel shifting together — are never ahead.
  const aheadOf = (c: Candidate, next?: Candidate) => !next || next.score <= 0 || c.matched > next.matched
    || c.score >= STANDS_OUT * next.score;
  // Clear of the noise on half the toggles or more, and well ahead of everything else. A load need not show on every
  // toggle — a slow poll or a load that cycles misses one — but it has to be the one that moves.
  // Half the toggles: a load that fails to switch once misses two — the switch, and the one back.
  const strong = (c?: Candidate) => !!c && c.matched >= Math.max(1, Math.ceil(toggles / 2));
  const legs = strong(first) && strong(second) && paired(first, second) && aheadOf(second, third);
  const found = legs ? [first, second] : strong(first) && aheadOf(first, second) ? [first] : [];
  const done = toggles >= 2 && found.length > 0;
  const why = toggles && !found.length ? whyNothing(candidates, all, levels, opts.watts) : null;
  return { toggles, candidates, found, done, why, verdict: verdictOf(toggles, candidates, found, done, legs, why) };
}

const watts = (w: number) => `${Math.round(w).toLocaleString('en-US')} W`;

/// Nothing stands out: say whether that is because everything moved a little together, or nothing moved, and
/// what a load would have to draw to be seen on these channels.
function whyNothing(candidates: Candidate[], all: Candidate[], levels: Level[], load?: number | null): string {
  const parts: string[] = [];
  const top = candidates.slice(0, 6);
  // Several channels stepping by about the same small amount is the whole panel shifting, not one load.
  const together = top.length >= 3 && top.every(c => Math.abs(c.step - top[0].step) <= Math.max(5, 0.3 * Math.abs(top[0].step)));
  if (together) parts.push(`${top.length} channels moved about ${watts(top[0].step)} together — a shift across the panel, not one load.`);
  else if (candidates[0]) parts.push(`Largest: ${candidates[0].label} ${candidates[0].step >= 0 ? '+' : ''}${watts(candidates[0].step)}`
    + (candidates[0].noise != null ? `, against ±${watts(candidates[0].noise)} of noise.` : '.'));
  else parts.push('No channel moved the way the load did.');
  const noises = all.map(c => c.noise).filter((x): x is number => x != null).sort((a, b) => a - b);
  if (noises.length) {
    const held = median(levels.map(l => Math.max(1, ...Object.values(l.n))));
    const needs = threshold(noises[Math.floor(noises.length / 2)], held, held);
    parts.push(`A load has to draw about ${watts(needs)} to be seen on these channels`
      + (load && load < needs ? ` — ${watts(load)} is below that.` : '.'));
  }
  if (levels.some(l => Math.max(0, ...Object.values(l.n)) < 2)) parts.push('Hold each state for two readings or more.');
  return parts.join(' ');
}

function verdictOf(toggles: number, candidates: Candidate[], found: Candidate[], done: boolean, legs: boolean, why: string | null): string {
  if (!toggles) return 'Now switch the load ON, then tap. There is nothing to compare against yet.';
  const lead = found[0];
  if (legs) return `${done ? '' : 'Leading: '}both legs of a 240 V breaker — ${found[0].label} and ${found[1].label}, stepping ${watts(found[0].step)} each.`
    + (done ? '' : ' Toggle again to confirm.');
  if (lead && done) return `${lead.label} — stepping ${watts(lead.step)} with the load, followed ${lead.matched} of ${toggles} toggles, well ahead of any other channel.`;
  if (lead) return `Leading: ${lead.label}, ${lead.step >= 0 ? '+' : ''}${watts(lead.step)}. Toggle again to confirm.`;
  return `No channel stands out yet. ${why || ''}`.trim();
}
