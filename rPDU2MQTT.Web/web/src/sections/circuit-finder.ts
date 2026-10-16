// Circuit Finder (#471, #494): find a load's circuit by switching the load, not the breaker. Switch it, tap;
// switch it back, tap. The server records every channel the whole time, so a tap is only a timestamp — there
// is nothing to wait for — and each state is every reading taken while it was held.
// Built for a phone held in one hand at the panel: one big button, one list, no tables.
import { activate, btn, el, instanceSelector, navLink, svgEl, withInstance } from '../helpers.js';
import { analyse } from '../circuit-finder.js';
import { circuitSession } from '../circuit-session.js';
import { editNodeOnNextOpen } from './nodes.js';

/// Circuits: the breakers. A panel, the grid and an inverter step with the load as well, being upstream of
/// it; a PDU outlet or a metered appliance is what is plugged in, not the circuit it is on. All of them are
/// one tick away under "Show every channel".
const CIRCUIT_KINDS = ['breaker'];

const clock = (ms: number) => {
  const s = Math.floor(ms / 1000);
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

export function addCircuitFinderSection(nav: any, sections: any) {
  const link = navLink(nav, 'Circuit Finder', '🔌');
  const sec = el('div', { class: 'section' });
  sections.appendChild(sec);
  sec.appendChild(el('h2', { text: 'Circuit Finder' }));
  sec.appendChild(el('div', { class: 'desc' },
    'Switch the load, tap. Switch it back, tap. Every channel is recorded the whole time; the one that rises '
    + 'and falls with the load is its circuit. Hold each state for a couple of readings.'));

  const instSel = instanceSelector(() => { session.reset(); });
  const session = circuitSession({
    url: () => withInstance('/api/circuit-finder/samples', instSel),
    alive: () => sec.classList.contains('active'),
    onChange: () => render(),
  });

  // The main control, and under it what the state now open has collected.
  const tap = el('button', { class: 'cf-tap', type: 'button' }) as HTMLButtonElement;
  const held = el('div', { class: 'cf-held' });
  const strip = el('div', { class: 'cf-strip' });
  const undo = btn('Undo tap');
  const startOver = btn('Start over');
  sec.appendChild(el('div', { class: 'cf-actions' }, tap, held, strip, el('div', { class: 'cf-minor' }, undo, startOver)));
  const verdict = el('div', { class: 'cf-verdict' });
  sec.appendChild(verdict);
  const list = el('div', { class: 'cf-list' });
  sec.appendChild(list);

  // Settings nobody needs to reach mid-session, below the results.
  const draw = el('input', { type: 'number', min: '0', step: '10', placeholder: 'e.g. 1500' }) as HTMLInputElement;
  draw.style.maxWidth = '9em';
  draw.title = 'Roughly what the load draws, if you know it. Leave blank for an unknown load.';
  draw.onchange = () => render();
  const everything = el('input', { type: 'checkbox' }) as HTMLInputElement;
  everything.title = 'Also offer PDU outlets, loads, panels, the grid and other nodes — not only breakers.';
  everything.onchange = () => render();
  const rate = el('div', { class: 'desc cf-rate' });
  sec.appendChild(el('div', { class: 'cf-settings' },
    el('label', { class: 'ld-inst' }, 'Load draws about ', draw, ' W'),
    el('label', { class: 'ld-inst' }, everything, ' Show every channel, not just breakers'),
    instSel.wrap, rate));

  tap.onclick = () => { session.tap(); render(); };
  undo.onclick = () => session.undo();
  startOver.onclick = () => session.reset();

  const offered = (id: string) => everything.checked || CIRCUIT_KINDS.includes(session.kinds[id] || 'node');
  const wattsWanted = () => { const v = Number(draw.value); return Number.isFinite(v) && v > 0 ? v : null; };

  const render = () => {
    const poll = session.pollSeconds;
    const now = session.current();
    // Each tap names the state the load is already in, so the button asks for the next one.
    const next = now?.on ? 'OFF' : 'ON';
    tap.textContent = now ? `Switched it ${next}? Tap` : 'Switch the load OFF, then tap';
    tap.title = 'Switch the load first, then tap. Nothing to wait for: the channels are recorded the whole time.';
    undo.hidden = !session.taps;
    startOver.hidden = !session.taps;
    rate.textContent = `The PDU reports every ${poll} s, so a state needs about ${poll * 2} s for two readings.`;

    // What the open state has so far, in place of a countdown.
    if (now) {
      const enough = now.readings >= 2;
      held.className = 'cf-held' + (enough ? ' is-ready' : '');
      held.textContent = `Load ${now.on ? 'ON' : 'OFF'} · held ${clock(now.heldMs)} · ${now.readings} reading${now.readings === 1 ? '' : 's'}`
        + (enough ? '' : ' — hold a little longer');
    } else { held.className = 'cf-held'; held.textContent = ''; }
    strip.innerHTML = '';
    session.perState().forEach((s, i) => {
      const chip = el('span', { class: 'cf-state' + (s.on ? ' is-on' : '') + (s.readings < 2 ? ' is-thin' : '') + (i === session.taps - 1 ? ' is-open' : ''),
        text: `${s.on ? 'ON' : 'OFF'} ${s.readings}` });
      chip.title = `${s.on ? 'On' : 'Off'}: ${s.readings} reading${s.readings === 1 ? '' : 's'}${s.readings < 2 ? ' — too few to judge' : ''}`;
      strip.appendChild(chip);
    });

    const found = analyse(session.levels(), { watts: wattsWanted(), labels: session.labels, offered });
    verdict.className = 'cf-verdict' + (found.done ? ' is-found' : '');
    verdict.textContent = session.failed ? `Readings unavailable: ${session.failed}`
      : session.taps ? found.verdict : 'Switch the load OFF, then tap to start.';

    list.innerHTML = '';
    const lv = session.levels();
    const open = lv.length >= 2 ? lv[lv.length - 1] : null, prev = lv.length >= 2 ? lv[lv.length - 2] : null;
    const w = (x: number) => `${x >= 0 ? '+' : '−'}${Math.abs(Math.round(x)).toLocaleString('en-US')} W`;
    found.candidates.slice(0, 8).forEach(c => {
      const hit = found.found.some(f => f.node === c.node);
      // Since the last tap, as it comes in: this is where a channel that is moving shows first.
      const now = open && prev && open.mean[c.node] != null && prev.mean[c.node] != null ? open.mean[c.node] - prev.mean[c.node] : null;
      const meta = [w(c.step), c.noise != null ? `${Math.round(c.clarity)}× noise` : null, `followed ${c.matched} of ${found.toggles}`]
        .filter(Boolean).join(' · ');
      // The point of finding a circuit is usually to name it, so each row opens that node's editor.
      const row = el('button', { class: 'cf-row' + (hit ? (found.done ? ' is-found' : ' is-lead') : ''), type: 'button' },
        el('span', { class: 'cf-name', text: c.label }),
        el('span', { class: 'cf-meta', text: meta }),
        now != null ? el('span', { class: 'cf-now', text: `now ${w(now)}`, title: 'Change since the last tap, so far' }) : '',
        spark(c.node),
        el('span', { class: 'cf-edit', text: 'Edit ›' }));
      row.dataset.node = c.node;
      row.title = `Open ${c.label} in the node editor, to name it or set what feeds it.`;
      row.onclick = () => {
        editNodeOnNextOpen(c.node);
        (Array.from(document.querySelectorAll('nav a')) as any[]).find(a => a.dataset.label === 'Nodes')?.click();
      };
      list.appendChild(row);
    });
  };

  /// One channel over the session: its readings as a line, the ON states shaded, a tick at every tap. A
  /// channel that moves with the load reads as steps lined up with the shading, whatever the numbers say.
  const spark = (node: string) => {
    const s = session.series(node);
    const W = 300, H = 34, span = Math.max(1, s.to - s.from);
    const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none', class: 'cf-spark' }) as any;
    const x = (t: number) => Math.round(((t - s.from) / span) * W * 10) / 10;
    s.taps.forEach((t, i) => {
      const end = i + 1 < s.taps.length ? s.taps[i + 1].t : s.to;
      if (t.on) svg.appendChild(svgEl('rect', { x: x(t.t), y: 0, width: Math.max(0, x(end) - x(t.t)), height: H, class: 'cf-spark-on' }));
      svg.appendChild(svgEl('line', { x1: x(t.t), x2: x(t.t), y1: 0, y2: H, class: 'cf-spark-tap' }));
    });
    if (s.points.length > 1) {
      const vs = s.points.map(p => p.v);
      const lo = Math.min(...vs), hi = Math.max(...vs), pad = Math.max(1, (hi - lo) * 0.12);
      const y = (v: number) => Math.round((H - 2 - ((v - lo + pad) / (hi - lo + 2 * pad)) * (H - 4)) * 10) / 10;
      // Held level between readings: a reading stands until the next one.
      let d = `M${x(s.points[0].t)},${y(s.points[0].v)}`;
      for (let i = 1; i < s.points.length; i++) d += ` H${x(s.points[i].t)} V${y(s.points[i].v)}`;
      d += ` H${W}`;
      svg.appendChild(svgEl('path', { d, class: 'cf-spark-line' }));
    }
    return svg;
  };

  // The readings run from the moment the page is open, so the first state already has some.
  link.onclick = () => { activate(link, sec); session.start(); render(); };
  // The held time ticks between fetches.
  setInterval(() => { if (sec.classList.contains('active') && session.taps) render(); }, 1000);
  render();
  return { link, sec };
}
