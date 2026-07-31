// The browser end of the push channel (#281).
//
// One EventSource carries every feed. A caller says which feed it wants and gets a callback whenever
// the server pushes a new value; the connection is (re)opened with exactly the set of feeds currently
// wanted, so nothing is computed for a tab you aren't looking at.
//
// Why SSE rather than SignalR/WebSockets: the bundle is built with the Node binary alone (no npm), so a
// client library can't be pulled in — and EventSource is already in every browser, with reconnection,
// which is most of what a hub would have bought us. See Gui/GuiEventHub.cs for the server half.
//
// Every consumer must still work without this: `realtimeLive()` reports whether the stream is actually
// carrying data, and each section keeps its manual refresh (and its polling fallback) for when it isn't.

const rtHandlers = new Map<string, Set<(data: any) => void>>();
const rtStateWatchers = new Set<(state: string) => void>();
let rtSource: any = null;
let rtOpenKeys = '';
let rtReopen: any = null;
let rtState = 'idle';   // idle | connecting | live | down

// Whether the push stream is currently delivering. Sections use it to decide between "stay live" and
// "poll on a timer" — never assume it's up.
export function realtimeLive() { return rtState === 'live'; }

export function onRealtimeState(fn: (state: string) => void) {
  rtStateWatchers.add(fn);
  fn(rtState);
  return () => rtStateWatchers.delete(fn);
}

function setRtState(s: string) {
  if (s === rtState) return;
  rtState = s;
  rtStateWatchers.forEach(fn => { try { fn(s); } catch { /* a broken watcher must not stop the rest */ } });
}

// A restart we asked for, so the disconnection that follows can be explained instead of alarming.
//
// Switching version, forcing a re-pull or restarting a tier all take the bridge away for a few seconds.
// The stream drops, and the app bar went bright red "Offline — the live update stream dropped", which is
// true and useless: it reads as a fault at the exact moment the thing is working as instructed, and the
// page looks hung rather than busy. Anyone who has just clicked "Switch" knows why it went away; the UI
// should too.
//
// Deliberately time-boxed. If the bridge doesn't come back inside the window, the honest report is that
// it is down — an "Updating…" that never clears would hide a rollout that actually failed.
let restartUntil = 0;
let restartWhy = '';

export function expectRestart(why: string, seconds = 150) {
  restartWhy = why;
  restartUntil = Date.now() + seconds * 1000;
  // Re-render watchers now: the drop usually lands a moment later, but the pill should change the
  // instant the action is taken, not when the socket happens to notice.
  rtStateWatchers.forEach(fn => { try { fn(rtState); } catch { /* as above */ } });
}

/// The reason we're expecting a gap, or null once the window has passed.
export function expectedRestart(): string | null {
  if (Date.now() >= restartUntil) return null;
  return restartWhy;
}

/// Clear the window early — the stream is back, so the restart is over.
export function restartFinished() {
  if (!restartUntil) return;
  restartUntil = 0; restartWhy = '';
}

// Subscribe to a feed key ("status", "board", "livedata:pdu2", "flow:realpower"). Returns an
// unsubscribe function; the connection re-opens with the reduced feed set when the last one goes.
export function subscribeLive(key: string, handler: (data: any) => void) {
  if (typeof EventSource === 'undefined') return () => { };   // no push here; callers fall back to polling
  let set = rtHandlers.get(key);
  if (!set) { set = new Set(); rtHandlers.set(key, set); }
  set.add(handler);
  scheduleReopen();
  return () => {
    const s = rtHandlers.get(key);
    if (!s) return;
    s.delete(handler);
    if (!s.size) rtHandlers.delete(key);
    scheduleReopen();
  };
}

// Subscriptions arrive in bursts (a tab opening wires several at once), so coalesce them into one
// reconnect rather than tearing the stream down per handler.
function scheduleReopen() {
  clearTimeout(rtReopen);
  rtReopen = setTimeout(openStream, 30);
}

function openStream() {
  const keys = [...rtHandlers.keys()].sort();
  const wanted = keys.join(',');
  if (wanted === rtOpenKeys && rtSource) return;

  if (rtSource) { rtSource.close(); rtSource = null; }
  rtOpenKeys = wanted;
  if (!wanted) { setRtState('idle'); return; }

  setRtState('connecting');
  const src = new EventSource('/api/events?topics=' + encodeURIComponent(wanted));
  rtSource = src;

  src.onopen = () => { if (rtSource === src) setRtState('live'); };
  // EventSource retries on its own (the server sends `retry:`), so a drop is "down" until it re-opens.
  src.onerror = () => { if (rtSource === src) setRtState('down'); };

  for (const key of keys) {
    src.addEventListener(key, (ev: any) => {
      if (rtSource !== src) return;
      setRtState('live');
      let data: any;
      try { data = JSON.parse(ev.data); } catch { return; }
      const set = rtHandlers.get(key);
      if (!set) return;
      // Copy first: a handler may unsubscribe itself (a tab closing) while we're iterating.
      [...set].forEach(fn => { try { fn(data); } catch (e) { console.error('live handler failed for ' + key, e); } });
    });
  }
}

// Keep a section live for as long as it is on screen: subscribes on activation, drops on the way out,
// so nothing is computed for a page nobody is looking at. `keyOf()` is re-read on every check, so a
// section can change what it watches (a different PDU instance, a different metric) just by returning a
// different key and calling the returned sync().
export function liveWhileActive(sec: any, keyOf: () => string, handler: (data: any) => void) {
  let off: any = null;
  let key = '';
  const sync = () => {
    const want = sec.classList.contains('active') ? keyOf() : '';
    if (want === key) return;
    key = want;
    if (off) { off(); off = null; }
    if (want) off = subscribeLive(want, handler);
  };
  // activate() announces every tab switch, so this needs no knowledge of the nav.
  window.addEventListener?.('rpdu:activate', sync);
  sync();
  return sync;
}
