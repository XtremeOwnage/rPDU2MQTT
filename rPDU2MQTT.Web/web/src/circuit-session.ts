// A Circuit Finder session (#494): the taps someone makes, and the readings the server recorded around them.
//
// The server records every channel while a session is open (/api/circuit-finder/samples), so a tap is only
// a timestamp and there is nothing to wait for between taps. The page fetches what it has not seen every few
// seconds; a phone that locks its screen misses nothing, since the readings were taken on the server.
import { api } from './helpers.js';
import { levelsFrom, type Level, type Sample, type Tap } from './circuit-finder.js';

export type CircuitSession = ReturnType<typeof circuitSession>;

export function circuitSession(opts: { url?: () => string; alive: () => boolean; onChange: () => void }) {
  const url = opts.url || (() => '/api/circuit-finder/samples');
  let samples: Sample[] = [];
  /// Taps on this device's clock; placed on the server's by `offset` when the states are worked out.
  let taps: { at: number; on: boolean }[] = [];
  let offset = 0;
  let pollSeconds = 5;
  let keepMinutes = 30;
  let lastT = 0;
  let timer: any = null;
  let failed: string | null = null;
  const labels: Record<string, string> = {};
  const kinds: Record<string, string> = {};

  const fetchNew = async () => {
    const sent = Date.now();
    let r: any;
    try { r = await api(`${url()}${url().includes('?') ? '&' : '?'}since=${lastT}`); }
    catch (e: any) { failed = String(e?.message || e); opts.onChange(); return; }
    const body = r?.body;
    if (!body?.ok) { failed = body?.message || 'The readings could not be fetched.'; opts.onChange(); return; }
    failed = null;
    // The server's clock against this one, taken at the middle of the round trip.
    offset = Number(body.now) - (sent + Date.now()) / 2;
    pollSeconds = Number(body.pollSeconds) > 0 ? Number(body.pollSeconds) : pollSeconds;
    keepMinutes = Number(body.keepMinutes) > 0 ? Number(body.keepMinutes) : keepMinutes;
    (body.channels || []).forEach((c: any) => { labels[c.id] = c.label || c.id; kinds[c.id] = c.kind || 'node'; });
    (body.samples || []).forEach((s: any) => { if (s.t > lastT) { samples.push({ t: s.t, v: s.v || {} }); lastT = s.t; } });
    // Nothing older than the server keeps is any use.
    const cutoff = Number(body.now) - keepMinutes * 60_000;
    if (samples.length && samples[0].t < cutoff) samples = samples.filter(s => s.t >= cutoff);
    opts.onChange();
  };

  /// Keep the server recording, and keep up with what it records.
  const start = () => {
    if (timer) return;
    fetchNew();
    timer = setInterval(() => { if (!opts.alive()) { stop(); return; } fetchNew(); }, 2000);
  };
  const stop = () => { if (timer) clearInterval(timer); timer = null; };

  const serverNow = () => Date.now() + offset;
  const tapsOnServer = (): Tap[] => taps.map(t => ({ t: t.at + offset, on: t.on }));
  /// A tap names the state the load is now in: off first, then alternating.
  const tap = () => { taps.push({ at: Date.now(), on: taps.length ? !taps[taps.length - 1].on : false }); fetchNew(); };
  const undo = () => { taps.pop(); opts.onChange(); };
  const reset = () => { taps = []; opts.onChange(); };

  const levels = (): Level[] => levelsFrom(samples, tapsOnServer(), {
    now: serverNow(),
    // The first poll after a tap can still be the old state; the last seconds before the next tap can
    // already be the new one (switched, not yet tapped).
    settleMs: pollSeconds * 1000,
    guardMs: 3000,
  });

  /// The state open now: which it is, how long it has been held, and how many readings it has.
  const current = () => {
    if (!taps.length) return null;
    const last = tapsOnServer()[taps.length - 1];
    const readings = samples.filter(s => s.t >= last.t + pollSeconds * 1000).length
      || samples.filter(s => s.t >= last.t).length;
    return { on: last.on, heldMs: Math.max(0, serverNow() - last.t), readings };
  };

  /// Readings per state, for the strip of states under the button.
  const perState = () => levels().map(l => ({ on: l.on, readings: Math.max(0, ...Object.values(l.n)) }));

  return {
    start, stop, tap, undo, reset, levels, current, perState, labels, kinds,
    get taps() { return taps.length; },
    get pollSeconds() { return pollSeconds; },
    get failed() { return failed; },
  };
}
