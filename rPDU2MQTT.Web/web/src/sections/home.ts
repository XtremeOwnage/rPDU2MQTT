// Landing/status page (#186): a red / amber / green board for the bridge and everything it talks to.
import { api, btn, el, activate } from '../helpers.js';
import { state } from '../state.js';

export function addHomeSection(nav: any, sections: any) {
  const link = document.createElement('a'); link.textContent = 'Status'; nav.appendChild(link);
  const sec = document.createElement('div'); sec.className = 'section'; sections.appendChild(sec);
  sec.appendChild(el('h2', { text: 'Status' }));
  sec.appendChild(el('div', { class: 'desc', text: 'Health of the bridge and everything it talks to. Green = healthy, amber = degraded or waiting, red = broken, grey = not configured.' }));

  const bar = el('div', { class: 'sec-actions' });
  const refresh = btn('Refresh');
  bar.appendChild(refresh); sec.appendChild(bar);
  const grid = el('div', { class: 'status-grid' }); sec.appendChild(grid);

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

  const age = (s: number) => s < 90 ? s + 's ago' : Math.round(s / 60) + 'm ago';
  const uptime = (s: number) => { s = Math.floor(s || 0); const d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60); return (d ? d + 'd ' : '') + (h ? h + 'h ' : '') + m + 'm'; };

  const load = async () => {
    const r = await api('/api/diagnostics');
    const b: any = r.body || {};
    const cfg: any = state.data || {};
    grid.innerHTML = '';

    grid.appendChild(card(b.mqttConnected ? 'good' : 'bad', 'MQTT', b.mqttConnected ? 'Connected' : 'Disconnected', b.mqttHost));

    // One card per PDU: fresh data = green, stale = red, nothing yet = amber.
    const sources = b.dataSources || [];
    if (!sources.length) {
      const worker = (b.roles || []).includes('worker');
      grid.appendChild(card('warn', 'PDUs', 'No data yet', worker ? 'Waiting for the first poll' : 'Waiting on a worker node'));
    } else {
      sources.forEach((s: any) => grid.appendChild(card(s.stale ? 'bad' : 'good', 'PDU · ' + s.instance,
        s.stale ? 'Stale' : 'Polling', 'Updated ' + age(s.ageSeconds))));
    }

    const e: any = b.emoncms || {};
    if (!e.enabled) grid.appendChild(card('', 'EmonCMS', 'Disabled'));
    else {
      const st: any = e.status || {};
      const transport = e.transport ? e.transport.toUpperCase() : '';
      if (st.ok === false) grid.appendChild(card('bad', 'EmonCMS', 'Error', st.lastError || 'Last export failed'));
      else if (st.ok === true) grid.appendChild(card('good', 'EmonCMS', 'Exporting', transport + (st.count ? ' · ' + st.count + ' values' : '')));
      else grid.appendChild(card('warn', 'EmonCMS', 'Waiting', transport + ' · no export attempted yet'));
    }

    const ha: any = cfg.HomeAssistant || {};
    grid.appendChild(ha.DiscoveryEnabled
      ? card('good', 'Home Assistant', 'Discovery on', 'Topic: ' + (ha.DiscoveryTopic || '—'))
      : card('', 'Home Assistant', 'Discovery off'));

    const prom: any = cfg.Prometheus || {};
    grid.appendChild(prom.Exporter
      ? card('good', 'Prometheus', 'Exporter on', ':' + (prom.Port || 9184) + '/metrics')
      : card('', 'Prometheus', 'Exporter off'));

    // Other role processes on the bus (split deployments only).
    (b.processes || []).forEach((p: any) => grid.appendChild(card(p.stale ? 'bad' : 'good',
      'Process · ' + ((p.roles || []).join('+') || '?'), p.stale ? 'Stale' : 'Alive',
      (p.host || '') + ' · seen ' + age(p.ageSeconds))));

    grid.appendChild(card('good', 'This node', (b.roles || []).join(', ') || 'all',
      'v' + (b.version || '?') + ' · up ' + uptime(b.uptimeSeconds)));
  };

  refresh.onclick = () => load();
  // Refresh while the tab is on screen so the board stays live without polling in the background.
  setInterval(() => { if (sec.classList.contains('active')) load(); }, 10000);
  link.onclick = () => { activate(link, sec); load(); };
  return { link, load };
}
