// Landing/status page (#186): a red / amber / green board for the bridge and everything it talks to.
// v3: the verdicts come from the component grains via /api/status — this file only renders them. Deciding
// what "stale" or "waiting" means lives with the component that knows, not in the browser.
import { api, btn, el, activate, navLink } from '../helpers.js';
import { liveWhileActive, realtimeLive } from '../realtime.js';

export function addHomeSection(nav: any, sections: any) {
  const link = navLink(nav, "Status", "◈");
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

  // What each card said last time, so a card whose verdict actually moved can be flashed. Without it a
  // pushed update is indistinguishable from no update at all.
  const lastState = new Map<string, string>();

  const render = (body: any) => {
    const cards = (body && body.cards) || [];
    grid.innerHTML = '';

    if (!cards.length) {
      grid.appendChild(card('warn', 'Status', 'Waiting', 'No component has reported yet'));
      lastState.clear();
      return;
    }
    cards.forEach((c: any) => {
      const node = card(dotClass[c.level] ?? '', c.title, c.state, detailOf(c));
      const sig = c.level + '/' + c.state;
      if (lastState.has(c.id) && lastState.get(c.id) !== sig) node.classList.add('flash');
      lastState.set(c.id, sig);
      grid.appendChild(node);
    });
  };

  const load = async () => render((await api('/api/status/board')).body);

  refresh.onclick = () => load();
  // The board is pushed from the server (#281) while this tab is on screen. The timer stays as the
  // fallback for when the stream isn't up — it does nothing while it is.
  liveWhileActive(sec, () => 'board', render);
  setInterval(() => { if (sec.classList.contains('active') && !realtimeLive()) load(); }, 10000);
  link.onclick = () => { activate(link, sec); load(); };
  return { link, load };
}
