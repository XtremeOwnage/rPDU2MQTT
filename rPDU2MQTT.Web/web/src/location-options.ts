// The circuits in the configuration, as picker options — for anything that says which circuit a node is on (#465).
import { el } from './helpers.js';
import { state } from './state.js';

/// Every breaker in use in every panel as ["panel/number", label]; an unused slot is not a circuit anything is on.
export function circuitChoices(): [string, string][] {
  const panels: any[] = state.data?.EnergyFlow?.Panels || [];
  return panels.flatMap(p => (p.Breakers || []).filter((b: any) => b.State !== 'unused').map((b: any) =>
    [`${p.Id}/${b.Number}`, `${p.Name || p.Id} · ${b.Number}${b.Description ? ' — ' + b.Description : ''}`] as [string, string]));
}

/// A select over some choices with a blank first option, keeping a current value that is not among them.
export function choiceSelect(choices: [string, string][], value: string, blank: string): HTMLSelectElement {
  const sel = el('select', {}) as HTMLSelectElement;
  sel.appendChild(el('option', { value: '', text: blank }));
  choices.forEach(([v, t]) => sel.appendChild(el('option', { value: v, text: t })));
  if (value && !choices.some(([v]) => v === value)) sel.appendChild(el('option', { value, text: `${value} (not found)` }));
  sel.value = value || '';
  return sel;
}
