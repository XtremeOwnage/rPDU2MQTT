// Circuit Finder (#471, #494): find a load's circuit by switching the load, not the breaker. Switch it, tap;
// switch it back, tap. The server records every channel the whole time, so a tap is only a timestamp — there
// is nothing to wait for — and each state is every reading taken while it was held.
// Built for a phone held in one hand at the panel: one big button, one list, no tables.
import { activate, btn, el, instanceSelector, navLink, withInstance } from '../helpers.js';
import { analyse } from '../circuit-finder.js';
import { circuitSession } from '../circuit-session.js';
import { editNodeOnNextOpen } from './nodes.js';

/// What a load can actually sit on. A panel, the grid and an inverter all step with the load as well, being
/// upstream of it, so offering them as answers only buries the circuit.
const CIRCUIT_KINDS = ['breaker', 'outlet', 'load'];

const clock = (ms: number) => {
  const s = Math.floor(ms / 1000);
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

export function addCircuitFinderSection(nav: any, sections: any) {
  const link = navLink(nav, 'Circuit Finder', '🔌');
  link.dataset.section = 'EnergyFlow';
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
  everything.title = 'Also offer panels, the grid and other upstream nodes, which step with the load because they carry it.';
  everything.onchange = () => render();
  const rate = el('div', { class: 'desc cf-rate' });
  sec.appendChild(el('div', { class: 'cf-settings' },
    el('label', { class: 'ld-inst' }, 'Load draws about ', draw, ' W'),
    el('label', { class: 'ld-inst' }, everything, ' Show every channel, not just circuits'),
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
    found.candidates.slice(0, 8).forEach(c => {
      const hit = found.done && found.found.some(f => f.node === c.node);
      const near = c.matched < found.toggles;
      // The point of finding a circuit is usually to name it, so each row opens that node's editor.
      const row = el('button', { class: 'cf-row' + (hit ? ' is-found' : near ? ' is-near' : ''), type: 'button' },
        el('span', { class: 'cf-name', text: c.label }),
        el('span', { class: 'cf-meta', text: `${c.matched} of ${found.toggles} toggles · ${c.step >= 0 ? '+' : ''}${Math.round(c.step).toLocaleString('en-US')} W`
          + (c.noise != null ? ` · ±${Math.round(c.noise).toLocaleString('en-US')} W noise` : '') }),
        el('span', { class: 'cf-edit', text: 'Edit ›' }));
      row.title = `Open ${c.label} in the node editor, to name it or set what feeds it.`;
      row.onclick = () => {
        editNodeOnNextOpen(c.node);
        (Array.from(document.querySelectorAll('nav a')) as any[]).find(a => a.dataset.label === 'Nodes')?.click();
      };
      list.appendChild(row);
    });
  };

  // The readings run from the moment the page is open, so the first state already has some.
  link.onclick = () => { activate(link, sec); session.start(); render(); };
  // The held time ticks between fetches.
  setInterval(() => { if (sec.classList.contains('active') && session.taps) render(); }, 1000);
  render();
  return { link, sec };
}
