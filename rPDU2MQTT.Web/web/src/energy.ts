// The energy arithmetic shared by the Energy Overview and Trends: what the home took.
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
export function homeEnergy(parts: EnergyParts): number | null {
  if (parts.load !== undefined) return parts.load;

  const present = ([parts.solar, parts.battery, parts.grid] as (number | null | undefined)[])
    .filter(v => v !== undefined) as (number | null)[];
  if (!present.length) return null;
  if (present.some(v => v == null)) return null;
  return present.reduce((a, b) => a! + b!, 0);
}

/// The share of the home's energy that did not come from the grid, 0–100, or null when it cannot be said.
export function selfSufficiencyPct(home: number | null, gridImport: number | null): number | null {
  if (home == null || gridImport == null || home <= 0) return null;
  const covered = home - Math.max(0, gridImport);
  return Math.max(0, Math.min(100, (covered / home) * 100));
}

/// How much of the home's energy solar and battery covered, in the same units.
export function coveredEnergy(home: number | null, gridImport: number | null): number | null {
  if (home == null || gridImport == null) return null;
  return Math.max(0, home - Math.max(0, gridImport));
}

/// Add up a set of readings, treating "no reading" as absent rather than zero.
export function sumKnown(values: (number | null | undefined)[]): number | null {
  const known = values.filter(v => v != null) as number[];
  return known.length ? known.reduce((a, b) => a + b, 0) : null;
}
