/// Navigation on a phone: a tab bar along the bottom for the pages read most, and a drawer that opens on the
/// group holding the page being read rather than on forty links.
import { el } from './helpers.js';

const NARROW = '(max-width: 860px)';
const TABS: [string, string][] = [['Overview', '⌂'], ['Live Data', '∿'], ['Flow', '⇄'], ['Energy', '⚡']];

const narrow = () => { try { return !!window.matchMedia?.(NARROW).matches; } catch { return false; } };
const link = (label: string): any => document.querySelector(`#nav a[data-label="${label}"]`);

/// Opens the drawer with only the active page's group expanded; the others stay a tap away.
export function openNav() {
  if (narrow()) {
    const active = document.querySelector('#nav a.active');
    document.querySelectorAll('#nav .nav-group-wrap').forEach((g: any) => g.classList.toggle('collapsed', !(active && g.contains(active))));
  }
  document.body.classList.add('nav-open');
  (document.querySelector('#nav a.active') as any)?.scrollIntoView?.({ block: 'center' });
}

export function initPhoneNav(toggle: () => void) {
  if (typeof document === 'undefined' || !document.body) return;
  const bar = el('div', { class: 'tabbar', role: 'navigation', 'aria-label': 'Main pages' });
  const tabs = TABS.map(([label, icon]) => {
    const b = el('button', { class: 'tab', type: 'button' }, el('span', { class: 'tab-icon', text: icon, 'aria-hidden': 'true' }), el('span', { class: 'tab-label', text: label }));
    b.onclick = () => { document.body.classList.remove('nav-open'); link(label)?.click(); };
    return { label, b };
  });
  const more = el('button', { class: 'tab', type: 'button' }, el('span', { class: 'tab-icon', text: '☰', 'aria-hidden': 'true' }), el('span', { class: 'tab-label', text: 'More' }));
  more.onclick = toggle;
  tabs.forEach(t => bar.appendChild(t.b));
  bar.appendChild(more);
  document.body.appendChild(bar);
  const sync = () => {
    const open = document.body.classList.contains('nav-open');
    let any = false;
    tabs.forEach(t => {
      const a = link(t.label);
      t.b.hidden = !a;
      const on = !open && !!a?.classList.contains('active');
      any = any || on;
      t.b.classList.toggle('is-active', on);
      t.b.setAttribute('aria-current', on ? 'page' : 'false');
    });
    // "More" is the tab lit for every page the bar does not name, and while the drawer is open.
    more.classList.toggle('is-active', open || (!any && !!document.querySelector('#nav a.active')));
  };
  window.addEventListener('rpdu:activate', sync);
  if (typeof MutationObserver !== 'undefined') new MutationObserver(sync).observe(document.body, { attributes: true, attributeFilter: ['class'] });
  sync();
}
