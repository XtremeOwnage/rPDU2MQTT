// A picker with a search box at the top of its list, for choices too many to scroll: circuits, meters, nodes.
import { el } from './helpers.js';

export type Choice = { value: string; label: string; hint?: string; group?: string };

/// A button showing the current choice; opening it shows a search box and the choices matching what is typed.
export function searchSelect(choices: Choice[], value: string, onPick: (v: string) => void, opts: { placeholder?: string; title?: string } = {}): any {
  const wrap = el('div', { class: 'ss' });
  const current = () => choices.find(c => c.value === value) || choices[0];
  const face = el('button', { class: 'ss-btn', type: 'button', title: opts.title || '' },
    el('span', { class: 'ss-face', text: current()?.label || '' }), el('span', { class: 'ss-caret', text: '▾' }));
  face.setAttribute('aria-haspopup', 'listbox');
  face.setAttribute('aria-expanded', 'false');
  wrap.appendChild(face);

  let pop: any = null;
  let active = 0;
  let shown: Choice[] = [];
  const outside = (e: any) => { if (pop && !wrap.contains(e.target)) close(); };
  const close = () => {
    if (!pop) return;
    pop.remove(); pop = null;
    face.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', outside, true);
  };
  const pick = (c: Choice) => { value = c.value; face.children[0].textContent = c.label; close(); onPick(c.value); };

  const open = () => {
    if (pop) { close(); return; }
    const search = el('input', { type: 'search', class: 'ss-search', placeholder: opts.placeholder || 'Search…' }) as HTMLInputElement;
    search.setAttribute('aria-label', opts.placeholder || 'Search');
    const list = el('div', { class: 'ss-list', role: 'listbox' });
    const draw = () => {
      const words = search.value.toLowerCase().split(/\s+/).filter(Boolean);
      shown = choices.filter(c => words.every(w => `${c.label} ${c.hint || ''} ${c.value} ${c.group || ''}`.toLowerCase().includes(w)));
      active = Math.max(0, Math.min(active, shown.length - 1));
      list.innerHTML = '';
      let group: string | undefined;
      shown.forEach((c, i) => {
        if (c.group && c.group !== group) { group = c.group; list.appendChild(el('div', { class: 'ss-group', text: c.group })); }
        const b = el('button', { class: 'ss-opt' + (c.value === value ? ' is-current' : '') + (i === active ? ' is-active' : ''), type: 'button' },
          el('span', { class: 'ss-label', text: c.label }), ...(c.hint ? [el('span', { class: 'ss-hint', text: c.hint })] : []));
        b.setAttribute('role', 'option');
        b.setAttribute('aria-selected', String(c.value === value));
        b.onclick = () => pick(c);
        list.appendChild(b);
      });
      if (!shown.length) list.appendChild(el('div', { class: 'ss-none', text: 'Nothing matches.' }));
    };
    search.oninput = () => { active = 0; draw(); };
    search.onkeydown = (e: any) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); active = Math.min(shown.length - 1, active + 1); draw(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(0, active - 1); draw(); }
      else if (e.key === 'Enter') { e.preventDefault(); if (shown[active]) pick(shown[active]); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation?.(); close(); face.focus?.(); }
    };
    active = Math.max(0, choices.findIndex(c => c.value === value));
    pop = el('div', { class: 'ss-pop' }, search, list);
    wrap.appendChild(pop);
    face.setAttribute('aria-expanded', 'true');
    draw();
    document.addEventListener('pointerdown', outside, true);
    setTimeout(() => search.focus?.(), 0);
  };
  face.onclick = () => open();
  return wrap;
}
