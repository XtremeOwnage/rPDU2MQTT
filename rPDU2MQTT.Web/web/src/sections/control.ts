// Direct outlet control (on/off/reboot) + group actions + label editing.
import { api, btn, activate, toast, instanceSelector, withInstance } from '../helpers.js';

export function addControlSection(nav: any, sections: any) {
  const link = document.createElement('a'); link.textContent = 'PDU Control'; nav.appendChild(link);
  const sec = document.createElement('div'); sec.className = 'section'; sections.appendChild(sec);
  const h = document.createElement('h2'); h.textContent = 'Outlet Control'; sec.appendChild(h);
  const d = document.createElement('div'); d.className = 'desc';
  d.textContent = 'Turn outlets on/off, reboot, reset stats, or rename them on the PDU. Requires write actions enabled (PDU.ActionsEnabled) and PDU credentials.';
  sec.appendChild(d);

  const bar = document.createElement('div'); bar.className = 'ld-toolbar';
  const refresh = btn('Refresh');
  const instSel = instanceSelector(() => load());
  const filter = document.createElement('input'); filter.type = 'text'; filter.placeholder = 'Filter (device / outlet)…';
  bar.appendChild(refresh); bar.appendChild(instSel.wrap); bar.appendChild(filter); sec.appendChild(bar);
  const warn = document.createElement('div'); warn.className = 'desc'; warn.style.color = 'var(--bad)'; warn.style.display = 'none';
  warn.textContent = 'Write actions are disabled (PDU.ActionsEnabled is false). Enable it in the PDU section and restart to control outlets.';
  sec.appendChild(warn);
  const groupsWrap = document.createElement('div'); sec.appendChild(groupsWrap);
  const devicesWrap = document.createElement('div'); sec.appendChild(devicesWrap);
  const tableWrap = document.createElement('div'); sec.appendChild(tableWrap);

  let rows: any[] = [], groups: any[] = [], devices: any[] = [], enabled = false;
  const actGroup = async (g: any, action: string) => {
    const verb = action === 'on' ? 'turn ON' : action === 'off' ? 'turn OFF' : 'reboot';
    if (!confirm('Group "' + (g.name || g.key) + '": ' + verb + ' ALL member outlets?')) return;
    toast('Group ' + (g.name || g.key) + ': ' + action + '…', true);
    const r = await api('/api/control/group', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ groupKey: g.key, action, instance: instSel.get() }) });
    toast(r.body.message || (r.ok ? 'Done.' : 'Failed.'), r.ok && r.body.ok);
    setTimeout(load, 1000);
  };
  const setGroupLabel = (g: any, value: string) => postLabel({ target: 'group', groupKey: g.key, label: (value || '').trim() }, 'Group ' + (g.name || g.key));
  const drawGroups = () => {
    groupsWrap.innerHTML = '';
    if (!groups.length) return;
    const hh = document.createElement('div'); hh.className = 'desc'; hh.style.marginTop = '4px'; hh.textContent = 'Groups — rename, see member states, and act on all member outlets:'; groupsWrap.appendChild(hh);
    const t = document.createElement('table'); t.className = 'ld';
    const head = document.createElement('tr');
    ['Group', 'Label (on PDU)', 'Members', 'Actions'].forEach(x => { const th = document.createElement('th'); th.textContent = x; head.appendChild(th); });
    const thead = document.createElement('thead'); thead.appendChild(head); t.appendChild(thead);
    const tb = document.createElement('tbody');
    groups.forEach(g => {
      const tr = document.createElement('tr');
      const nameTd = document.createElement('td'); nameTd.textContent = g.name || g.key; tr.appendChild(nameTd);
      // Editable group label (written to the PDU).
      const labTd = document.createElement('td');
      const lin = document.createElement('input'); lin.type = 'text'; lin.value = g.label || ''; lin.style.width = '140px'; lin.disabled = !enabled;
      const setBtn = btn('Set'); setBtn.disabled = !enabled; setBtn.style.marginLeft = '6px';
      setBtn.onclick = () => setGroupLabel(g, lin.value);
      labTd.appendChild(lin); labTd.appendChild(setBtn); tr.appendChild(labTd);
      // Aggregate member state: a dot per member outlet + an "n/m on" summary.
      const memTd = document.createElement('td');
      const members = g.members || [];
      const onCount = members.filter((m: any) => m.state === 'on').length;
      members.forEach((m: any) => {
        const dot = document.createElement('span');
        dot.className = 'dot ' + (m.state === 'on' ? 'good' : m.state === 'off' ? 'bad' : 'muted');
        dot.style.marginRight = '3px'; dot.title = (m.name || ('#' + m.number)) + ': ' + (m.state || '?');
        memTd.appendChild(dot);
      });
      if (members.length) { const c = document.createElement('span'); c.className = 'ld-count'; c.style.marginLeft = '4px'; c.textContent = onCount + '/' + members.length + ' on'; memTd.appendChild(c); }
      else { memTd.textContent = '—'; memTd.style.color = 'var(--muted)'; }
      tr.appendChild(memTd);
      const actTd = document.createElement('td');
      [['All On', 'on'], ['All Off', 'off'], ['Reboot All', 'reboot']].forEach(([lab, a]) => {
        const b = btn(lab, a !== 'on' ? 'danger' : ''); b.disabled = !enabled; b.style.marginRight = '6px'; b.onclick = () => actGroup(g, a); actTd.appendChild(b);
      });
      tr.appendChild(actTd); tb.appendChild(tr);
    });
    t.appendChild(tb); groupsWrap.appendChild(t);
  };
  const act = async (o: any, action: string) => {
    if (action === 'off' && !confirm('Turn OFF outlet ' + o.number + ' (' + o.name + ')?')) return;
    if (action === 'reboot' && !confirm('Reboot outlet ' + o.number + ' (' + o.name + ')? Connected equipment will lose power briefly.')) return;
    if (action === 'resetstats' && !confirm('Reset statistics for outlet ' + o.number + ' (' + o.name + ')?')) return;
    toast('Outlet ' + o.number + ': ' + action + '…', true);
    const r = await api('/api/control/outlet', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ deviceId: o.deviceId, index: o.index, action, instance: instSel.get() }) });
    toast(r.body.message || (r.ok ? 'Done.' : 'Failed.'), r.ok && r.body.ok);
    setTimeout(load, 800); // let the PDU apply, then re-read state
  };
  const postLabel = async (payload: any, desc: string) => {
    toast(desc + ': set label…', true);
    const r = await api('/api/control/label', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...payload, instance: instSel.get() }) });
    toast(r.body.message || (r.ok ? 'Done.' : 'Failed.'), r.ok && r.body.ok);
    setTimeout(load, 800);
  };
  const setLabel = (o: any, value: string) => postLabel({ deviceId: o.deviceId, target: 'outlet', index: o.index, label: (value || '').trim() }, 'Outlet ' + o.number);
  const drawDevices = () => {
    devicesWrap.innerHTML = '';
    if (!devices.length) return;
    const hh = document.createElement('div'); hh.className = 'desc'; hh.style.marginTop = '4px';
    hh.textContent = 'PDUs & circuits — labels are written to the PDU:'; devicesWrap.appendChild(hh);
    const t = document.createElement('table'); t.className = 'ld';
    const head = document.createElement('tr');
    ['Type', 'Name', 'Label (on PDU)'].forEach(x => { const th = document.createElement('th'); th.textContent = x; head.appendChild(th); });
    const thead = document.createElement('thead'); thead.appendChild(head); t.appendChild(thead);
    const tb = document.createElement('tbody');
    const labelRow = (kind: string, name: string, current: string, payload: any) => {
      const tr = document.createElement('tr');
      const td0 = document.createElement('td'); td0.textContent = kind; tr.appendChild(td0);
      const td1 = document.createElement('td'); td1.textContent = name || ''; tr.appendChild(td1);
      const td2 = document.createElement('td');
      const lin = document.createElement('input'); lin.type = 'text'; lin.value = current || ''; lin.style.width = '150px'; lin.disabled = !enabled;
      const setBtn = btn('Set'); setBtn.disabled = !enabled; setBtn.style.marginLeft = '6px';
      setBtn.onclick = () => postLabel(Object.assign({}, payload, { label: (lin.value || '').trim() }), kind + ' ' + (name || ''));
      td2.appendChild(lin); td2.appendChild(setBtn); tr.appendChild(td2);
      tb.appendChild(tr);
    };
    devices.forEach(d => {
      labelRow('PDU', d.name, d.label, { deviceId: d.deviceId, target: 'device' });
      (d.circuits || []).forEach((c: any) => labelRow('Circuit', c.name, c.label, { deviceId: d.deviceId, target: 'entity', entityKey: c.key }));
    });
    t.appendChild(tb); devicesWrap.appendChild(t);
  };
  const draw = () => {
    const f = filter.value.trim().toLowerCase();
    const shown = f ? rows.filter(r => (r.device + ' ' + r.name + ' ' + r.number).toLowerCase().includes(f)) : rows;
    const t = document.createElement('table'); t.className = 'ld';
    const head = document.createElement('tr');
    ['Device', 'Outlet', 'Label (on PDU)', 'State', 'Actions'].forEach(x => { const th = document.createElement('th'); th.textContent = x; head.appendChild(th); });
    const thead = document.createElement('thead'); thead.appendChild(head); t.appendChild(thead);
    const tb = document.createElement('tbody');
    shown.forEach(o => {
      const tr = document.createElement('tr');
      const tdDev = document.createElement('td'); tdDev.textContent = o.device; tr.appendChild(tdDev);
      const tdName = document.createElement('td');
      tdName.appendChild(document.createTextNode('#' + o.number + ' — ' + (o.name || '')));
      // Current write-action config, so changes made via HA are visible here.
      const cfg = document.createElement('div'); cfg.className = 'ld-count';
      cfg.textContent = 'delays: on ' + o.onDelay + 's / off ' + o.offDelay + 's / reboot ' + o.rebootDelay + 's · power-on: ' + (o.poaAction || '?');
      tdName.appendChild(cfg); tr.appendChild(tdName);
      // Editable PDU label.
      const tdLabel = document.createElement('td');
      const lin = document.createElement('input'); lin.type = 'text'; lin.value = o.label || ''; lin.style.width = '150px'; lin.disabled = !enabled;
      const setBtn = btn('Set'); setBtn.disabled = !enabled; setBtn.style.marginLeft = '6px';
      setBtn.onclick = () => setLabel(o, lin.value);
      tdLabel.appendChild(lin); tdLabel.appendChild(setBtn);
      // Reset only shows when a label is actually set; clears it back to the PDU default.
      if ((o.label || '').trim()) {
        const resetBtn = btn('Reset', 'danger'); resetBtn.disabled = !enabled; resetBtn.style.marginLeft = '4px';
        resetBtn.onclick = () => { if (confirm('Clear the label for outlet ' + o.number + '?')) setLabel(o, ''); };
        tdLabel.appendChild(resetBtn);
      }
      tr.appendChild(tdLabel);
      const tdState = document.createElement('td');
      const dot = document.createElement('span'); dot.className = 'dot ' + (o.state === 'on' ? 'good' : 'bad'); tdState.appendChild(dot);
      tdState.appendChild(document.createTextNode(o.state || '?')); tr.appendChild(tdState);
      const tdAct = document.createElement('td');
      [['On', 'on'], ['Off', 'off'], ['Reboot', 'reboot'], ['Reset Stats', 'resetstats']].forEach(([lab, a]) => {
        const b = btn(lab, a === 'off' ? 'danger' : ''); b.disabled = !enabled; b.style.marginRight = '6px'; b.onclick = () => act(o, a); tdAct.appendChild(b);
      });
      tr.appendChild(tdAct); tb.appendChild(tr);
    });
    t.appendChild(tb); tableWrap.innerHTML = ''; tableWrap.appendChild(t);
  };
  const load = async () => {
    const r = await api(withInstance('/api/control/outlets', instSel));
    if (!r.body.ok) { tableWrap.innerHTML = '<div class="desc" style="color:var(--bad)">' + (r.body.message || 'Could not load outlets.') + '</div>'; return; }
    rows = r.body.outlets || []; groups = r.body.groups || []; devices = r.body.devices || []; enabled = !!r.body.actionsEnabled;
    warn.style.display = enabled ? 'none' : 'block'; drawGroups(); drawDevices(); draw();
  };
  refresh.onclick = load; filter.oninput = draw;
  link.onclick = () => { activate(link, sec); load(); };
}
