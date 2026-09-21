// Where a breaker sits in the panel as it is drawn (#453): odd slots down the left column, even down the
// right, a double-pole spanning the next slot in its own column, and a tandem sharing one slot.

export type Slotted = { slot: number; poles?: number; half?: number | null };

/// One drawn position: the slot, how many rows it covers, and the breaker (or two tandem halves) in it.
export type SlotCell<T extends Slotted> = { slot: number; span: number; halves: T[] };

export const isLeft = (slot: number) => slot % 2 === 1;
export const rowOf = (slot: number) => Math.floor((slot + 1) / 2);

/// The cells of one column, top to bottom. A slot a double-pole reaches into is not drawn again.
export function column<T extends Slotted>(slots: number, breakers: T[], left: boolean): SlotCell<T>[] {
  const cells: SlotCell<T>[] = [];
  const covered = new Set<number>();
  for (let slot = left ? 1 : 2; slot <= slots; slot += 2) {
    if (covered.has(slot)) continue;
    const halves = breakers.filter(b => b.slot === slot).sort((a, b) => (a.half || 1) - (b.half || 1));
    // A double-pole in the last slot of a column has nothing to reach into, so it is drawn as one.
    const spans = halves.some(b => (b.poles || 1) === 2) && slot + 2 <= slots;
    if (spans) covered.add(slot + 2);
    cells.push({ slot, span: spans ? 2 : 1, halves });
  }
  return cells;
}
