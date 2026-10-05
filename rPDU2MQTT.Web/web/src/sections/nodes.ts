// Nodes page and the group manager.
import { api, btn, el, ensure, activate, navLink, toast } from '../helpers.js';
import { state } from '../state.js';
import { refreshDirty, onDirty } from '../dirty.js';
import { feedsNothing, kindMeta, NODE_KINDS } from '../flow-vocabulary.js';
import { flowGroups } from '../flow-view.js';
import { renderImportPanel } from '../node-templates.js';
import { renderNodeEditor, overlay, openRenameDialog } from './node-editor.js';
import { migrateEnergyFlow, saveConfig } from './flow.js';
import { tagInput } from '../tags.js';
import { renameInBalance } from './balance.js';

export function flowCandidates(lastGraph: any, customNodes: any[]) {
  const cand = new Map<string, any>();
  (lastGraph?.nodes || [])
    .filter((n: any) => !String(n.id || '').includes('#'))
    .forEach((n: any) => cand.set(n.id, { id: n.id, label: n.label, kind: n.kind }));
  customNodes.forEach((n: any) => cand.set(n.Id, { id: n.Id, label: n.Label || n.Id, kind: n.Kind || 'node', custom: true }));
  return cand;
}

// Auto-tag rules.
export function renderAutoTagRules(flow: any, cand: Map<string, any>, rerender: () => void) {
  const rules = ensure(flow, 'AutoTags', []);
  const box = el('div', { style: { margin: '18px 0' } });
  box.appendChild(el('h3', { text: 'Tags for PDUs and outlets', style: { margin: '4px 0', fontSize: '15px' } }));
  box.appendChild(el('div', { class: 'desc', text: 'Nodes the bridge derives from what it polls have no row of their own to tag. Match them by id, with * for any run of characters: “outlet:rack_pdu_1:*” tags every outlet on that PDU, “pdu:*” every PDU, and a full id one outlet. A tag never changes a reading — only what a view shows and what the exports may carry.' }));

  const ids = [...cand.keys()].filter(id => id.startsWith('pdu:') || id.startsWith('outlet:'));

  const t = el('table', { class: 'ld' });
  const head = el('tr');
  ['Match', 'Tags', 'Matches now', ''].forEach(h => head.appendChild(el('th', { text: h })));
  t.appendChild(el('thead', {}, head));
  const tb = el('tbody');

  rules.forEach((r: any, i: number) => {
    const tr = el('tr');
    const matchIn = el('input', { type: 'text', value: r.Match || '', placeholder: 'outlet:rack_pdu_1:*' }) as HTMLInputElement;
    matchIn.onchange = () => { r.Match = matchIn.value.trim(); refreshDirty(); rerender(); };
    tr.appendChild(el('td', {}, matchIn));

    const tags = ensure(r, 'Tags', []);
    tr.appendChild(el('td', {}, tagInput(tags, { placeholder: 'rack-1, critical', onChange: rerender })));

    const hits = ids.filter(id => globMatches(r.Match || '', id));
    tr.appendChild(el('td', {}, el('span', {
      class: 'desc', style: { margin: '0', color: hits.length ? '' : 'var(--warn)' },
      text: hits.length ? `${hits.length} node(s)` : 'nothing',
      title: hits.length ? hits.slice(0, 20).join('\n') + (hits.length > 20 ? `\n…and ${hits.length - 20} more` : '')
        : 'No PDU or outlet on the current graph has an id this matches.',
    })));

    const del = btn('Remove', 'danger');
    del.onclick = () => { rules.splice(i, 1); refreshDirty(); rerender(); };
    tr.appendChild(el('td', {}, del));
    tb.appendChild(tr);
  });
  t.appendChild(tb);
  if (rules.length) box.appendChild(t);

  const add = btn('+ Add tag rule');
  add.onclick = () => { rules.push({ Match: '', Tags: [] }); refreshDirty(); rerender(); };
  box.appendChild(add);
  return box;
}

