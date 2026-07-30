// Ctrl+K page switcher.
//
// The nav has grown to five groups and twenty-odd pages, several of them collapsed; finding "HA Energy
// Mapping" meant remembering which group it hides under. This types straight to it. It reads the nav
// rather than keeping its own list, so a new page is reachable the moment it's rendered.

import { el, openSheet, closeSheet, sheetIsOpen } from './helpers.js';

function paletteItems() {
  const out: any[] = [];
  document.querySelectorAll('.nav-group-wrap').forEach((wrap: any) => {
    const group = wrap.querySelector('.nav-group')?.textContent || '';
    wrap.querySelectorAll('a').forEach((a: any) => out.push({ label: a.dataset?.label || a.textContent, group, link: a }));
  });
  // Pages outside any group (the Status landing page).
  const nav: any = document.getElementById('nav');
  nav?.querySelectorAll('a').forEach((a: any) => {
    if (!out.some(i => i.link === a)) out.unshift({ label: a.dataset?.label || a.textContent, group: '', link: a });
  });
  return out;
}

export function openPalette() {
  const items = paletteItems();
  const input: any = el('input', { class: 'sheet-search', type: 'text', placeholder: 'Jump to a page…' });
  const list: any = el('div');
  let shown: any[] = items;
  let sel = 0;

  const choose = (i: any) => { closeSheet(); i?.link?.click(); };

  const render = () => {
    const q = (input.value || '').trim().toLowerCase();
    shown = q ? items.filter(i => (i.label + ' ' + i.group).toLowerCase().includes(q)) : items;
    if (sel >= shown.length) sel = Math.max(0, shown.length - 1);
    list.innerHTML = '';
    if (!shown.length) { list.appendChild(el('div', { class: 'cmd-empty', text: 'No page matches “' + input.value + '”.' })); return; }
    shown.forEach((i, idx) => {
      const row = el('div', { class: 'cmd-item', role: 'option', onclick: () => choose(i) },
        el('span', { text: i.label }),
        i.group ? el('span', { class: 'cmd-group', text: i.group }) : null);
      row.setAttribute('aria-selected', String(idx === sel));
      // Hovering moves the highlight, so mouse and keyboard don't disagree about what Enter does.
      row.onmouseenter = () => { sel = idx; paint(); };
      list.appendChild(row);
    });
  };
  const paint = () => [...list.children].forEach((c: any, idx: number) => c.setAttribute?.('aria-selected', String(idx === sel)));

  input.oninput = () => { sel = 0; render(); };
  input.onkeydown = (e: any) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(sel + 1, shown.length - 1); paint(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(sel - 1, 0); paint(); }
    else if (e.key === 'Enter') { e.preventDefault(); choose(shown[sel]); }
    else if (e.key === 'Escape') { e.preventDefault(); closeSheet(); }
  };

  render();
  openSheet({ search: input, body: list });
  input.focus?.();
}

export function initPalette() {
  const opener: any = document.getElementById('cmd-open');
  if (opener) opener.onclick = () => openPalette();
  window.addEventListener('keydown', (e: any) => {
    if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) { e.preventDefault(); sheetIsOpen() ? closeSheet() : openPalette(); }
  });
}
