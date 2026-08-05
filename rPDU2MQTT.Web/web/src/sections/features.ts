// One page for every on/off switch in the product (#292).
//
// Each feature used to carry its own Enabled toggle on its own config page, so answering "what is this
// bridge actually doing?" meant opening eight pages and reading eight switches. They are gathered here
// instead, and removed from the individual pages, so there is exactly one place a feature is turned on and
// exactly one answer to what is running.
//
// The list comes from the schema: the server marks the one setting that turns each capability on
// ([FeatureToggle]), so a new one appears here without this file changing. It is marked rather than guessed
// from the name because the names genuinely differ — Gui.Enabled, but HomeAssistant.DiscoveryEnabled and
// Prometheus.Exporter — and a rule of "the boolean called Enabled" would have dropped the last two.
import { el, btn, activate, navLink, ensure } from '../helpers.js';
import { state } from '../state.js';
// The schema field renderer, so a switch here is the same control as on the section page — same change
// tracking, same locked-field handling. (The bundle is one shared scope, so this import is erased.)
import { renderNode } from '../config-form.js';

/// A section's feature switch, if it has one. Exported so the config form filters exactly the property this
/// page renders — the two must agree, or a toggle is either duplicated or lost entirely.
export function featureToggle(node: any): any | null {
  if (node?.type !== 'object') return null;
  return (node.properties || []).find((p: any) => p.isFeatureToggle) || null;
}

/// Jump to a feature's own settings page. Nav links carry the schema key they edit, so this finds the page
/// without a second table of where things live.
export function jumpToSection(key: string) {
  const links: any[] = Array.from(document.querySelectorAll('nav a'));
  const link = links.find(a => a.dataset && a.dataset.section === key);
  if (link) link.click();
}

/// The reverse trip: from a section's "turned on and off on the Features page" note back to this page.
export function jumpToFeatures() {
  const links: any[] = Array.from(document.querySelectorAll('nav a'));
  const link = links.find(a => a.dataset && a.dataset.label === 'Features');
  if (link) link.click();
}

export function addFeaturesSection(nav: any, sections: any) {
  const link = navLink(nav, 'Features', '◉');
  const sec = document.createElement('div'); sec.className = 'section'; sections.appendChild(sec);
  sec.appendChild(el('h2', { text: 'Features' }));
  sec.appendChild(el('div', {
    class: 'desc',
    text: 'Everything this bridge can do, and whether it is doing it. Turning a feature on here does not configure it — use Settings on the card for that.',
  }));

  const body = el('div');
  sec.appendChild(body);

  const render = () => {
    body.innerHTML = '';
    const grid = el('div', { class: 'grid' });

    const feats = state.schema
      .map((n: any) => ({ section: n, prop: featureToggle(n) }))
      .filter((f: any) => f.prop);

    feats.forEach(({ section, prop }: any) => {
      const label = FEATURE_LABELS[section.key] || section.label || section.key;
      // The card's identity is the feature, not the word "Enabled" — and the description that explains the
      // feature is the section's, since the property's own is usually just "turn it on".
      renderNode({ ...prop, label, description: prop.description || section.description }, ensure(state.data, section.key, {}), grid, [section.key]);

      const card = grid.children[grid.children.length - 1] as any;
      const go = btn('Settings');
      go.onclick = () => jumpToSection(section.key);
      card.appendChild(el('div', { class: 'feature-go' }, go));
    });

    body.appendChild(grid);
    if (!feats.length) body.appendChild(el('div', { class: 'desc', text: 'No optional features in this build.' }));
  };

  // Re-read on every visit: the switches are bound to the live config document, which the section pages and
  // a reload both change underneath this page.
  link.onclick = () => { render(); activate(link, sec); };
  return { link, sec };
}

// Names that read as a capability rather than as a config section. Anything unlisted keeps its section
// label, so this is a polish list, not a registry to maintain.
const FEATURE_LABELS: Record<string, string> = {
  Gui: 'Web GUI',
  Api: 'REST API',
  Health: 'Health endpoints',
  Modbus: 'Modbus TCP polling',
  EmonCMS: 'EmonCMS export',
  HomeAssistant: 'Home Assistant discovery',
  Prometheus: 'Prometheus metrics',
  Operator: 'Kubernetes operator',
  Cache: 'Persistent cache (Valkey/Redis)',
};
