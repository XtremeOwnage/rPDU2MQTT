// The little menu a right-click opens, positioned inside the box it was aimed at. The floor plan and the
// flow diagram both use it; each keeps its own class so its own styling still applies.
import { el } from './helpers.js';

export type MenuEntry = { label: string; run?: () => void; danger?: boolean; disabled?: boolean; head?: boolean };

/// A menu element to append to `host` (which must be positioned), and the two calls that work it. The host
/// may be given as a function, for a box built after the menu it holds.
export function makeMenu(host: any, cls = 'ctx-menu', onClose?: () => void) {
  const menu = el('div', { class: cls });
  menu.hidden = true;
  const close = () => { if (!menu.hidden) { menu.hidden = true; menu.innerHTML = ''; onClose?.(); } };
  // Escape is how a menu is dismissed everywhere else, so it is how this one is dismissed too, and a click
  // anywhere but inside it is the other way out — including on the page around the box it was opened over.
  document.addEventListener('keydown', (e: any) => { if (e.key === 'Escape' && !menu.hidden) close(); });
  document.addEventListener('mousedown', (e: any) => {
    if (!menu.hidden && !(menu.contains?.(e?.target) ?? false)) close();
  });
  const open = (e: any, entries: (MenuEntry | null | false | undefined)[]) => {
    menu.innerHTML = '';
    const rows = entries.filter(Boolean) as MenuEntry[];
    rows.forEach(x => {
      if (x.head) { menu.appendChild(el('div', { class: `${cls}-head`, text: x.label })); return; }
      const b = el('button', { class: `${cls}-item` + (x.danger ? ' is-danger' : ''), type: 'button', text: x.label });
      b.disabled = !!x.disabled;
      b.onclick = () => { close(); x.run?.(); };
      menu.appendChild(b);
    });
    // Kept inside the box: a menu opened near an edge would otherwise hang off it.
    const box = typeof host === 'function' ? host() : host;
    const r = box?.getBoundingClientRect?.() || { left: 0, top: 0, width: 800, height: 600 };
    const x = Math.max(4, Math.min((e.clientX ?? 0) - r.left, r.width - 230));
    const y = Math.max(4, Math.min((e.clientY ?? 0) - r.top, Math.max(4, r.height - 40 - rows.length * 34)));
    menu.style.left = `${Math.round(x)}px`;
    menu.style.top = `${Math.round(y)}px`;
    menu.hidden = false;
  };
  return { el: menu, open, close, isOpen: () => !menu.hidden };
}