/// Matches AutoTags.Matches: '*' is the only wildcard.
export function globMatches(pattern: string, id: string): boolean {
  if (!pattern) return false;
  const rx = '^' + pattern.split('*').map(p => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$';
  return new RegExp(rx, 'i').test(id);
}

// Group manager.
export function renderGroupManager(flow: any, cand: Map<string, any>, rerender: () => void) {
  const groups = ensure(flow, 'Groups', []);
  const box = el('div', { style: { margin: '18px 0' } });
  box.appendChild(el('h3', { text: 'Groups', style: { margin: '4px 0', fontSize: '15px' } }));
  box.appendChild(el('div', { class: 'desc', text: 'Nodes shown as one collapsible node on the flow graphs.' }));

  const nm = (id: string) => (cand.get(id) || {}).label || id;

  const addBar = el('div', { class: 'ld-toolbar' });
  const idIn = el('input', { type: 'text', placeholder: 'group id (e.g. incoming_pv)' }) as HTMLInputElement;
  const labIn = el('input', { type: 'text', placeholder: 'label (e.g. Incoming PV)' }) as HTMLInputElement;
  const kindSel = el('select', { style: { width: 'auto' } });
  NODE_KINDS.forEach(([v, label]) => kindSel.appendChild(el('option', { value: v, text: label })));
  const addBtn = btn('Add group', 'primary');
  addBtn.onclick = () => {
    const id = (idIn.value || '').trim();
    if (!id) { toast('A group id is required.', false); return; }
    if (groups.some((g: any) => g.Id === id) || cand.has(id)) { toast('That id already exists.', false); return; }
    const g: any = { Id: id, Label: (labIn.value || '').trim() || id, Members: [] };
    if (kindSel.value !== 'node') g.Kind = kindSel.value;
    groups.push(g);
    rerender();
  };
  addBar.append(idIn, labIn, kindSel, addBtn);
  box.appendChild(addBar);

  const anchorRow = el('div', { class: 'ld-toolbar' });
  anchorRow.appendChild(el('span', { class: 'desc', style: { margin: '0' }, text: 'Or turn an existing node into a group:' }));
  const anchorSel = el('select', { style: { width: 'auto' } }) as HTMLSelectElement;
  anchorSel.appendChild(el('option', { value: '', text: '— pick a node —' }));
  [...cand.keys()].filter(id => !groups.some((g: any) => g.Id === id)).sort((a, b) => nm(a).localeCompare(nm(b)))
    .forEach(id => anchorSel.appendChild(el('option', { value: id, text: nm(id) })));
  anchorSel.onchange = () => {
    const id = anchorSel.value; if (!id) return;
    groups.push({ Id: id, Label: nm(id), Members: [] });
    toast(`“${nm(id)}” is now a group — add its members below.`, true);
    rerender();
  };
  anchorRow.appendChild(anchorSel);
  box.appendChild(anchorRow);

  if (!groups.length) { box.appendChild(el('div', { class: 'desc', text: 'No groups yet — add one above, then pick its members.' })); return box; }

  groups.forEach((g: any) => {
    const card = el('div', { style: { border: '1px solid var(--line)', borderRadius: '6px', padding: '10px', margin: '8px 0', background: 'var(--panel2)' } });
    const head = el('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' } });
    const labEdit = el('input', { type: 'text', value: g.Label || g.Id, style: { width: '200px' } }) as HTMLInputElement;
    labEdit.onchange = () => { g.Label = labEdit.value.trim() || g.Id; };
    const kindEdit = el('select', { style: { width: 'auto' } });
    NODE_KINDS.forEach(([v, label]) => kindEdit.appendChild(el('option', { value: v, text: label })));
    kindEdit.value = g.Kind || 'node';
    kindEdit.onchange = () => { g.Kind = kindEdit.value === 'node' ? undefined : kindEdit.value; };
    const del = btn('Delete', 'danger');
    del.onclick = () => { groups.splice(groups.indexOf(g), 1); groups.forEach((x: any) => { if (x.Parent === g.Id) delete x.Parent; }); toast(`Group ${g.Label || g.Id} deleted.`, true); rerender(); };
    const within = (x: any) => { for (let p: any = x, n = 0; p && n < groups.length; p = groups.find((q: any) => q.Id === p.Parent), n++) if (p === g) return true; return false; };
    const parentSel = el('select', { style: { width: 'auto' }, title: 'Group this group is nested in' }) as HTMLSelectElement;
    parentSel.appendChild(el('option', { value: '', text: 'Not nested' }));
    groups.filter((x: any) => !within(x)).forEach((x: any) => parentSel.appendChild(el('option', { value: x.Id, text: `In ${x.Label || x.Id}` })));
    parentSel.value = g.Parent || '';
    parentSel.onchange = () => { if (parentSel.value) g.Parent = parentSel.value; else delete g.Parent; };
    head.append(el('code', { text: g.Id, style: { color: 'var(--muted)' } }), labEdit, kindEdit, parentSel, del);
    card.appendChild(head);

    const expRow = el('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap', margin: '8px 0 0' } });
    const expSel = el('select', { style: { width: 'auto' }, title: 'How the group draws when expanded' }) as HTMLSelectElement;
    [['replace', 'Replace with members'], ['parents', 'Nest members as parents'], ['children', 'Nest members as children']]
      .forEach(([v, t]) => expSel.appendChild(el('option', { value: v, text: t })));
    expSel.value = g.Expand || 'replace';
    expSel.onchange = () => { if (expSel.value === 'replace') delete g.Expand; else g.Expand = expSel.value; };
    const allBox = el('input', { type: 'checkbox', checked: !!g.ExpandChildren }) as HTMLInputElement;
    allBox.onchange = () => { if (allBox.checked) g.ExpandChildren = true; else delete g.ExpandChildren; };
    expRow.append(el('span', { class: 'desc', style: { margin: '0', minWidth: '64px' }, text: 'Expanded' }), expSel,
      el('label', { style: { display: 'inline-flex', gap: '5px', alignItems: 'center' } }, allBox, 'Expand all children'));
    card.appendChild(expRow);

    const memRow = el('div', { style: { display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap', margin: '8px 0 0' } });
    memRow.appendChild(el('span', { class: 'desc', style: { margin: '0', minWidth: '64px' }, text: 'Members' }));
    (g.Members || []).forEach((m: string) => {
      const chip = el('span', { style: { display: 'inline-flex', gap: '5px', alignItems: 'center', background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: '10px', padding: '1px 8px', fontSize: '12px' } });
      const x = el('span', { text: '✕', style: { cursor: 'pointer', color: 'var(--bad)' } });
      x.onclick = () => { g.Members.splice(g.Members.indexOf(m), 1); rerender(); };
      chip.append(nm(m), x); memRow.appendChild(chip);
    });
    const sel = el('select', { style: { width: 'auto' } }) as HTMLSelectElement;
    sel.appendChild(el('option', { value: '', text: '+ add member…' }));
    [...cand.keys()].filter(id => id !== g.Id && !(g.Members || []).includes(id)).sort((a, b) => nm(a).localeCompare(nm(b)))
      .forEach(id => sel.appendChild(el('option', { value: id, text: nm(id) })));
    sel.onchange = () => { if (sel.value) { ensure(g, 'Members', []).push(sel.value); rerender(); } };
    memRow.appendChild(sel);
    card.appendChild(memRow);
    box.appendChild(card);
  });

  return box;
}

