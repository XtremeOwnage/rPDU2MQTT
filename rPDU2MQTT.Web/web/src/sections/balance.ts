// The Balance: which nodes are the site's solar, grid, battery and home totals. Separate from a node's Kind,
// because what a node is and what it counts toward are different questions — an inverter's reading is the
// house load, and the MPPT strings a PV total is made of are solar without being added to it.
import { activate, api, btn, el, ensure, formatNum, navLink, withInstance, instanceSelector } from '../helpers.js';
import { state } from '../state.js';
import { refreshDirty } from '../dirty.js';
import { saveConfig } from '../config-form.js';
import { flowCandidates } from './nodes.js';

/// The four totals, in the order the energy pages show them. Keys match EnergyFlow.Balance and the
/// `balance` the server puts on every node.
export const BALANCE_ROLES: [string, string, string, string][] = [
  ['solar', 'Solar', 'Solar', 'Production — a PV total, never the strings it is made of as well.'],
  ['grid', 'Grid', 'Grid', 'The grid connection: import out, export in. One meter, not the inverter’s reading of it as well.'],
  ['battery', 'Battery', 'Battery', 'Battery banks: discharge out, charge in.'],
  ['home', 'Home', 'Home', 'What the home used — an inverter’s load output, a whole-house meter. Leave empty to work it out from the other three.'],
];

const balanceOf = (flow: any) => ensure(flow, 'Balance', {});
const listOf = (flow: any, key: string): string[] => ensure(balanceOf(flow), key, []);

/// Has the configuration named any node? Without it the server totals nodes by kind.
export function balanceConfigured(flow: any) {
  const b = flow?.Balance || {};
  return BALANCE_ROLES.some(([, key]) => (b[key] || []).length > 0);
}

/// The total a node is listed under, or '' when none.
export function balanceRoleOf(flow: any, id: string) {
  const b = flow?.Balance || {};
  const hit = BALANCE_ROLES.find(([, key]) => (b[key] || []).some((x: string) => x.toLowerCase() === id.toLowerCase()));
  return hit ? hit[0] : '';
}

/// Put a node under one total (or none). A node in two totals would be counted in both, so it moves.
export function setBalanceRole(flow: any, id: string, role: string) {
  BALANCE_ROLES.forEach(([r, key]) => {
    const list = listOf(flow, key);
    for (let i = list.length - 1; i >= 0; i--) if (list[i].toLowerCase() === id.toLowerCase()) list.splice(i, 1);
    if (r === role) list.push(id);
  });
  refreshDirty();
}

/// A renamed node keeps its place in the balance; a deleted one leaves it.
export function renameInBalance(flow: any, from: string, to: string | null) {
  const b = flow?.Balance;
  if (!b) return;
  BALANCE_ROLES.forEach(([, key]) => {
    const list: string[] = b[key] || [];
    for (let i = list.length - 1; i >= 0; i--)
      if (list[i] === from) { if (to) list[i] = to; else list.splice(i, 1); }
  });
}

