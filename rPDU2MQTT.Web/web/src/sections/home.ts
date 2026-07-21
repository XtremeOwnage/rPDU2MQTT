// Landing/status page (#186): a red / amber / green board for the bridge and everything it talks to.
// v3: the verdicts come from the component grains via /api/status — this file only renders them. Deciding
// what "stale" or "waiting" means lives with the component that knows, not in the browser.
import { api, btn, el, activate } from '../helpers.js';

export function addHomeSection(nav: any, sections: any) {
  const link = document.createElement('a'); link.textContent = 'Status'; nav.appendChild(link);
  const sec = document.createElement('div'); sec.className = 'section'; sections.appendChild(sec);
  sec.appendChild(el('h2', { text: 'Status' }));
  sec.appendChild(el('div', { class: 'desc', text: 'Every hop your energy data takes — the meters it comes from, the broker it moves over, and the stores it lands in. Green = healthy, amber = degraded or waiting, red = broken, grey = not configured.' }));

  const bar = el('div', { class: 'sec-actions' });
  const refresh = btn('Refresh');
  bar.appendChild(refresh); sec.appendChild(bar);
  const grid = el('div', { class: 'status-grid' }); sec.appendChild(grid);

  // The dot/badge class per level; 'off' has no class (grey is the default).
  const dotClass: any = { good: 'good', warn: 'warn', bad: 'bad', off: '' };

  const card = (cls: string, title: string, stateText: string, detail?: string | null) => {
    const c = el('div', { class: 'status-card' });
    const head = el('div', { class: 'status-head' });
    head.appendChild(el('span', { class: 'dot' + (cls ? ' ' + cls : '') }));
    head.appendChild(el('b', { text: title }));
    head.appendChild(el('span', { class: 'status-state' + (cls ? ' ' + cls : ''), text: stateText }));
    c.appendChild(head);
    c.appendChild(el('div', { class: 'desc', text: detail || '' }));
    return c;
  };

  const ago = (s: number) => s < 90 ? s + 's ago' : Math.round(s / 60) + 'm ago';
  const uptime = (s: number) => { s = Math.floor(s || 0); const d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60); return 'up ' + (d ? d + 'd ' : '') + (h ? h + 'h ' : '') + m + 'm'; };

  // A card's detail is the static part plus, where the grain asked for it, the aged instant it carries.
  const detailOf = (c: any) => {
    const parts: string[] = [];
    if (c.detail) parts.push(c.detail);
    if (c.eventUtc && c.age && c.age !== 'none') {
      const secs = Math.max(0, (Date.now() - new Date(c.eventUtc).getTime()) / 1000);
      parts.push(c.age === 'uptime' ? uptime(secs) : ago(Math.round(secs)));
    }
    return parts.join(' ');
  };

  const load = async () => {
    const r = await api('/api/status/board');
    const cards = (r.body && r.body.cards) || [];
    grid.innerHTML = '';

    if (!cards.length) {
      grid.appendChild(card('warn', 'Status', 'Waiting', 'No component has reported yet'));
      return;
    }
    cards.forEach((c: any) => grid.appendChild(card(dotClass[c.level] ?? '', c.title, c.state, detailOf(c))));
  };

  refresh.onclick = () => load();
  // Refresh while the tab is on screen so the board stays live without polling in the background.
  setInterval(() => { if (sec.classList.contains('active')) load(); }, 10000);
  link.onclick = () => { activate(link, sec); load(); };
  return { link, load };
}