export let nodeModal: { id: string, body: any, close: () => void } | null = null;

let editOnOpen: string | null = null;
export function editNodeOnNextOpen(id: string) { editOnOpen = id; }

/// `andDeselect` also clears the selected row.
export function closeNodeModal(andDeselect = false) {
  const m = nodeModal;
  nodeModal = null;
  if (m) m.close();
  if (andDeselect) nodeModalDone?.();
}
let nodeModalDone: (() => void) | null = null;

export function syncNodeModal(node: any, links: any[], cand: Map<string, any>, editing: { id: string | null }, rerender: () => void) {
  if (!node) { closeNodeModal(); return; }
  nodeModalDone = () => { editing.id = null; rerender(); };
  if (nodeModal && nodeModal.id !== node.Id) closeNodeModal();
  if (!nodeModal) {
    const status = el('span', { class: 'sheet-dirty' });
    const save = el('button', { class: 'primary', type: 'button', text: 'Save' }) as HTMLButtonElement;
    const done = el('button', { type: 'button', text: 'Done' }) as HTMLButtonElement;
    save.onclick = () => (document.getElementById('btn-save') as any)?.click();
    const unwatch = onDirty((list: any[]) => {
      const n = list.length;
      status.textContent = n ? `${n} unsaved change${n === 1 ? '' : 's'}` : 'All changes saved';
      status.classList.toggle('is-dirty', n > 0);
      save.disabled = n === 0;
    });
    const o = overlay(`Edit node — ${node.Label || node.Id}`, () => { unwatch(); nodeModal = null; editing.id = null; rerender(); },
      { footer: el('div', { class: 'sheet-foot-row' }, status, save, done), className: 'node-sheet', sub: node.Id });
    done.onclick = () => closeNodeModal(true);
    nodeModal = { id: node.Id, body: o.body, close: () => { unwatch(); o.close(); } };
  }
  nodeModal.body.innerHTML = '';
  nodeModal.body.appendChild(renderNodeEditor(node, links, cand, (close?: boolean) => { if (close) editing.id = null; rerender(); }));
}

