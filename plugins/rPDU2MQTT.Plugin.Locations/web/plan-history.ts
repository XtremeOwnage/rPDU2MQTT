// Undo and redo for the floor plans (#463): whole snapshots of what is being edited, which is small enough to copy.

export type PlanHistory = {
  push(): void;
  undo(): boolean;
  redo(): boolean;
  canUndo(): boolean;
  canRedo(): boolean;
  clear(): void;
};

/// A history over whatever `get` returns, restored through `set`. Push before each change.
export function planHistory(get: () => any, set: (v: any) => void, limit = 200): PlanHistory {
  const back: string[] = [], ahead: string[] = [];
  return {
    push() {
      const now = JSON.stringify(get());
      if (back[back.length - 1] === now) return;
      back.push(now);
      if (back.length > limit) back.shift();
      ahead.length = 0;
    },
    undo() {
      const prev = back.pop();
      if (prev == null) return false;
      ahead.push(JSON.stringify(get()));
      set(JSON.parse(prev));
      return true;
    },
    redo() {
      const next = ahead.pop();
      if (next == null) return false;
      back.push(JSON.stringify(get()));
      set(JSON.parse(next));
      return true;
    },
    canUndo: () => back.length > 0,
    canRedo: () => ahead.length > 0,
    clear() { back.length = 0; ahead.length = 0; },
  };
}
