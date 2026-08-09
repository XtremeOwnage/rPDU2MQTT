// The arithmetic every energy view shares: what the home took, what came from the grid, and the share that
// did not.
//
// These rules were written twice — once on the Energy Overview and once on Trends — and the two disagreed.
// Both had to be corrected separately when netting export against import turned out to flatter the figure,
// and the second correction was only made because the first had been. A rule with two implementations has
// two behaviours; this is the one.
//
// Everything here is scalar and null-aware, so a page with one window calls it once and a page with a bar
// per day calls it per day. Null means unknown and never zero: a percentage computed from a figure nobody
// measured is not a measurement, and every function here returns null rather than inventing the input.

/// The direction-resolved figures a window is described by. Each is null when nothing determined it, and
/// absent (undefined) when the system has no such kind at all — a house with no battery is not a house
/// whose battery failed to report, and only the second one should stop the arithmetic.
export type EnergyParts = {
  solar?: number | null;
  /// Battery net: discharge minus charge. Negative on a day that stored more than it gave back.
  battery?: number | null;
  /// Grid net: import minus export.
  grid?: number | null;
  /// What the grid actually supplied. Not the net — see selfSufficiencyPct.
  gridImport?: number | null;
  /// Metered load, when the hierarchy has nodes tagged as such. Wins over the balance when present.
  load?: number | null;
};

/// What the home actually took over the window.
///
/// Tagged load nodes if the hierarchy has them; otherwise the balance of the measured sources, which is
/// only a balance if every source present is known — one unknown feeder makes the total a guess, so it is
/// null instead. Charge and export are already negative in `battery` and `grid`, so they subtract: energy
/// stored or sent back was not consumed here.
export function homeEnergy(parts: EnergyParts): number | null {
  if (parts.load !== undefined) return parts.load;

  const present = ([parts.solar, parts.battery, parts.grid] as (number | null | undefined)[])
    .filter(v => v !== undefined) as (number | null)[];
  if (!present.length) return null;
  if (present.some(v => v == null)) return null;
  return present.reduce((a, b) => a! + b!, 0);
}

/// The share of the home's energy that did not come from the grid, 0–100, or null when it cannot be said.
///
/// The denominator is what the home took; the numerator is that less what the grid supplied. `gridImport`
/// is the supply direction alone, never the net: a day that imported 10 kWh and exported 10 did not avoid
/// drawing anything, and netting first would report it as fully self-sufficient.
export function selfSufficiencyPct(home: number | null, gridImport: number | null): number | null {
  if (home == null || gridImport == null || home <= 0) return null;
  const covered = home - Math.max(0, gridImport);
  return Math.max(0, Math.min(100, (covered / home) * 100));
}

/// How much of the home's energy solar and battery covered, in the same units — the figure the bar shows
/// beside the percentage. Null on the same terms.
export function coveredEnergy(home: number | null, gridImport: number | null): number | null {
  if (home == null || gridImport == null) return null;
  return Math.max(0, home - Math.max(0, gridImport));
}

/// Add up a set of readings, treating "no reading" as absent rather than zero.
///
/// Returns null when nothing in the set reported, so a sum is never a partial one wearing a total's name.
export function sumKnown(values: (number | null | undefined)[]): number | null {
  const known = values.filter(v => v != null) as number[];
  return known.length ? known.reduce((a, b) => a + b, 0) : null;
}
