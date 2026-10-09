// System › Plugins: a switch per plugin found, and per integration of a plugin with several. Off applies at the next start.
import { api, el, activate, navLink } from '../helpers.js';
import { state } from '../state.js';
import { refreshDirty } from '../dirty.js';

export function addPluginsSection(nav: any, sections: any) {
  const link = navLink(nav, 'Plugins', '⧉');
  link.dataset.section = 'DisabledPlugins,DisabledIntegrations';
  const sec = el('div', { class: 'section' }); sections.appendChild(sec);
  sec.appendChild(el('h2', { text: 'Plugins' }));
  const list = el('div'); sec.appendChild(list);

  // `setting` is DisabledPlugins or DisabledIntegrations: a key listed there is off.
  const listed = (setting: string, key: string) => (state.data[setting] || []).some((k: string) => k.toLowerCase() === key.toLowerCase());
  const setListed = (setting: string, key: string, off: boolean) => {
    const keep = (state.data[setting] || []).filter((k: string) => k.toLowerCase() !== key.toLowerCase());
    state.data[setting] = off ? [...keep, key] : keep;
    refreshDirty();
  };
  const toggle = (setting: string, key: string, path: string, onChange?: (on: boolean) => void) => {
    const input: any = el('input', { type: 'checkbox', class: 'switch' });
    input.checked = !listed(setting, key);
    const label = el('span', { class: 'switch-state', text: input.checked ? 'On' : 'Off' });
    input.onchange = () => { setListed(setting, key, !input.checked); label.textContent = input.checked ? 'On' : 'Off'; onChange?.(input.checked); };
    const wrap = el('label', { class: 'switch-wrap' }, input, label);
    return { input, wrap, path };
  };

  const render = (plugins: any[]) => {
    list.innerHTML = '';
    if (!plugins.length) { list.appendChild(el('div', { class: 'desc', text: 'No plugins found.' })); return; }
    for (const p of plugins) {
      const parts: any[] = p.parts || [];
      const meta = [p.version, p.bundled ? 'Bundled' : 'External', p.disabled ? 'Not loaded' : p.error ? 'Failed: ' + p.error : 'Loaded',
        parts.length === 1 ? capabilityText(parts[0].capabilities) : null].filter(Boolean).join(' · ');
      const subs: any[] = [];
      const main = toggle('DisabledPlugins', p.key, 'DisabledPlugins.' + p.key, on => subs.forEach(t => { t.input.disabled = !on; }));
      const f = el('div', { class: 'field' }, el('label', { text: p.name }));
      if (p.description) f.appendChild(el('div', { class: 'desc', text: p.description }));
      f.append(el('div', { class: 'desc', text: meta }), main.wrap);
      f.dataset.path = main.path;
      list.appendChild(f);
      if (parts.length < 2) continue;
      for (const part of parts) {
        const t = toggle('DisabledIntegrations', part.id, 'DisabledIntegrations.' + part.id);
        t.input.disabled = !main.input.checked;
        subs.push(t);
        const row = el('div', { class: 'field plugin-part' }, el('label', { text: part.name }),
          el('div', { class: 'desc', text: [part.id, capabilityText(part.capabilities)].filter(Boolean).join(' · ') }), t.wrap);
        row.dataset.path = t.path;
        list.appendChild(row);
      }
    }
  };

  link.onclick = async () => {
    activate(link, sec);
    try { const r = await api('/api/plugins'); render(Array.isArray(r.body) ? r.body : []); }
    catch { render([]); }
  };
}

const CAPABILITIES: Record<string, string> = {
  destination: 'Destination', configures: 'Publishes configuration', history: 'History', source: 'Node values', values: 'Node values',
  device: 'Device source', control: 'Outlet control', discovers: 'Node discovery', actions: 'Actions', pages: 'GUI pages',
};

/** What an integration does, in words. */
function capabilityText(caps: string[] = []): string {
  return [...new Set(caps.map(c => CAPABILITIES[c] || c))].join(', ');
}
