// Which circuit is this load on? Switch the load itself on and off, and watch which channel steps with it.
// The maths only: what each toggle did to every channel, and which of them is still in the running (#471).

/// One settled state of the load, and what each channel read on average while it lasted.
export type Level = { on: boolean; mean: Record<string, number> };

/// A channel still in the running: how many toggles it followed, and by how much.
export type Candidate = { node: string; label: string; matched: number; step: number; missed: number };

export type Finding = {
  toggles: number;
  candidates: Candidate[];
  /// The channels that followed every toggle — two of them when a 240 V load steps both legs.
  found: Candidate[];
  done: boolean;
  verdict: string;
};

/// The smallest step worth calling a change, in watts. Below this a channel's own noise answers for it.
export const NOISE_FLOOR = 5;

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

/// A load's own draw is the step to expect; without it, anything above the noise floor counts.
const bounds = (watts?: number | null) => watts && watts > 0
  ? { least: Math.max(NOISE_FLOOR, 0.4 * watts), most: 2.5 * watts }
  : { least: NOISE_FLOOR, most: Infinity };

/// Two channels stepping by roughly the same amount are the two legs of one 240 V breaker.
const paired = (a: Candidate, b: Candidate) => Math.abs(a.step - b.step) <= 0.3 * Math.max(a.step, b.step);

export function analyse(levels: Level[], opts: { watts?: number | null; labels?: Record<string, string> } = {}): Finding {
  const labels = opts.labels || {};
  const { least, most } = bounds(opts.watts);
  const toggles = Math.max(0, levels.length - 1);
  const steps: Record<string, number[]> = {};
  const misses: Record<string, number> = {};

  for (let i = 1; i < levels.length; i++) {
    // On should raise a channel and off should lower it; a change the other way is not this load.
    const want = levels[i].on ? 1 : -1;
    const nodes = new Set([...Object.keys(levels[i - 1].mean), ...Object.keys(levels[i].mean)]);
    nodes.forEach(node => {
      const before = levels[i - 1].mean[node], after = levels[i].mean[node];
      if (before == null || after == null) return;
      const step = want * (after - before);
      if (step >= least && step <= most) (steps[node] ||= []).push(step);
      else misses[node] = (misses[node] || 0) + 1;
    });
  }

  const candidates: Candidate[] = Object.entries(steps)
    .map(([node, seen]) => ({ node, label: labels[node] || node, matched: seen.length, step: median(seen), missed: misses[node] || 0 }))
    .sort((a, b) => b.matched - a.matched || b.step - a.step);

  const found = candidates.filter(c => c.matched === toggles && toggles > 0);
  // One channel that followed every toggle is the answer; two that also step together are one 240 V breaker.
  const legs = found.length === 2 && paired(found[0], found[1]);
  const done = toggles >= 2 && (found.length === 1 || legs);

  return { toggles, candidates, found, done, verdict: verdictOf(toggles, candidates, found, done, legs, opts.watts) };
}

const watts = (w: number) => `${Math.round(w).toLocaleString('en-US')} W`;

function verdictOf(toggles: number, candidates: Candidate[], found: Candidate[], done: boolean, legs: boolean, load?: number | null): string {
  if (!toggles) return 'Switch the load, then tap again — the first toggle has nothing to compare against yet.';
  if (done && legs) return `Both legs of a 240 V breaker: ${found[0].label} and ${found[1].label}, stepping ${watts(found[0].step)} each.`;
  if (done) return `${found[0].label} — it followed all ${toggles} toggles, stepping ${watts(found[0].step)}.`;
  if (!candidates.length) {
    return load
      ? `Nothing stepped by about ${watts(load)}. Check the load really switched, or clear the expected draw and keep toggling.`
      : 'No channel stepped with that toggle. A small load can hide in one toggle\'s noise — keep toggling.';
  }
  if (!found.length) return `Nothing has followed every toggle yet. ${candidates[0].label} is closest, at ${candidates[0].matched} of ${toggles}. Keep toggling.`;
  const more = toggles < 2 ? 1 : found.length > 2 ? 2 : 1;
  return `${found.length} channels still match all ${toggles} toggles: ${found.slice(0, 3).map(c => c.label).join(', ')}. `
    + `${more} more toggle${more > 1 ? 's' : ''} should separate them.`;
}
