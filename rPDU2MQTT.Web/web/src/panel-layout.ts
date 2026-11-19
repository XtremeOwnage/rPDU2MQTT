
export type Slotted = { slot: number; poles?: number; half?: number | null };

/// One position a breaker holds: a slot, and which half of it (null for the whole slot).
export type Hold = { slot: number; half: number | null };

/// One row of a drawn cell: a breaker, or the free half of a shared slot.
export type CellPart<T extends Slotted> = { slot: number; half: number | null; b?: T };

/// One drawn position: the first slot, how many rows it covers, and its breakers in physical order.
export type SlotCell<T extends Slotted> = { slot: number; span: number; halves: T[]; parts: CellPart<T>[] };

export const isLeft = (slot: number) => slot % 2 === 1;
export const rowOf = (slot: number) => Math.floor((slot + 1) / 2);

/// A 2-pole with a half holds that half of its slot and the opposite half of slot + 2.
export function holds(b: Slotted): Hold[] {
  const half = b.half || null;
  const out: Hold[] = [{ slot: b.slot, half }];
  if ((b.poles || 1) === 2) out.push({ slot: b.slot + 2, half: half ? 3 - half : null });
  return out;
}

export function collides(a: Slotted, b: Slotted): boolean {
  if (a === b) return false;
  return holds(a).some(x => holds(b).some(y => x.slot === y.slot && (x.half == null || y.half == null || x.half === y.half)));
}

const order = (h: Hold) => h.slot * 2 + (h.half === 2 ? 1 : 0);

/// The cells of one column, top to bottom.
export function column<T extends Slotted>(slots: number, breakers: T[], left: boolean): SlotCell<T>[] {
  const cells: SlotCell<T>[] = [];
  const covered = new Set<number>();
  const reaches = (b: T) => (b.poles || 1) === 2 && b.slot + 2 <= slots;
  for (let slot = left ? 1 : 2; slot <= slots; slot += 2) {
    if (covered.has(slot)) continue;
    const own = breakers.filter(b => b.slot === slot);
    const whole = own.some(b => reaches(b) && !b.half);
    let last = whole ? slot + 2 : slot;
    if (!whole) while (breakers.some(b => b.slot === last && reaches(b) && b.half)) last += 2;
    const halves = (whole ? own : breakers.filter(b => b.slot >= slot && b.slot <= last && (b.slot - slot) % 2 === 0))
      .sort((a, b) => order(holds(a)[0]) - order(holds(b)[0]));
    for (let s = slot + 2; s <= last; s += 2) covered.add(s);
    const parts: CellPart<T>[] = halves.map(b => ({ slot: b.slot, half: b.half || null, b }));
    for (let s = slot; s <= last; s += 2) {
      const on = halves.flatMap(holds).filter(h => h.slot === s);
      if (!on.length || on.some(h => h.half == null)) continue;
      [1, 2].filter(h => !on.some(x => x.half === h)).forEach(half => parts.push({ slot: s, half }));
    }
    parts.sort((a, b) => order(a) - order(b));
    cells.push({ slot, span: (last - slot) / 2 + 1, halves, parts });
  }
  return cells;
}
