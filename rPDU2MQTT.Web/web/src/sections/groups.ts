// Node groups page.
import { activate, api, btn, el, ensure, navLink, withInstance, instanceSelector } from '../helpers.js';
import { state } from '../state.js';
import { saveConfig } from '../config-form.js';
import { flowCandidates, renderGroupManager } from './nodes.js';

export function addGroupsSection(nav: any, sections: any) {
  const link = navLink(nav, 'Groups', '⧉');
  link.dataset.section = 'EnergyFlow';
  const sec = el('div', { class: 'section' });
  sections.appendChild(sec);
  sec.appendChild(el('h2', { text: 'Node groups' }));

  const instSel = instanceSelector(() => load());
  const save = btn('Save', 'primary');
  const count = el('span', { class: 'ld-count' });
  sec.appendChild(el('div', { class: 'ld-toolbar' }, instSel.wrap, save, count));
  const ed = el('div');
  sec.appendChild(ed);

  let lastGraph: any = null;
  const render = () => {
    const flow = ensure(state.data, 'EnergyFlow', {});
    const groups = ensure(flow, 'Groups', []);
    count.textContent = `${groups.length} group(s)`;
    ed.innerHTML = '';
    ed.appendChild(renderGroupManager(flow, flowCandidates(lastGraph, ensure(flow, 'Nodes', [])), render));
  };

  const load = async () => {
    let r: any;
    try { r = await api(withInstance('/api/flow', instSel)); } catch { r = null; }
    lastGraph = r?.body?.ok ? r.body : null;
    render();
  };
  save.onclick = () => saveConfig(load);
  link.onclick = () => { activate(link, sec); load(); };
  return { link, sec };
}
