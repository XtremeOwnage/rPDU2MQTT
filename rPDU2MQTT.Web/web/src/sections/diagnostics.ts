// Status / diagnostics: component health, versions, uptime, restart, and (in Kubernetes) logs + events.
import { api, btn, activate, toast } from '../helpers.js';

export function addDiagnosticsSection(nav: any, sections: any) {
  const link = document.createElement('a'); link.textContent = 'Diagnostics'; nav.appendChild(link);
  const sec = document.createElement('div'); sec.className = 'section'; sections.appendChild(sec);
  const h = document.createElement('h2'); h.textContent = 'Diagnostics'; sec.appendChild(h);
  const d = document.createElement('div'); d.className = 'desc'; d.textContent = 'Runtime status and maintenance actions.'; sec.appendChild(d);

  const bar = document.createElement('div'); bar.className = 'sec-actions';
  const refresh = btn('Refresh');
  const restart = btn('Restart bridge', 'danger');
  bar.appendChild(refresh); bar.appendChild(restart); sec.appendChild(bar);

  const comp = document.createElement('div'); comp.style.margin = '6px 0 14px'; sec.appendChild(comp);
  const info = document.createElement('table'); info.className = 'ld'; sec.appendChild(info);
  const k8sWrap = document.createElement('div'); sec.appendChild(k8sWrap);

  // A "Components" panel: which roles this node runs, MQTT transport, and whether PDU data is flowing.
  const compLine = (dotClass: string, label: string) => {
    const ln = document.createElement('div'); ln.style.cssText = 'display:flex;align-items:center;gap:8px;margin:4px 0;font-size:13px;';
    const dot = document.createElement('span'); dot.className = 'dot' + (dotClass ? ' ' + dotClass : '');
    const t = document.createElement('span'); t.textContent = label;
    ln.appendChild(dot); ln.appendChild(t); return ln;
  };
  const renderComponents = (b: any) => {
    comp.innerHTML = '';
    const head = document.createElement('div'); head.textContent = 'Components'; head.style.cssText = 'font-weight:600;color:var(--accent);margin-bottom:6px;'; comp.appendChild(head);
    const roles = b.roles || [];
    comp.appendChild(compLine('good', 'Roles on this node: ' + (roles.length ? roles.join(', ') : 'all')));
    comp.appendChild(compLine(b.mqttConnected ? 'good' : 'bad', 'MQTT — ' + (b.mqttConnected ? 'connected' : 'disconnected') + ' (' + (b.mqttHost || '?') + ')'));
    const ds = b.dataSources || [];
    if (!ds.length) comp.appendChild(compLine('', 'PDU data — none yet' + (roles.length && !roles.includes('worker') ? ' (waiting on a worker)' : '')));
    else ds.forEach((s: any) => comp.appendChild(compLine(s.stale ? 'bad' : 'good', 'PDU data · ' + s.instance + ' — ' + (s.stale ? 'stale, ' : '') + 'updated ' + s.ageSeconds + 's ago')));
    // Other role processes seen on the bus (split deployments only).
    (b.processes || []).forEach((p: any) => comp.appendChild(compLine(p.stale ? 'bad' : 'good', 'Process · ' + ((p.roles || []).join('+') || '?') + ' @ ' + (p.host || '?') + ' — ' + (p.stale ? 'last seen ' : 'alive, ') + p.ageSeconds + 's ago')));
  };

  const fmtUptime = (s: number) => { s = Math.floor(s); const d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60); return (d ? d + 'd ' : '') + (h ? h + 'h ' : '') + m + 'm'; };
  const row = (k: string, v: any) => { const tr = document.createElement('tr'); const a = document.createElement('td'); a.textContent = k; a.style.color = 'var(--muted)'; a.style.width = '220px'; const b = document.createElement('td'); b.textContent = (v == null || v === '') ? '—' : v; tr.appendChild(a); tr.appendChild(b); return tr; };

  const load = async () => {
    const r = await api('/api/diagnostics'); const b = r.body;
    renderComponents(b);
    info.innerHTML = '';
    info.appendChild(row('App version', b.version));
    if (b.image) info.appendChild(row('Container image', b.image));
    info.appendChild(row('Uptime', b.uptimeSeconds != null ? fmtUptime(b.uptimeSeconds) : null));
    info.appendChild(row('Started (UTC)', b.startedUtc));
    info.appendChild(row('MQTT', (b.mqttConnected ? 'connected' : 'disconnected') + ' — ' + b.mqttHost));
    info.appendChild(row('Last PDU poll (UTC)', b.lastPollUtc));
    if (b.emoncms && b.emoncms.enabled) {
      const s = b.emoncms.status || {};
      let txt;
      if (s.ok === true) txt = 'ok (' + b.emoncms.transport + ') — last sent ' + (s.lastSuccessUtc || '?') + (s.count ? ', ' + s.count + ' inputs' : '');
      else if (s.ok === false) txt = 'error (' + b.emoncms.transport + ') — ' + (s.lastError || 'unknown');
      else txt = 'enabled (' + b.emoncms.transport + ') — no export yet';
      info.appendChild(row('EmonCMS', txt));
    }
    info.appendChild(row('Config source', b.configSource));
    info.appendChild(row('.NET', b.dotnet));
    info.appendChild(row('OS', b.os));
    info.appendChild(row('Kubernetes', b.kubernetes ? (b.ns + ' / ' + (b.pod || '?')) : 'no'));
    k8sWrap.innerHTML = '';
    if (b.kubernetes) buildK8sTools(k8sWrap);
  };
  refresh.onclick = load;
  restart.onclick = async () => {
    if (!confirm('Restart the bridge? It will disconnect briefly while the container restarts.')) return;
    const r = await api('/api/restart', { method: 'POST' });
    toast(r.body.message || 'Restarting…', r.ok && r.body.ok);
  };
  link.onclick = () => { activate(link, sec); load(); };
}

