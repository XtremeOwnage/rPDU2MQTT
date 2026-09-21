// The places and circuits in the configuration, as picker options — for anything that says where a node is
// or which circuit it is on (#461, #465).
import { el } from './helpers.js';
import { state } from './state.js';

/// Every site, floor, room and area as [id, label], indented by depth so the tree reads in a flat list.
export function locationChoices(): [string, string][] {
  const out: [string, string][] = [];
  const sites: any[] = state.data?.EnergyFlow?.Sites || [];
  sites.forEach(s => {
    out.push([s.Id, s.Name || s.Id]);
    (s.Floors || []).slice().sort((a: any, b: any) => (a.Level || 0) - (b.Level || 0)).forEach((f: any) => {
      out.push([f.Id, `  ${f.Name || f.Id}`]);
      (f.Rooms || []).forEach((r: any) => out.push([r.Id, `    ${r.Name || r.Id}`]));
      (f.Areas || []).forEach((a: any) => out.push([a.Id, `    ${a.Name || a.Id} (area)`]));
    });
  });
  return out;
}

/// Every breaker in every panel as ["panel/number", label].
export function circuitChoices(): [string, string][] {
  const panels: any[] = state.data?.EnergyFlow?.Panels || [];
  return panels.flatMap(p => (p.Breakers || []).map((b: any) =>
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
