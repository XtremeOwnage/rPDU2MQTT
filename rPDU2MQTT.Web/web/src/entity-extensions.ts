// Settings plugins keep on core entities they do not define — a node, a panel, a breaker — rendered from each
// plugin's settings class, as a plugin's own section is. Stored in the entity's Ext, keyed by plugin id.
import { el, ensure } from './helpers.js';
import { state } from './state.js';
import { refreshDirty } from './dirty.js';
import { renderObjectBody } from './config-form.js';

/// The plugin sections declared for one kind of entity, read off its extension point in the schema.
export function extensionsFor(kind: string): any[] {
  const walk = (nodes: any[] | undefined): any[] | null => {
    for (const n of nodes || []) {
      if (n.extensionOf === kind) return n.extensions || [];
      const hit = walk(n.properties) ?? (n.valueSchema ? walk([n.valueSchema]) : null);
      if (hit) return hit;
    }
    return null;
  };
  return walk(state.schema) || [];
}

/// A fieldset per plugin with this entity's settings. The entity only gains an Ext entry once something in it
/// is changed, so opening an editor is never an edit. Returns how many plugins have a section.
export function renderExtensions(kind: string, entity: any, container: any, path: string[], onChange?: () => void): number {
  const sections = extensionsFor(kind);
  sections.forEach(sec => {
    const target = entity.Ext?.[sec.key] || {};
    const fs = el('fieldset', { class: 'ext-section' });
    fs.dataset.plugin = sec.key;
    fs.appendChild(el('legend', { text: sec.label }));
    renderObjectBody(sec.properties || [], target, fs, [...path, 'Ext', sec.key]);
    // Runs after the control's own handler, which has already written into target.
    const attach = () => { ensure(entity, 'Ext', {})[sec.key] = target; onChange?.(); refreshDirty(); };
    fs.addEventListener('change', attach);
    fs.addEventListener('click', (e: any) => { if (e.target?.tagName === 'BUTTON') attach(); });
    container.appendChild(fs);
  });
  return sections.length;
}
