// Plugin-provided GUI pages, mounted on first open.
import { activate, api, btn, el, ensure, navLink, toast } from './helpers.js';
import { state } from './state.js';
import { refreshDirty } from './dirty.js';
import { saveConfig } from './sections/flow.js';
import { openHistorySheet } from './history-sheet.js';
import { busyInSection } from './realtime.js';
import { timelineStrip } from './sections/timeline.js';
import { stepToFit } from './sections/trends-shared.js';

export type PluginPage = { integration: string; id: string; title: string; group: string; icon?: string; configSection?: string };

export let pluginPages: PluginPage[] = [];

export async function loadPluginPages() {
  try {
    const r = await api('/api/integrations');
    pluginPages = (r.body?.integrations || []).flatMap((i: any) =>
      (i.pages || []).map((p: any) => ({ ...p, integration: i.id })));
  } catch { pluginPages = []; }
}

const pluginPageHost = () => ({ api, btn, el, ensure, toast, state, refreshDirty, saveConfig, openHistorySheet, busyInSection, timelineStrip, stepToFit });

export function pluginPageTool(p: PluginPage) {
  return (nav: any, sections: any) => {
    const link = navLink(nav, p.title, p.icon || '•');
    if (p.configSection) link.dataset.section = p.configSection;
    const sec = el('div', { class: 'section' });
    sections.appendChild(sec);
    const base = `/api/integrations/${encodeURIComponent(p.integration)}/pages/${encodeURIComponent(p.id)}`;
    let page: any = null;
    const mount = async () => {
      if (page) return;
      try {
        const [js, css] = await Promise.all([fetch(base + '.js').then(r => r.ok ? r.text() : Promise.reject(new Error('HTTP ' + r.status))),
          fetch(base + '.css').then(r => r.ok ? r.text() : '')]);
        if (css) (document.head ?? document.body).appendChild(el('style', { text: css }));
        page = new Function(js)()(sec, pluginPageHost()) || {};
      } catch (e: any) {
        sec.textContent = '';
        sec.append(el('h2', { text: p.title }), el('div', { class: 'desc', text: `${p.title} could not be loaded: ${e?.message || e}` }));
      }
    };
    link.onclick = async () => { activate(link, sec); await mount(); page?.show?.(); };
    return { link, sec };
  };
}