/// Would adding from -> to close a cycle?
export function wouldLoop(links: any[], from: string, to: string) {
  const adj: any = {};
  links.forEach(l => (adj[l.From] = adj[l.From] || []).push(l.To));
  const stack = [to]; const seen = new Set<string>();
  while (stack.length) {
    const x = stack.pop()!;
    if (x === from) return true;
    if (seen.has(x)) continue;
    seen.add(x);
    (adj[x] || []).forEach((t: string) => stack.push(t));
  }
  return false;
}

// Virtual-node manager.
export function renderNodeManager(flow: any, customNodes: any[], links: any[], cand: Map<string, any>, editing: { id: string | null }, rerender: (close?: boolean) => void, query = '') {
  const box = el('div', { style: { margin: '18px 0' } });
  box.appendChild(el('h3', { text: 'Virtual nodes', style: { margin: '4px 0', fontSize: '15px' } }));
  box.appendChild(el('div', { class: 'desc', text: 'The custom nodes you’ve added (panels, breakers, batteries, producers, a “Total”). Click Edit to set the name, kind, how it’s valued, and bind live values from your broker.' }));

  // The node being edited always stays.
  const q = query.trim().toLowerCase();
  const all = customNodes;
  if (q) {
    const hit = (n: any) => [n.Id, n.Label, n.Kind || 'node', kindMeta(n.Kind)[1], ...(n.Tags || [])]
      .some((v: any) => String(v || '').toLowerCase().includes(q));
    customNodes = all.filter((n: any) => hit(n) || n.Id === editing.id);
    box.appendChild(el('div', { class: 'desc nd-shown', text: `${customNodes.length} of ${all.length} nodes shown` }));
  }

  if (!customNodes.length) {
    if (q) { box.appendChild(el('div', { class: 'desc', text: `Nothing matches “${query.trim()}”.` })); return box; }
    closeNodeModal();
    box.appendChild(el('div', { class: 'desc', text: 'No virtual nodes yet — add one above.' }));
    return box;
  }

  const tbl = el('table', { class: 'ld' });
  const head = el('tr');
  ['Id', 'Label', 'Kind', 'Mode', 'Value', 'Max', 'Tags', 'Fed by', 'Bindings', ''].forEach(h => {
    const th = el('th', { text: h });
    if (h === 'Tags') th.title = 'Free-form labels for filtering the views. A tag never changes a reading.';
    if (h === 'Fed by') th.title = 'What supplies this node. The same wiring as dragging on the Hierarchy tab, without the dragging.';
    if (h === 'Max') th.title = 'Full-scale value for this node’s gauge on the Energy page — a PV array’s peak output, an inverter’s rating, a breaker’s size. Blank shows the plain reading instead; no ceiling is ever guessed.';
    if (h === 'Bindings') th.title = 'Live source bindings. ⚠ = bound, but no energy (kWh) metric — the node won’t appear on Home Assistant’s Energy Dashboard until you add an Energy source.';
    head.appendChild(th);
  });
  tbl.appendChild(el('thead', {}, head));
  const body = el('tbody');
  customNodes.forEach((n: any) => {
    const tr = el('tr');
    if (editing.id === n.Id) tr.style.outline = '2px solid var(--accent, #4f8cff)';
    tr.appendChild(el('td', {}, el('code', { text: n.Id, style: { color: 'var(--muted)' } })));
    tr.appendChild(el('td', { text: n.Label || n.Id }));
    tr.appendChild(el('td', { text: kindMeta(n.Kind)[1] }));
    tr.appendChild(el('td', { text: n.Mode || 'auto' }));
    tr.appendChild(el('td', { class: 'num', text: n.Value ?? '—' }));
    tr.appendChild(el('td', { class: 'num', text: n.Max ?? '—' }));
    tr.appendChild(el('td', { text: (n.Tags || []).join(', ') || '—' }));

    const incoming = links.filter((l: any) => l.To === n.Id).map((l: any) => l.From);
    const fedByCell = el('td');
    if (incoming.length > 1) {
      fedByCell.appendChild(el('span', { text: incoming.map((f: string) => (cand.get(f) || {}).label || f).join(', ') }));
    } else {
      const sel = el('select', { style: { width: 'auto' } }) as HTMLSelectElement;
      sel.appendChild(el('option', { value: '', text: '— none —' }));
      [...cand.keys()]
        .filter(id => id !== n.Id && !String(id).includes('#') && (!feedsNothing((cand.get(id) || {}).kind) || id === incoming[0]))
        .sort((a, b) => ((cand.get(a) || {}).label || a).localeCompare((cand.get(b) || {}).label || b))
        .forEach(id => sel.appendChild(el('option', { value: id, text: (cand.get(id) || {}).label || id })));
      sel.value = incoming[0] || '';
      sel.onchange = () => {
        const feeder = sel.value;
        if (feeder && wouldLoop(links.filter((l: any) => l.To !== n.Id), feeder, n.Id)) {
          toast('That would create a feeder loop.', false);
          sel.value = incoming[0] || '';
          return;
        }
        for (let i = links.length - 1; i >= 0; i--) if (links[i].To === n.Id) links.splice(i, 1);
        if (feeder) links.push({ From: feeder, To: n.Id });
        rerender();
      };
      fedByCell.appendChild(sel);
    }
    tr.appendChild(fedByCell);
    // Measured but no kWh source.
    const srcs = [...(n.Sources || []), ...(n.Mqtt || [])];
    const nb = srcs.length;
    const hasEnergy = srcs.some((s: any) => String(s.Metric || 'realpower').toLowerCase() === 'energy');
    const bindCell = el('td', { class: nb ? '' : 'num' });
    bindCell.appendChild(el('span', { text: nb ? String(nb) : '—' }));
    if (nb && !hasEnergy)
      bindCell.appendChild(el('span', {
        text: ' ⚠', style: { color: 'var(--warn)', fontWeight: '700', cursor: 'help' },
        title: 'No energy (kWh) source bound — this node won’t appear on Home Assistant’s Energy Dashboard. Edit it and add a source with the “Energy” metric to include it.',
      }));
    tr.appendChild(bindCell);

    const actions = el('td', { style: { whiteSpace: 'nowrap' } });
    const edit = btn(editing.id === n.Id ? 'Editing…' : 'Edit');
    edit.onclick = () => { editing.id = editing.id === n.Id ? null : n.Id; rerender(); };
    const rename = btn('Rename');
    rename.title = 'Change this node’s id, moving its wiring with it.';
    rename.onclick = () => {
      const taken = new Set<string>([...cand.keys(), ...customNodes.map((x: any) => x.Id)]);
      taken.delete(n.Id);
      openRenameDialog(n, flow, taken, id => { if (editing.id === n.Id) editing.id = id; rerender(); });
    };

    const copy = btn('Copy');
    copy.title = 'Duplicate this node (kind, mode, value and bindings) under a new id — rename it, then wire it up.';
    copy.onclick = () => {
      const taken = (id: string) => customNodes.some((x: any) => x.Id === id);
      let id = `${n.Id}-copy`;
      for (let i = 2; taken(id); i++) id = `${n.Id}-copy-${i}`;
      const clone = JSON.parse(JSON.stringify(n));
      clone.Id = id;
      clone.Label = `${n.Label || n.Id} (copy)`;
      customNodes.splice(customNodes.indexOf(n) + 1, 0, clone);
      editing.id = id;
      toast(`Copied to '${id}' — rename it and set its feeders.`, true);
      rerender();
    };
    const rm = btn('Delete', 'danger');
    rm.onclick = () => {
      customNodes.splice(customNodes.indexOf(n), 1);
      for (let j = links.length - 1; j >= 0; j--) if (links[j].From === n.Id || links[j].To === n.Id) links.splice(j, 1);
      renameInBalance(flow, n.Id, null);
      if (editing.id === n.Id) editing.id = null;
      toast(`${n.Label || n.Id} deleted.`, true);
      rerender();
    };
    actions.append(edit, ' ', rename, ' ', copy, ' ', rm);
    tr.appendChild(actions);
    body.appendChild(tr);
  });
  tbl.appendChild(body);
  box.appendChild(el('div', { class: 'nodes-scroll' }, tbl));

  syncNodeModal(editing.id ? customNodes.find((n: any) => n.Id === editing.id) : null, links, cand, editing, rerender);
  return box;
}

