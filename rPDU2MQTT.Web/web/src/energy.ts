export type EnergyParts = {
  solar?: number | null;
  battery?: number | null;
  grid?: number | null;
  gridImport?: number | null;
  load?: number | null;
};

export function homeEnergy(parts: EnergyParts): number | null {
  if (parts.load !== undefined) return parts.load;

  const present = ([parts.solar, parts.battery, parts.grid] as (number | null | undefined)[])
    .filter(v => v !== undefined) as (number | null)[];
  if (!present.length) return null;
  if (present.some(v => v == null)) return null;
  return present.reduce((a, b) => a! + b!, 0);
}

export function selfSufficiencyPct(home: number | null, gridImport: number | null): number | null {
  if (home == null || gridImport == null || home <= 0) return null;
  const covered = home - Math.max(0, gridImport);
  return Math.max(0, Math.min(100, (covered / home) * 100));
}

export function coveredEnergy(home: number | null, gridImport: number | null): number | null {
  if (home == null || gridImport == null) return null;
  return Math.max(0, home - Math.max(0, gridImport));
}

export function netSelfProducedPct(home: number | null, gridNet: number | null): number | null {
  if (home == null || gridNet == null || home <= 0) return null;
  return Math.max(0, ((home - gridNet) / home) * 100);
}

export function netSolarPct(home: number | null, solar: number | null): number | null {
  if (home == null || solar == null || home <= 0) return null;
  return Math.max(0, (solar / home) * 100);
}

export function shareBand(pct: number): number {
  return pct > 90 ? 1 : pct > 75 ? 2 : pct > 50 ? 3 : pct > 25 ? 4 : 5;
}

export function sumKnown(values: (number | null | undefined)[]): number | null {
  const known = values.filter(v => v != null) as number[];
  return known.length ? known.reduce((a, b) => a + b, 0) : null;
}
