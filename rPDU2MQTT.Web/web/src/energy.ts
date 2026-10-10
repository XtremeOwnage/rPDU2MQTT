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

/// Per step: solar + (battery out − in) + (grid out − in). A missing reading is a gap; an absent `#in` lane is 0.
export function homeBalanceTrend(rows: Map<string, (number | null)[]>,
                                 roles: { solar: string[], battery: string[], grid: string[] }): (number | null)[] | null {
  const outs = [...roles.solar, ...roles.battery, ...roles.grid];
  if (!outs.length || outs.some(id => !rows.has(id))) return null;
  const ins = [...roles.battery, ...roles.grid].map(id => rows.get(id + '#in')).filter(Boolean) as (number | null)[][];
  const ok = (v: number | null | undefined): v is number => v != null && Number.isFinite(v);
  const points = Math.max(...outs.map(id => rows.get(id)!.length));
  const values: (number | null)[] = [];
  for (let i = 0; i < points; i++) {
    const out = outs.map(id => rows.get(id)![i]), back = ins.map(r => r[i]);
    values.push(out.every(ok) && back.every(ok)
      ? out.reduce((a, b) => a + b, 0) - back.reduce((a, b) => a + b, 0)
      : null);
  }
  return values.some(v => v != null) ? values : null;
}
