// Which editor a source binding gets, keyed by its type.
//
// A binding's Source and Details columns are type-specific: MQTT wants a topic picker and a JSON field,
// Modbus wants a connection and a register spec. Those two are built into this bundle because they are
// genuinely bespoke — a topic browser and a register scanner are not a form.
//
// Everything else falls back to the generic editor, which reads and writes the binding's open `Settings`
// bag. That is what lets a plugin contribute a source type without shipping any TypeScript: it declares
// the type on the server, the node editor offers it in the dropdown, and its settings are editable here
// as ordinary key/value rows. A plugin that later wants a bespoke editor registers one; nothing else has
// to change.
import { el, btn } from './helpers.js';

/// Renders the Source and Details cells for one binding. Returns the two cells, in order.
export type SourceEditor = (src: any, onChange: () => void) => [any, any];

const editors = new Map<string, SourceEditor>();

/// Register a bespoke editor for a source type. Built-ins call this; a future plugin editor would too.
export function registerSourceEditor(type: string, editor: SourceEditor) {
  editors.set(type.toLowerCase(), editor);
}

/// The editor for a type, or null when it should use the generic one.
export function sourceEditorFor(type: string | undefined): SourceEditor | null {
  return editors.get((type || 'mqtt').toLowerCase()) || null;
}

/// The generic editor: the binding's own Settings, as editable rows.
///
/// Deliberately shows what is there rather than guessing what should be — the server knows a plugin's
/// source type exists but nothing describes its fields, and inventing a form for fields nobody declared
/// would be worse than an honest key/value list.
export function genericSourceEditor(src: any, onChange: () => void): [any, any] {
  if (!src.Settings) src.Settings = {};

  const rows = el('div', { style: { display: 'flex', flexDirection: 'column', gap: '3px' } });

  const draw = () => {
    rows.innerHTML = '';
    Object.keys(src.Settings).forEach(key => {
      const row = el('div', { style: { display: 'flex', gap: '4px', alignItems: 'center' } });
      const k = el('input', { type: 'text', value: key, style: { width: '110px' } }) as HTMLInputElement;
      const v = el('input', { type: 'text', value: String(src.Settings[key] ?? ''), style: { width: '150px' } }) as HTMLInputElement;
      k.onchange = () => {
        if (!k.value.trim() || k.value === key) { k.value = key; return; }
        src.Settings[k.value.trim()] = src.Settings[key];
        delete src.Settings[key];
        onChange(); draw();
      };
      v.onchange = () => { src.Settings[key] = v.value; onChange(); };
      const del = btn('✕', 'danger');
      del.title = `Remove '${key}'`;
      del.onclick = () => { delete src.Settings[key]; onChange(); draw(); };
      row.append(k, v, del);
      rows.appendChild(row);
    });

    const add = btn('+ setting');
    add.onclick = () => {
      let name = 'setting', n = 1;
      while (name in src.Settings) name = `setting${++n}`;
      src.Settings[name] = '';
      onChange(); draw();
    };
    rows.appendChild(add);
  };
  draw();

  return [
    el('td', {}, el('span', { class: 'desc', style: { margin: '0' }, text: 'plugin source' })),
    el('td', {}, rows),
  ];
}
