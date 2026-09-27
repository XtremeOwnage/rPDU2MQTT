// Help for a templated text field: what each {placeholder} means, an example of what it becomes, and a
// preview of the whole template filled in. Click a placeholder to insert it at the cursor, or drag it in.
//
// The placeholders a field takes come from the server ([TemplateVariables] on the setting, served as
// `templateVars` in the schema), so any templated setting drawn from the schema gets this for nothing; a
// hand-built field passes its list and, where it knows them, the real values (the node being edited).
import { el } from './helpers.js';
import { state } from './state.js';
import { refreshDirty } from './dirty.js';

type TemplateVar = { what: string; example: () => string };

const firstPdu = () => Object.keys(state.data?.Pdus || {})[0];

/// Every placeholder the server fills in, what it stands for, and a plausible value for the preview.
export const TEMPLATE_VARS: Record<string, TemplateVar> = {
  device: { what: 'PDU name', example: () => 'rack_pdu_1' },
  instance: { what: 'PDU entry key (Pdus)', example: () => firstPdu() || 'default' },
  serial: { what: 'PDU serial number', example: () => 'A1B2C3D4' },
  source: { what: 'Outlet or source id', example: () => 'dell_md1200' },
  outlet: { what: 'Outlet id (same as {source})', example: () => 'dell_md1200' },
  name: { what: 'Display name', example: () => 'Dell MD1200' },
  number: { what: 'Outlet number', example: () => '7' },
  group: { what: 'Outlet group name', example: () => 'Rack A' },
  type: { what: 'Measurement type', example: () => 'realpower' },
  metric: { what: 'Metric', example: () => 'realpower' },
  units: { what: 'Units', example: () => 'W' },
  node: { what: 'Node id', example: () => 'solar' },
  id: { what: 'Node id', example: () => 'solar' },
  label: { what: 'Node label', example: () => 'Solar (PV)' },
  kind: { what: 'Node kind', example: () => 'solar' },
  parent: { what: 'MQTT parent topic', example: () => state.data?.MQTT?.ParentTopic || 'rPDU2MQTT' },
  base: { what: 'EmonCMS MQTT base topic', example: () => state.data?.EmonCMS?.MqttBaseTopic || 'emon' },
};

export type TemplateHelpOpts = {
  /// Real values where the field knows them, e.g. the node being edited; the rest use the examples above.
  examples?: Record<string, string>;
  /// What an empty field means, e.g. "EmonCMS page default".
  whenBlank?: string;
  /// The template the server uses when the field is empty; previewed in its place, marked as the default.
  blankTemplate?: string;
};

/// The placeholder chips and the preview for `input`, which must sync its model in its `onchange`.
export function templateHelp(input: any, vars: string[], opts: TemplateHelpOpts = {}) {
  const exampleOf = (v: string) => opts.examples?.[v] ?? TEMPLATE_VARS[v]?.example() ?? v;
  const box = el('div', { class: 'tpl-help' });
  let dragging = false;

  const chips = el('div', { class: 'tpl-vars' });
  vars.forEach(v => {
    const token = '{' + v + '}';
    const chip = el('button', { class: 'tpl-chip', type: 'button' },
      el('code', { class: 'tpl-token', text: token }),
      el('span', { class: 'tpl-eg', text: exampleOf(v) })) as HTMLButtonElement;
    chip.draggable = true;
    chip.title = `${TEMPLATE_VARS[v]?.what || v} — e.g. ${exampleOf(v)}. Click to insert at the cursor, or drag into the field.`;
    chip.dataset.var = v;
    chip.onclick = () => {
      const len = String(input.value || '').length;
      const s = input.selectionStart ?? len, e = input.selectionEnd ?? len;
      input.value = String(input.value || '').slice(0, s) + token + String(input.value || '').slice(e);
      const pos = s + token.length;
      input.focus?.();
      input.setSelectionRange?.(pos, pos);
      sync();
    };
    chip.addEventListener('dragstart', (ev: any) => {
      dragging = true;
      ev.dataTransfer?.setData('text/plain', token);
      if (ev.dataTransfer) ev.dataTransfer.effectAllowed = 'copy';
    });
    chip.addEventListener('dragend', () => { dragging = false; input.focus?.(); });
    chips.appendChild(chip);
  });

  const preview = el('div', { class: 'tpl-preview' });
  const draw = () => {
    preview.innerHTML = '';
    const typed = String(input.value || '');
    box.classList.toggle('is-blank', !typed);
    const value = typed || opts.blankTemplate || '';
    preview.appendChild(el('span', { class: 'tpl-arrow', text: '→' }));
    if (!value) {
      preview.appendChild(el('span', { class: 'tpl-blank', text: opts.whenBlank || 'blank' }));
      return;
    }
    if (!typed) preview.appendChild(el('span', { class: 'tpl-blank', text: 'default: ' }));
    // Literal text as typed, each placeholder as the value it becomes, and anything in braces this field
    // does not know as an error: it would be written out as-is.
    value.split(/(\{[A-Za-z_]+\})/).forEach(part => {
      if (!part) return;
      const m = /^\{([A-Za-z_]+)\}$/.exec(part);
      if (!m) { preview.appendChild(el('span', { class: 'tpl-lit', text: part })); return; }
      if (vars.includes(m[1])) preview.appendChild(el('span', { class: 'tpl-val', text: exampleOf(m[1]), title: part }));
      else preview.appendChild(el('span', { class: 'tpl-bad', text: part, title: `${part} is not a placeholder here; it is written as-is.` }));
    });
  };
  /// Write the new text through the field's own handler, so the model and the save bar see it.
  const sync = () => {
    if (typeof input.onchange === 'function') input.onchange({ target: input });
    refreshDirty();
    draw();
  };
  input.addEventListener('input', draw);
  input.addEventListener('change', draw);
  // A dropped placeholder lands where the pointer is; the browser inserts it, and it is kept from there.
  input.addEventListener('drop', () => setTimeout(sync, 0));
  draw();

  // The placeholders are shown while the field is being edited; otherwise only the preview of what it
  // holds. A click on a chip takes focus from the field for a moment, so closing waits to see where it went.
  const open = () => {
    box.classList.add('is-open');
    // Opening near the foot of a dialog would put the chips under its pinned footer.
    setTimeout(() => {
      const panel = box.closest?.('.sheet-panel');
      if (!panel?.getBoundingClientRect) return;
      const foot = panel.querySelector('.sheet-sticky-foot');
      const limit = (foot || panel).getBoundingClientRect().top - (foot ? 8 : 0);
      const over = box.getBoundingClientRect().bottom - limit;
      if (over > 0) panel.scrollTop += over;
    }, 0);
  };
  const closeUnlessInside = () => setTimeout(() => {
    const at = document.activeElement;
    if (dragging || at === input || (at && box.contains(at))) return;
    box.classList.remove('is-open');
  }, 150);
  input.addEventListener('focus', open);
  input.addEventListener('blur', closeUnlessInside);
  box.addEventListener('focusout', closeUnlessInside);

  box.append(chips, preview);
  return box;
}