export function addNodesSection(nav: any, sections: any) {
  const link = navLink(nav, "Nodes", "⬡");
  link.dataset.section = "EnergyFlow";
  const sec = document.createElement('div'); sec.className = 'section'; sections.appendChild(sec);
  const h = document.createElement('h2'); h.textContent = 'Energy Nodes'; sec.appendChild(h);
  const d = document.createElement('div'); d.className = 'desc';
  d.textContent = 'Configure the virtual nodes in your energy hierarchy — panels, breakers, batteries, producers, a “Total”. Set each node’s kind, how it’s valued, its live-value bindings (MQTT / Modbus), and its feeders & children. The wiring also shows visually on the Flow tab.';
  sec.appendChild(d);

  const bar = document.createElement('div'); bar.className = 'ld-toolbar';
  const instSel = instanceSelector(() => load());
  const hunt = el('input', { type: 'search', class: 'nd-hunt', placeholder: 'filter by id, name, kind or tag…' }) as HTMLInputElement;
  hunt.oninput = () => render();
  const count = document.createElement('span'); count.className = 'ld-count';
  bar.appendChild(instSel.wrap); bar.appendChild(hunt); bar.appendChild(count); sec.appendChild(bar);
  const ed: any = document.createElement('div'); ed.style.marginTop = '8px'; sec.appendChild(ed);
  let lastGraph: any = null;
  const editing: { id: string | null } = { id: null };

  const render = () => {
    const flow = ensure(state.data, 'EnergyFlow', {});
    migrateEnergyFlow(flow);
    const customNodes = ensure(flow, 'Nodes', []);
    const links = ensure(flow, 'Links', []);
    if (editOnOpen) { editing.id = editOnOpen; editOnOpen = null; }
    count.textContent = `${customNodes.length} node(s)`;
    ed.innerHTML = '';

    const addBar = el('div', { class: 'ld-toolbar' });
    const idIn = el('input', { type: 'text', placeholder: 'id (e.g. gridboss)' });
    const labIn = el('input', { type: 'text', placeholder: 'label (e.g. Grid Boss)' });
    const kindSel = el('select', { style: { width: 'auto' } });
    NODE_KINDS.forEach(([v, label]) => kindSel.appendChild(el('option', { value: v, text: label })));
    const addBtn = btn('Add node', 'primary');
    const importBtn = btn('Import device template');
    const save = btn('Save', 'primary');
    addBtn.onclick = () => {
      const id = (idIn.value || '').trim(); if (!id) { toast('Node id is required.', false); return; }
      if (customNodes.some((n: any) => n.Id === id) || (lastGraph?.nodes || []).some((n: any) => n.id === id)) { toast('That id already exists.', false); return; }
      const node: any = { Id: id, Label: (labIn.value || '').trim() || id, Mode: 'none' };
      if (kindSel.value !== 'node') node.Kind = kindSel.value;
      customNodes.push(node); editing.id = id; render();
    };
    save.onclick = () => saveConfig(load);
    addBar.append(idIn, labIn, kindSel, addBtn, importBtn, save); ed.appendChild(addBar);

    const existingIds = new Set<string>([...customNodes.map((n: any) => n.Id), ...((lastGraph?.nodes || []).map((n: any) => n.id))]);
    const impWrap = el('div'); ed.appendChild(impWrap);
    importBtn.onclick = () => {
      if (impWrap.firstChild) { impWrap.innerHTML = ''; return; }
      impWrap.appendChild(renderImportPanel(flow, existingIds, render));
    };

    const cand = flowCandidates(lastGraph, customNodes);
    const goTo = (label: string) => (document.querySelector(`nav a[data-label="${label}"]`) as any)?.click();
    ed.appendChild(el('div', { class: 'desc', style: { margin: '4px 0 0' } },
      el('span', { text: 'Groups are managed on the ' }),
      el('a', { text: 'Groups page', onclick: () => goTo('Groups') }),
      el('span', { text: ', and tags — including the rules that tag PDUs and outlets — on the ' }),
      el('a', { text: 'Tags page', onclick: () => goTo('Tags') }),
      el('span', { text: '.' })));
    ed.appendChild(renderNodeManager(flow, customNodes, links, cand, editing, (close?: boolean) => { if (close) editing.id = null; render(); }, hunt.value));
  };

  const load = async () => {
    const r = await api(withInstance('/api/flow', instSel));
    lastGraph = r.body?.ok ? r.body : null;
    render();
  };
  link.onclick = () => { activate(link, sec); load(); };
  nav.addEventListener('click', (e: any) => { if (nodeModal && !link.contains(e.target)) { editing.id = null; closeNodeModal(); } });
}
