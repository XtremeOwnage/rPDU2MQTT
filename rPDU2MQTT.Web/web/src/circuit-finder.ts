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

/// A channel that stepped with the load at least once, or came close.
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
};

export type Finding = {
  toggles: number;
  candidates: Candidate[];
  /// The channels that followed every toggle — two of them when a 240 V load steps both legs.
  found: Candidate[];
  done: boolean;
  verdict: string;
  /// Why nothing matched, in watts, when nothing did.
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

export function analyse(levels: Level[], opts: { watts?: number | null; labels?: Record<string, string>; offered?: (node: string) => boolean } = {}): Finding {
  const labels = opts.labels || {};
  const offered = opts.offered || (() => true);
  const { least, most } = expected(opts.watts);
  const toggles = Math.max(0, levels.length - 1);
  const nodes = new Set<string>();
  levels.forEach(l => Object.keys(l.mean).forEach(k => { if (offered(k)) nodes.add(k); }));

  type Seen = { steps: number[]; matched: number; needs: number[] };
  const seen: Record<string, Seen> = {};
  nodes.forEach(node => {
    const noise = noiseOf(levels, node);
    const s: Seen = { steps: [], matched: 0, needs: [] };
    for (let i = 1; i < levels.length; i++) {
      const before = levels[i - 1].mean[node], after = levels[i].mean[node];
      if (before == null || after == null) continue;
      // On should raise a channel and off should lower it; a change the other way is not this load.
      const step = (levels[i].on ? 1 : -1) * (after - before);
      const need = Math.max(least, threshold(noise, levels[i - 1].n[node], levels[i].n[node]));
      s.steps.push(step);
      s.needs.push(need);
      if (step >= need && step <= most) s.matched++;
    }
    if (s.steps.length) seen[node] = s;
  });

  const all: Candidate[] = Object.entries(seen).map(([node, s]) => ({
    node, label: labels[node] || node, matched: s.matched, step: median(s.steps),
    noise: noiseOf(levels, node), missed: s.steps.length - s.matched,
  }));
  // Near-misses stay listed, ranked: a channel that moved the right way on most toggles, or by most of what
  // it needed, is where to look when nothing has cleared the bar yet.
  const closeness = (c: Candidate) => {
    const s = seen[c.node];
    return median(s.steps.map((st, i) => st / s.needs[i]));
  };
  const candidates = all
    .filter(c => c.matched > 0 || (c.step > 0 && closeness(c) >= 0.5))
    .sort((a, b) => b.matched - a.matched || closeness(b) - closeness(a) || b.step - a.step);

  const found = candidates.filter(c => c.matched === toggles && toggles > 0);
  const legs = found.length === 2 && paired(found[0], found[1]);
  const done = toggles >= 2 && (found.length === 1 || legs);
  const why = toggles && !found.length ? whyNothing(all, levels, opts.watts) : null;
  return { toggles, candidates, found, done, why, verdict: verdictOf(toggles, candidates, found, done, legs, why) };
}

const watts = (w: number) => `${Math.round(w).toLocaleString('en-US')} W`;

/// Nothing followed every toggle: say what the biggest step was against the noise, and what a load would
/// have to draw to be seen on these channels.
function whyNothing(all: Candidate[], levels: Level[], load?: number | null): string {
  const biggest = [...all].sort((a, b) => b.step - a.step)[0];
  const noises = all.map(c => c.noise).filter((x): x is number => x != null);
  const typical = noises.length ? noises.sort((a, b) => a - b)[Math.floor(noises.length / 2)] : null;
  const thin = levels.some(l => Math.max(0, ...Object.values(l.n)) < 2);
  const parts: string[] = [];
  if (biggest && biggest.step > 0)
    parts.push(`Largest step: ${biggest.label} ${biggest.step >= 0 ? '+' : ''}${watts(biggest.step)}`
      + (biggest.noise != null ? `, against ±${watts(biggest.noise)} of noise on that channel.` : '.'));
  else parts.push('No channel moved the way the load did.');
  if (typical != null) {
    // What a step between two states of the size these ones have been has to clear.
    const held = median(levels.map(l => Math.max(1, ...Object.values(l.n))));
    const needs = threshold(typical, held, held);
    parts.push(`On these channels a load has to draw about ${watts(needs)} to be seen`
      + (load && load < needs ? ` — ${watts(load)} is below that.` : '.'));
  }
  if (thin) parts.push('A state held for under two readings says little: hold each one longer.');
  return parts.join(' ');
}

function verdictOf(toggles: number, candidates: Candidate[], found: Candidate[], done: boolean, legs: boolean, why: string | null): string {
  if (!toggles) return 'Now switch the load ON, then tap. There is nothing to compare against yet.';
  if (done && legs) return `Both legs of a 240 V breaker: ${found[0].label} and ${found[1].label}, stepping ${watts(found[0].step)} each.`;
  if (done) return `${found[0].label} — it followed all ${toggles} toggles, stepping ${watts(found[0].step)}.`;
  if (!found.length) {
    const lead = candidates[0] ? `Closest: ${candidates[0].label}, ${candidates[0].matched} of ${toggles}. ` : '';
    return `Nothing has followed every toggle. ${lead}${why || ''}`.trim();
  }
  const more = toggles < 2 ? 1 : found.length > 2 ? 2 : 1;
  return `${found.length} channels match all ${toggles} toggles: ${found.slice(0, 3).map(c => c.label).join(', ')}. `
    + `${more} more toggle${more > 1 ? 's' : ''} should separate them.`;
}
