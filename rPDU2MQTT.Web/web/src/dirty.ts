// Unsaved-change tracking.
//
// The form binds straight to `state.data`, so editing was invisible: the Save button looked identical
// whether you'd changed nothing or rewritten half the config, there was no way to see what a save would
// write, and no way back short of a reload. This module keeps a baseline of the config as loaded, diffs
// the live document against it, and lets the shell say exactly what is pending — per field, per page,
// and as a reviewable list.
//
// The diff runs over the *pruned* document (the same shape that gets POSTed), so the empty objects the
// renderer creates on the way past — ensure(obj, key, {}) — never register as edits.

import { state } from './state.js';
import { exportData } from './overrides.js';

let dirtyBaseline: any = {};
let dirtyChanges: any[] = [];
const dirtyWatchers = new Set<(changes: any[]) => void>();
// path.join('.') -> the .field element, so an edited setting can be marked where it lives.
const dirtyFields = new Map<string, any>();
// Paths whose values must never be shown in the review list.
const dirtySecrets = new Set<string>();

export function pathKey(path: string[]) { return path.join('.'); }

// Take the current document as "saved" — on load, and again after a successful save.
export function setBaseline(data?: any) {
  dirtyBaseline = JSON.parse(JSON.stringify(data ?? exportData()));
  refreshDirty();
}

// Register a rendered scalar field so it can be marked when its value differs from the baseline.
// Called by the form renderer; the map is cleared on every rebuild.
export function registerField(path: string[], fieldEl: any, secret?: boolean) {
  dirtyFields.set(pathKey(path), fieldEl);
  if (secret) dirtySecrets.add(pathKey(path));
}
export function clearFieldRegistry() { dirtyFields.clear(); dirtySecrets.clear(); }

export function changes() { return dirtyChanges; }
export function isDirty() { return dirtyChanges.length > 0; }

export function onDirty(fn: (changes: any[]) => void) {
  dirtyWatchers.add(fn);
  fn(dirtyChanges);
  return () => dirtyWatchers.delete(fn);
}

// Recompute the diff and tell everyone. Called after any edit, and after load/save/discard.
export function refreshDirty() {
  dirtyChanges = diffConfig(dirtyBaseline, exportData());

  const changed = new Set(dirtyChanges.map(c => pathKey(c.path)));
  dirtyFields.forEach((fieldEl, key) => {
    // A container's field is marked when anything under it changed, so a nested edit isn't invisible.
    const hit = changed.has(key) || [...changed].some(c => c.startsWith(key + '.'));
    if (fieldEl.classList) fieldEl.classList[hit ? 'add' : 'remove']('dirty');
  });

  dirtyWatchers.forEach(fn => { try { fn(dirtyChanges); } catch { /* one bad watcher must not block the rest */ } });
}

// Throw the edits away and go back to the last saved document. The caller rebuilds the form from it.
export function discardChanges() {
  state.data = JSON.parse(JSON.stringify(dirtyBaseline));
  return state.data;
}

// Count of pending edits inside one top-level config section (drives the nav badges).
export function changeCountFor(sectionKey: string) {
  return dirtyChanges.filter(c => c.path[0] === sectionKey).length;
}

// --- Diff ------------------------------------------------------------------------------------------

function isPlainObject(v: any) { return v != null && typeof v === 'object' && !Array.isArray(v); }

// Empty is empty however it's spelled: an absent key, null, '', {} and [] all mean "not set", and the
// renderer produces all of them. Without this, opening a tab would look like an edit.
function prune(v: any): any {
  if (v === null || v === undefined || v === '') return undefined;
  if (Array.isArray(v)) {
    const arr = v.map(prune).filter(x => x !== undefined);
    return arr.length ? arr : undefined;
  }
  if (isPlainObject(v)) {
    const out: any = {};
    for (const k of Object.keys(v)) { const p = prune(v[k]); if (p !== undefined) out[k] = p; }
    return Object.keys(out).length ? out : undefined;
  }
  return v;
}

function same(a: any, b: any) { return JSON.stringify(a ?? null) === JSON.stringify(b ?? null); }

export function diffConfig(before: any, after: any) {
  const out: any[] = [];
  walk(prune(before), prune(after), [], out);
  return out;
}

function walk(a: any, b: any, path: string[], out: any[]) {
  if (same(a, b)) return;

  // Recurse while both sides are object-shaped (or absent), so a whole new section still reports one
  // row per setting rather than a wall of JSON.
  const objectish = (v: any) => v === undefined || isPlainObject(v);
  if ((isPlainObject(a) || isPlainObject(b)) && objectish(a) && objectish(b)) {
    const keys = [...new Set([...Object.keys(a || {}), ...Object.keys(b || {})])];
    for (const k of keys) walk((a || {})[k], (b || {})[k], [...path, k], out);
    return;
  }

  out.push({ path, key: pathKey(path), from: a, to: b, secret: dirtySecrets.has(pathKey(path)) });
}

// --- Display ---------------------------------------------------------------------------------------

// One change's value, as a short readable string. Secrets never show their contents.
export function formatValue(v: any, secret?: boolean) {
  if (v === undefined || v === null) return '(not set)';
  if (secret) return '••••••';
  if (typeof v === 'boolean') return v ? 'on' : 'off';
  if (Array.isArray(v)) return `${v.length} ${v.length === 1 ? 'entry' : 'entries'}`;
  if (isPlainObject(v)) {
    const s = JSON.stringify(v);
    return s.length > 120 ? s.slice(0, 117) + '…' : s;
  }
  return String(v);
}
