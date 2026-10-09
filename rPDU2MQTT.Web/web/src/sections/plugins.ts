// System › Plugins: a switch per plugin found. Off means it is not loaded at the next start.
import { api, el, activate, navLink } from '../helpers.js';
import { state } from '../state.js';
import { refreshDirty } from '../dirty.js';

export function addPluginsSection(nav: any, sections: any) {
  const link = navLink(nav, 'Plugins', '⧉');
  link.dataset.section = 'DisabledPlugins';
  const sec = el('div', { class: 'section' }); sections.appendChild(sec);
  sec.appendChild(el('h2', { text: 'Plugins' }));
  const list = el('div'); sec.appendChild(list);

  const isOff = (key: string) => (state.data.DisabledPlugins || []).some((k: string) => k.toLowerCase() === key.toLowerCase());
  const setOff = (key: string, off: boolean) => {
    const keep = (state.data.DisabledPlugins || []).filter((k: string) => k.toLowerCase() !== key.toLowerCase());
    state.data.DisabledPlugins = off ? [...keep, key] : keep;
    refreshDirty();
  };

  const render = (plugins: any[]) => {
    list.innerHTML = '';
    if (!plugins.length) { list.appendChild(el('div', { class: 'desc', text: 'No plugins found.' })); return; }
    for (const p of plugins) {
      const input: any = el('input', { type: 'checkbox', class: 'switch' });
      input.checked = !isOff(p.key);
      const label = el('span', { class: 'switch-state', text: input.checked ? 'On' : 'Off' });
      input.onchange = () => { setOff(p.key, !input.checked); label.textContent = input.checked ? 'On' : 'Off'; };
      const meta = [p.version, p.bundled ? 'Bundled' : 'External', p.disabled ? 'Not loaded' : p.error ? 'Failed: ' + p.error : 'Loaded']
        .filter(Boolean).join(' · ');
      const f = el('div', { class: 'field' }, el('label', { text: p.name }), el('div', { class: 'desc', text: meta }), el('label', { class: 'switch-wrap' }, input, label));
      f.dataset.path = 'DisabledPlugins.' + p.key;
      list.appendChild(f);
    }
  };

  link.onclick = async () => {
    activate(link, sec);
    try { const r = await api('/api/plugins'); render(Array.isArray(r.body) ? r.body : []); }
    catch { render([]); }
  };
}