// Kubernetes-only: on-demand pod logs + recent events.
function buildK8sTools(container: any) {
  const tools = document.createElement('div'); tools.className = 'sec-actions';
  const logsBtn = btn('Load logs');
  const evBtn = btn('Load events');
  tools.appendChild(logsBtn); tools.appendChild(evBtn); container.appendChild(tools);
  const out = document.createElement('div'); container.appendChild(out);

  logsBtn.onclick = async () => {
    out.innerHTML = '<div class="desc">Loading logs…</div>';
    const r = await api('/api/diagnostics/logs');
    if (!r.body.ok) { out.innerHTML = '<div class="desc" style="color:var(--bad)">' + (r.body.message || 'Failed.') + '</div>'; return; }
    const ta = document.createElement('textarea'); ta.className = 'yaml'; ta.readOnly = true; ta.value = r.body.logs || '(empty)';
    out.innerHTML = ''; out.appendChild(ta);
  };
  evBtn.onclick = async () => {
    out.innerHTML = '<div class="desc">Loading events…</div>';
    const r = await api('/api/diagnostics/events');
    if (!r.body.ok) { out.innerHTML = '<div class="desc" style="color:var(--bad)">' + (r.body.message || 'Failed.') + '</div>'; return; }
    const t = document.createElement('table'); t.className = 'ld';
    const head = document.createElement('tr'); ['Time', 'Type', 'Reason', 'Message', 'Count'].forEach(x => { const th = document.createElement('th'); th.textContent = x; head.appendChild(th); });
    const thead = document.createElement('thead'); thead.appendChild(head); t.appendChild(thead);
    const tb = document.createElement('tbody');
    (r.body.events || []).forEach((e: any) => { const tr = document.createElement('tr'); [e.time, e.type, e.reason, e.message, e.count].forEach(c => { const td = document.createElement('td'); td.textContent = c == null ? '' : c; tr.appendChild(td); }); tb.appendChild(tr); });
    t.appendChild(tb); out.innerHTML = ''; out.appendChild(t);
    if (!(r.body.events || []).length) out.innerHTML = '<div class="desc">No recent events.</div>';
  };
}
