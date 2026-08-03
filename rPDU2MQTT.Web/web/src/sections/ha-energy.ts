// Home Assistant Energy Mapping (#128): the EnergyDashboard settings + manual sync/clear actions.
import { api, btn, el, ensure, activate, toast, navLink } from '../helpers.js';
import { state } from '../state.js';

export function addHaEnergySection(nav: any, sections: any) {
  const link = navLink(nav, "HA Energy Mapping", "▮");
  const sec = document.createElement('div'); sec.className = 'section'; sections.appendChild(sec);
  const h = document.createElement('h2'); h.textContent = 'Home Assistant Energy Mapping'; sec.appendChild(h);
  const d = document.createElement('div'); d.className = 'desc';
  d.textContent = 'Map the energy-flow hierarchy into Home Assistant’s Energy Dashboard (individual devices + their upstream device). Each tier is published to HA as an Energy sensor by the flow export, so enable “Export tiers to MQTT” (Flow tab) and HA discovery for the full Grid → Panel → Circuit → PDU → outlet chain to appear. Settings persist with the main Save button; the buttons act immediately using the values below.';
  sec.appendChild(d);

  const ha = ensure(ensure(state.data, 'HomeAssistant', {}), 'EnergyDashboard', {});

  const field = (label: string, key: string, type = 'text', placeholder = '') => {
    const f = el('div', { class: 'field' });
    f.appendChild(el('label', { text: label }));
    const inp: any = el('input', { type, placeholder });
    if (ha[key] != null) inp.value = ha[key];
    inp.onchange = () => { ha[key] = inp.value === '' ? null : inp.value; };
    f.appendChild(inp);
    return { f, inp };
  };
  const url = field('Home Assistant URL', 'Url', 'text', 'http://homeassistant.local:8123');
  const token = field('Long-lived access token', 'Token', 'password', '');
  const etype = field('Energy measurement type', 'EnergyMeasurementType', 'text', 'energy');

  const chkF = el('div', { class: 'field' });
  const chk: any = el('input', { type: 'checkbox' }); chk.checked = !!ha.Enabled;
  chk.onchange = () => { ha.Enabled = chk.checked; };
  chkF.appendChild(el('label', { style: { fontWeight: '600' } }, chk, ' Enable periodic sync'));
  chkF.appendChild(el('div', { class: 'desc', text: 'Re-push the hierarchy automatically every few polls while enabled.' }));

  const grid = el('div', { class: 'grid' });
  grid.append(url.f, token.f, etype.f, chkF);
  sec.appendChild(grid);

  const bar = el('div', { class: 'sec-actions' });
  const syncBtn = btn('Sync now', 'primary');
  const clearBtn = btn('Clear energy dashboard', 'danger');
  bar.append(syncBtn, clearBtn); sec.appendChild(bar);
  sec.appendChild(el('div', { class: 'desc', text: 'Also Save (main button) so the periodic sync uses these settings.' }));

  syncBtn.onclick = async () => {
    toast('Syncing to Home Assistant…', true);
    const r = await api('/api/ha-energy/sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: url.inp.value.trim(), token: token.inp.value, energyMeasurementType: etype.inp.value.trim() }) });
    toast(r.body.message || (r.ok ? 'Done.' : 'Failed.'), r.ok && r.body.ok);
  };
  clearBtn.onclick = async () => {
    if (!confirm('Clear ALL devices from Home Assistant’s Energy Dashboard?\n\nThis removes every entry in the dashboard’s device list — including any you added manually. You can re-add the hierarchy with “Sync now”.')) return;
    toast('Clearing the Energy Dashboard…', true);
    const r = await api('/api/ha-energy/clear', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: url.inp.value.trim(), token: token.inp.value }) });
    toast(r.body.message || (r.ok ? 'Done.' : 'Failed.'), r.ok && r.body.ok);
  };
  // Orphaned discovery configs — devices Home Assistant still shows for things that no longer exist.
  //
  // A discovery config is retained, so it outlives what it described: an outlet that later gained a native
  // energy sensor, a tier deleted from the hierarchy, a node renamed. The publish loop can never find them
  // again because it only walks the nodes that exist now. Two steps on purpose — deleting devices from
  // someone's Home Assistant is not something to do quietly, so it lists them and waits.
  sec.appendChild(el('h3', { text: 'Orphaned Home Assistant devices', style: { margin: '18px 0 4px' } }));
  sec.appendChild(el('div', { class: 'desc' },
    'Discovery messages are retained, so a device stays in Home Assistant after the thing it described is '
    + 'gone — an outlet that gained its own energy sensor, a renamed node, a deleted tier. This finds configs '
    + 'published under this project’s own prefix that the current setup would no longer publish. Nothing '
    + 'belonging to another integration is ever listed or touched.'));

  const orphanOut = el('div', { class: 'desc' }) as HTMLElement;
  const orphanFind = btn('Find orphaned devices');
  const orphanClear = btn('Clear them', 'danger');
  orphanClear.disabled = true;
  const orphanBar = el('div', { class: 'sec-actions' }, orphanFind, orphanClear);
  sec.appendChild(orphanBar);
  sec.appendChild(orphanOut);

  const showOrphans = (topics: string[]) => {
    orphanOut.innerHTML = '';
    if (!topics.length) {
      orphanOut.textContent = 'Nothing orphaned — every retained discovery config matches something that still exists.';
      orphanClear.disabled = true;
      return;
    }
    orphanOut.appendChild(el('div', { text: `${topics.length} orphaned config(s) would be cleared:` }));
    const list = el('ul', { style: { margin: '4px 0 0 18px' } });
    topics.forEach(t => list.appendChild(el('li', { text: t, style: { fontFamily: 'var(--mono)', fontSize: '11px' } })));
    orphanOut.appendChild(list);
    orphanClear.disabled = false;
  };

  orphanFind.onclick = async () => {
    orphanOut.textContent = 'Looking…';
    const r = await api('/api/ha/orphans');
    if (!r.body?.ok) { orphanOut.textContent = 'Could not check: ' + (r.body?.message || 'unknown error'); return; }
    showOrphans(r.body.topics || []);
  };

  orphanClear.onclick = async () => {
    orphanClear.disabled = true;
    const r = await api('/api/ha/orphans/clear', 'POST');
    if (!r.body?.ok) { toast('Could not clear: ' + (r.body?.message || 'unknown error'), false); return; }
    toast(`Cleared ${r.body.cleared} orphaned device(s). Home Assistant removes them on the next discovery pass.`, true);
    showOrphans([]);
  };

  // Devices Home Assistant still lists for things that no longer exist anywhere.
  //
  // Distinct from the orphaned-config cleanup above, and not solvable the same way: these have no discovery
  // config left to retract, so nothing published over MQTT can reach them. Home Assistant has to be asked
  // directly. Needs the URL and token configured above.
  sec.appendChild(el('h3', { text: 'Stale Home Assistant device registrations', style: { margin: '18px 0 4px' } }));
  sec.appendChild(el('div', { class: 'desc' },
    'Home Assistant keeps a device even after its discovery message is gone, so devices from earlier versions '
    + '— an outlet named under an older scheme, a tier since removed — linger in the UI forever with no way to '
    + 'clear them over MQTT. This lists ones belonging to this project that have no entities left at all, and '
    + 'deletes them through Home Assistant’s own API. A device that still has entities is live and is never '
    + 'listed; nothing from another integration is either.'));

  const devOut = el('div', { class: 'desc' }) as HTMLElement;
  const devFind = btn('Find stale devices');
  const devDelete = btn('Delete them', 'danger');
  devDelete.disabled = true;
  sec.appendChild(el('div', { class: 'sec-actions' }, devFind, devDelete));
  sec.appendChild(devOut);

  const showDevices = (devices: any[]) => {
    devOut.innerHTML = '';
    if (!devices.length) {
      devOut.textContent = 'Nothing stale — every device of ours in Home Assistant still has entities.';
      devDelete.disabled = true;
      return;
    }
    devOut.appendChild(el('div', { text: `${devices.length} stale device(s) would be deleted from Home Assistant:` }));
    const list = el('ul', { style: { margin: '4px 0 0 18px' } });
    devices.forEach((d: any) => list.appendChild(el('li', {},
      el('span', { text: d.name || '(unnamed)' }),
      el('span', { style: { color: 'var(--faint)', fontFamily: 'var(--mono)', fontSize: '11px' }, text: '  ' + (d.identifiers || []).join(', ') }))));
    devOut.appendChild(list);
    devDelete.disabled = false;
  };

  devFind.onclick = async () => {
    devOut.textContent = 'Asking Home Assistant…';
    const r = await api('/api/ha/devices/stale');
    if (!r.body?.ok) { devOut.textContent = 'Could not check: ' + (r.body?.message || 'unknown error'); return; }
    showDevices(r.body.devices || []);
  };

  devDelete.onclick = async () => {
    if (!confirm('Delete these devices from Home Assistant? They have no entities, and anything still live will be re-created by discovery.')) return;
    devDelete.disabled = true;
    devOut.textContent = 'Deleting…';
    const r = await api('/api/ha/devices/stale/delete', 'POST');
    if (!r.body?.ok) { toast('Could not delete: ' + (r.body?.message || 'unknown error'), false); devOut.textContent = ''; return; }
    toast(`Deleted ${r.body.deleted} stale device(s) from Home Assistant.`, true);
    showDevices([]);
  };

  link.onclick = () => activate(link, sec);
}
