// Circuit Finder (#471): find a load's circuit by switching the load, not the breaker. Tap, switch the load,
// tap again — every channel is read between taps, and the one that steps with the load is the circuit.
// Built for a phone held in one hand at the panel: one big button, one list, no tables.
import { activate, api, btn, el, instanceSelector, navLink, withInstance } from '../helpers.js';
import { state } from '../state.js';
import { analyse, type Level } from '../circuit-finder.js';
import { editNodeOnNextOpen } from './nodes.js';
import { busyInSection } from '../realtime.js';

/// What a load can actually sit on. A panel, the grid and an inverter all step with the load as well, being
/// upstream of it, so offering them as answers only buries the circuit.
const CIRCUIT_KINDS = ['breaker', 'outlet', 'load'];

/// A state of the load that has been sampled at least once: the running total per channel.
type Stage = { on: boolean; sum: Record<string, number>; n: Record<string, number> };

export function addCircuitFinderSection(nav: any, sections: any) {
  const link = navLink(nav, 'Circuit Finder', '🔌');
  link.dataset.section = 'EnergyFlow';
  const sec = el('div', { class: 'section' });
  sections.appendChild(sec);
  sec.appendChild(el('h2', { text: 'Circuit Finder' }));
  sec.appendChild(el('div', { class: 'desc' },
    'Find which circuit a load is on by switching the load itself. Tap the button, switch the load, then tap '
    + 'again. Every channel is read between taps, and the channel that rises when the load goes on and falls '
    + 'when it goes off is the one it is on. Each toggle narrows it down.'));

  const instSel = instanceSelector(() => reset());
  const draw = el('input', { type: 'number', min: '0', step: '10', placeholder: 'e.g. 1500' }) as HTMLInputElement;
  draw.style.maxWidth = '9em';
  draw.title = 'Roughly what the load draws, if you know it. Leave blank for an unknown load.';
  draw.onchange = () => render();
  sec.appendChild(el('div', { class: 'ld-toolbar', style: { flexWrap: 'wrap', gap: '8px' } },
    el('label', { class: 'ld-inst' }, 'Load draws about ', draw, ' W'), instSel.wrap));

  const everything = el('input', { type: 'checkbox' }) as HTMLInputElement;
  everything.title = 'Also offer panels, the grid and other upstream nodes, which step with the load because they carry it.';
  everything.onchange = () => render();
  sec.appendChild(el('div', { class: 'ld-toolbar', style: { flexWrap: 'wrap', gap: '8px' } },
    el('label', { class: 'ld-inst' }, everything, ' Show every channel, not just circuits')));

  // The button is its own progress bar: the fill sweeps across it while the channels are read again.
  const coolBar = el('span', { class: 'cf-fill' });
  coolBar.hidden = true;
  const tapLabel = el('span', { class: 'cf-label' });
  const tap = el('button', { class: 'cf-tap' }, coolBar, tapLabel) as HTMLButtonElement;
  const reset_ = btn('Start over');
  sec.appendChild(el('div', { class: 'cf-actions' }, tap, reset_));
  const rate = el('div', { class: 'desc cf-rate' });
  sec.appendChild(rate);
  const verdict = el('div', { class: 'cf-verdict' });
  sec.appendChild(verdict);
  const list = el('div', { class: 'cf-list' });
  sec.appendChild(list);

  // The PDU decides how often a channel can be read at all, so it decides the shortest switch that can be seen.
  const pollSeconds = () => {
    const pdus: any = (state.data || {}).Pdus || {};
    const each = Object.values(pdus).map((p: any) => Number(p?.PollInterval)).filter(n => Number.isFinite(n) && n > 0);
    return each.length ? Math.min(...each) : 5;
  };

  let stages: Stage[] = [];
  let labels: Record<string, string> = {};
  let kinds: Record<string, string> = {};
  let busy = false;

  // A reading has to settle before the next tap means anything: the PDU is only read every few seconds.
  const coolSeconds = () => Math.min(5, Math.max(3, pollSeconds()));

  const reset = () => { stages = []; labels = {}; kinds = {}; render(); };
  reset_.onclick = () => reset();

  /// Every channel's reading now, added to the state the load is in.
  const sample = async () => {
    const stage = stages[stages.length - 1];
    if (!stage) return;
    let r: any;
    try { r = await api(withInstance('/api/flow', instSel)); }
    catch { return; }
    const nodes = r?.body?.ok ? r.body.nodes || [] : [];
    nodes.forEach((n: any) => {
      // A return lane or an unmetered remainder is not a channel anyone can find a load on.
      if (!n.id || String(n.id).includes('#') || typeof n.value !== 'number') return;
      labels[n.id] = n.label || n.id;
      kinds[n.id] = n.kind || 'node';
      stage.sum[n.id] = (stage.sum[n.id] || 0) + n.value;
      stage.n[n.id] = (stage.n[n.id] || 0) + 1;
    });
  };

  // While a session is open the channels are read in the background too, so a state is an average rather than
  // one instant — that is what lets a small load show through the noise.
  setInterval(() => { if (stages.length && sec.classList.contains('active') && !busy && !busyInSection(sec)) sample().then(render); }, Math.max(2, pollSeconds()) * 1000);

  const offered = (id: string) => everything.checked || CIRCUIT_KINDS.includes(kinds[id] || 'node');
  const levels = (): Level[] => stages
    .filter(s => Object.keys(s.n).length)
    .map(s => ({ on: s.on, mean: Object.fromEntries(Object.keys(s.sum).filter(offered).map(k => [k, s.sum[k] / s.n[k]])) }));

  const wattsWanted = () => { const v = Number(draw.value); return Number.isFinite(v) && v > 0 ? v : null; };

  tap.onclick = async () => {
    if (busy) return;
    busy = true;
    // The button stays down while the channels are read again, so a second tap cannot land inside the same
    // reading — the bar says how long that is.
    const cool = coolSeconds();
    tap.disabled = true;
    tap.dataset.cooldown = String(cool);
    tapLabel.textContent = `Reading channels… wait ${cool} s`;
    coolBar.hidden = false;
    coolBar.style.animationDuration = `${cool}s`;
    // The load has already been switched, so the tap opens the state it is now in and reads it.
    stages.push({ on: stages.length ? !stages[stages.length - 1].on : false, sum: {}, n: {} });
    await sample();
    render();
    setTimeout(() => { busy = false; tap.disabled = false; coolBar.hidden = true; render(); }, cool * 1000);
  };

  const render = () => {
    const poll = pollSeconds();
    // Each tap names the state the load is already in, so the button asks for the next one.
    const next = !stages.length || stages[stages.length - 1].on ? 'OFF' : 'ON';
    tapLabel.textContent = busy ? `Reading channels… wait ${coolSeconds()} s` : `Switch the load ${next}, then tap`;
    tap.title = 'Switch the load first, then tap: the tap reads every channel in the state the load is now in.';
    reset_.hidden = !stages.length;
    rate.textContent = `Channels are read every ${poll} s, so a switch shorter than about ${poll * 2} s cannot be seen. `
      + 'Leave the load in each state for a few seconds before tapping.';

    const found = analyse(levels(), { watts: wattsWanted(), labels });
    verdict.className = 'cf-verdict' + (found.done ? ' is-found' : '');
    verdict.textContent = stages.length ? found.verdict : 'Switch the load off, then tap to take the first reading.';

    list.innerHTML = '';
    found.candidates.slice(0, 8).forEach(c => {
      const share = found.toggles ? Math.round((c.matched / found.toggles) * 100) : 0;
      // The point of finding a circuit is usually to name it, so each row opens that node's editor.
      const row = el('button', { class: 'cf-row' + (found.done && found.found.some(f => f.node === c.node) ? ' is-found' : '') },
        el('span', { class: 'cf-name', text: c.label }),
        el('span', { class: 'cf-meta', text: `${c.matched} of ${found.toggles} toggles · ${Math.round(c.step).toLocaleString('en-US')} W · ${share}%` }),
        el('span', { class: 'cf-edit', text: 'Edit ›' }));
      row.title = `Open ${c.label} in the node editor, to name it or set what feeds it.`;
      row.onclick = () => {
        editNodeOnNextOpen(c.node);
        (Array.from(document.querySelectorAll('nav a')) as any[]).find(a => a.dataset.label === 'Nodes')?.click();
      };
      list.appendChild(row);
    });
    if (stages.length && !found.candidates.length && found.toggles)
      list.appendChild(el('div', { class: 'desc', text: 'No channel has stepped with the load yet.' }));
  };

  link.onclick = () => { activate(link, sec); render(); };
  render();
  return { link, sec };
}
