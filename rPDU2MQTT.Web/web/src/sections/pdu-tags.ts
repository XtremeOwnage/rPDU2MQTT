// PDU tags: default tags for every PDU and outlet, and each one's own, kept as the EnergyFlow tag rules.
import { api, el, ensure } from '../helpers.js';
import { state } from '../state.js';
import { refreshDirty } from '../dirty.js';
import { tagInput } from '../tags.js';

/// A tag box for the rule whose pattern is exactly `match`; the rule exists only while it carries a tag.
function ruleTags(match: string) {
  const rules = () => ensure(ensure(state.data, 'EnergyFlow', {}), 'AutoTags', []);
  const find = () => rules().find((x: any) => String(x.Match || '').trim().toLowerCase() === match.toLowerCase());
  const arr: string[] = [...(find()?.Tags || [])];
  return tagInput(arr, {
    placeholder: 'add tag',
    onChange: () => {
      const list = rules();
      const rule = find();
      if (!arr.length) { if (rule) list.splice(list.indexOf(rule), 1); }
      else if (rule) rule.Tags = [...arr];
      else list.push({ Match: match, Tags: [...arr] });
      refreshDirty();
    },
  });
}

/// The tags panel for the PDU page; it reads the discovered PDUs and outlets when the page is opened.
export function renderPduTags(sec: any): HTMLElement {
  const box = el('div', { class: 'pdu-tags', style: { margin: '18px 0' } });
  let graph: any = null;

  const draw = () => {
    box.innerHTML = '';
    box.appendChild(el('h3', { text: 'Tags', style: { margin: '4px 0', fontSize: '15px' } }));
    box.appendChild(el('div', { class: 'desc', text:
      'Tags for what the PDUs report. Every PDU and every outlet can carry default tags, and each one its own '
      + 'on top of them. Patterns covering part of a PDU are on the Nodes page, and every tag is listed on the '
      + 'Tags page. Circuits are not nodes in the energy flow, so they cannot carry tags yet.' }));

    const defaults = el('table', { class: 'ld' });
    defaults.appendChild(el('thead', {}, el('tr', {}, el('th', { text: 'Applies to' }), el('th', { text: 'Default tags' }))));
    const dbody = el('tbody');
    ([['All PDUs', 'pdu:*'], ['All outlets', 'outlet:*']] as [string, string][]).forEach(([name, match]) =>
      dbody.appendChild(el('tr', {}, el('td', { text: name }), el('td', {}, ruleTags(match)))));
    defaults.appendChild(dbody);
    box.appendChild(defaults);

    const derived = (graph?.nodes || [])
      .filter((n: any) => /^(pdu|outlet):/.test(String(n.id || '')))
      .sort((a: any, b: any) => String(a.id).localeCompare(String(b.id), undefined, { numeric: true }));
    if (!derived.length) {
      box.appendChild(el('div', { class: 'desc', style: { marginTop: '8px' },
        text: 'No PDU or outlet has been reported yet, so there is nothing to tag individually.' }));
      return;
    }
    const items = el('table', { class: 'ld', style: { marginTop: '10px' } });
    items.appendChild(el('thead', {}, el('tr', {}, el('th', { text: 'PDU or outlet' }), el('th', { text: 'Id' }), el('th', { text: 'Its own tags' }))));
    const ibody = el('tbody');
    derived.forEach((n: any) => ibody.appendChild(el('tr', {},
      el('td', { text: n.label || n.id }), el('td', { class: 'desc', text: n.id }), el('td', {}, ruleTags(n.id)))));
    items.appendChild(ibody);
    box.appendChild(items);
  };

  const load = async () => {
    try { const r: any = await api('/api/flow'); graph = r?.body?.ok ? r.body : null; } catch { graph = null; }
    draw();
  };

  draw();
  window.addEventListener('rpdu:activate', () => { if (sec.classList.contains('active')) load(); });
  return box;
}