export function addBalanceSection(nav: any, sections: any) {
  const link = navLink(nav, 'Balance', '⚖');
  link.dataset.section = 'EnergyFlow';
  const sec = el('div', { class: 'section' });
  sections.appendChild(sec);
  sec.appendChild(el('h2', { text: 'Energy balance' }));
  sec.appendChild(el('div', { class: 'desc' },
    'Which nodes are the site’s Solar, Grid, Battery and Home figures — on the Energy and Overview pages, '
    + 'Trends, self-sufficiency and the Home Assistant Energy Dashboard. Each total is the sum of the nodes '
    + 'listed under it, and nothing else counts: an MPPT string beneath its PV total, or a second reading of '
    + 'the grid, stays out unless you add it. A node’s Kind only decides how it is drawn.'));

  const instSel = instanceSelector(() => load());
  const save = btn('Save', 'primary');
  const status = el('span', { class: 'ld-count' });
  const toolbar = el('div', { class: 'ld-toolbar' }, instSel.wrap, save, status);
  sec.appendChild(toolbar);
  const body = el('div');
  sec.appendChild(body);

  let lastGraph: any = null;
  // What gets used, not what supplies or meters a total: an appliance, a PDU or one of its outlets is
  // never the site's solar, grid, battery or home figure, and there are dozens of them. Offered only when
  // asked for, for the setup where one is.
  const END_LOADS = ['load', 'outlet', 'pdu'];
  let everyNode = false;

  const render = () => {
    const flow = ensure(state.data, 'EnergyFlow', {});
    const cand = flowCandidates(lastGraph, ensure(flow, 'Nodes', []));
    const graphNodes: any[] = (lastGraph?.nodes || []).filter((n: any) => !String(n.id || '').includes('#'));
    const valueOf = (id: string) => graphNodes.find(n => n.id.toLowerCase() === id.toLowerCase())?.value;
    const units = lastGraph?.units || 'W';
    const nm = (id: string) => cand.get(id)?.label || id;
    const fmt = (v: any) => typeof v === 'number' ? `${formatNum(Math.round(v))} ${units}` : '—';
    body.innerHTML = '';

    const configured = balanceConfigured(flow);
    status.textContent = configured ? '' : 'not set — totals follow each node’s kind';

    // Until something is named, the pages total by kind. Say what that comes to, and offer it as the start.
    if (!configured) {
      const note = el('div', { class: 'balance-note' });
      note.appendChild(el('div', { text: 'Nothing is listed yet, so each total is every node of that kind that no other node already holds (a Load node counts as Home). That comes to:' }));
      const ul = el('ul');
      BALANCE_ROLES.forEach(([role, , label]) => {
        const ids = graphNodes.filter(n => n.balance === role).map(n => n.id);
        ul.appendChild(el('li', { text: `${label}: ${ids.length ? ids.map(nm).join(', ') : 'nothing'}` }));
      });
      note.appendChild(ul);
      const adopt = btn('Start from these', 'small');
      adopt.title = 'List those nodes below, so you can change them. Nothing changes until you save.';
      adopt.onclick = () => {
        BALANCE_ROLES.forEach(([role]) => graphNodes.filter(n => n.balance === role).forEach(n => setBalanceRole(flow, n.id, role)));
        render();
      };
      note.appendChild(adopt);
      body.appendChild(note);
    }

    const listed = new Map<string, string>();
    BALANCE_ROLES.forEach(([role, key]) => listOf(flow, key).forEach(id => listed.set(id.toLowerCase(), role)));

    BALANCE_ROLES.forEach(([role, key, label, hint]) => {
      const list = listOf(flow, key);
      const card = el('div', { class: 'balance-role' });
      card.dataset.role = role;
      const total = list.reduce((sum: number | null, id) => {
        const v = valueOf(id);
        return typeof v === 'number' ? (sum ?? 0) + v : sum;
      }, null);
      card.appendChild(el('div', { class: 'balance-head' },
        el('h3', { text: label }),
        el('span', { class: 'balance-total', text: list.length ? `${fmt(total)} now` : '' })));
      card.appendChild(el('div', { class: 'desc', text: hint }));

      const chips = el('div', { class: 'balance-chips' });
      list.forEach(id => {
        const missing = !cand.has(id);
        const chip = el('span', { class: 'balance-chip' + (missing ? ' is-missing' : '') });
        chip.dataset.node = id;
        chip.appendChild(el('span', { text: nm(id) }));
        chip.appendChild(el('span', { class: 'balance-val', text: missing ? 'no such node' : fmt(valueOf(id)) }));
        if (missing) chip.title = `No node “${id}” is on the flow graph: it was renamed or removed, and this total is short by whatever it read.`;
        const x = el('button', { class: 'balance-x', text: '×', title: `Stop counting ${nm(id)} toward ${label}` });
        x.onclick = () => { setBalanceRole(flow, id, ''); render(); };
        chip.appendChild(x);
        chips.appendChild(chip);
      });
      if (!list.length) chips.appendChild(el('span', { class: 'desc', style: { margin: '0' }, text: role === 'home' ? 'Nothing listed — worked out from the other three.' : 'Nothing listed.' }));
      card.appendChild(chips);

      // Add a node. One listed under another total moves here, since it cannot count toward both.
      const pick = el('select', { style: { width: 'auto' } }) as HTMLSelectElement;
      pick.appendChild(el('option', { value: '', text: `+ add a node to ${label}` }));
      [...cand.keys()]
        .filter(id => listed.get(id.toLowerCase()) !== role)
        .filter(id => everyNode || !END_LOADS.includes(cand.get(id)?.kind || 'node'))
        .sort((a, b) => nm(a).localeCompare(nm(b)))
        .forEach(id => {
          const elsewhere = listed.get(id.toLowerCase());
          pick.appendChild(el('option', { value: id, text: nm(id) + (elsewhere ? ` (moves from ${elsewhere})` : '') }));
        });
      pick.onchange = () => { if (pick.value) { setBalanceRole(flow, pick.value, role); render(); } };
      card.appendChild(pick);
      body.appendChild(card);
    });
  };

  // Beside the lists, not inside each: one switch for every picker on the page.
  const everyToggle = el('label', { class: 'ld-inst', title: 'Loads, PDUs and outlets are left out of the pickers: they use energy rather than being a site total.' });
  const everyBox = el('input', { type: 'checkbox' }) as HTMLInputElement;
  everyBox.onchange = () => { everyNode = everyBox.checked; render(); };
  everyToggle.append(everyBox, ' Offer loads, PDUs and outlets too');
  toolbar.appendChild(everyToggle);

  const load = async () => {
    // The graph names every node that can be listed, the derived ones included, with what each reads now.
    let r: any;
    try { r = await api(withInstance('/api/flow', instSel)); } catch { r = null; }
    lastGraph = r?.body?.ok ? r.body : null;
    render();
  };
  save.onclick = () => saveConfig(load);
  link.onclick = () => { activate(link, sec); load(); };
  return { link, sec };
}
