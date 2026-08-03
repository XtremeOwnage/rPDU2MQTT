// Section-level connection tests + Home Assistant discovery actions (wired from sectionActions()).
import { api, toast } from './helpers.js';
import { state } from './state.js';
import { refreshStatus } from './main.js';

// Test every configured Modbus TCP connection by opening a throwaway connection to each.
export async function testModbus() {
  const conns = (state.data?.Modbus?.Connections) || [];
  if (!conns.length) { toast('No Modbus connections configured — add one first.', false); return; }
  toast(`Testing ${conns.length} Modbus connection(s)…`, true);
  for (const c of conns) {
    if (!c.Host) { toast(`${c.Name || c.Id || 'connection'}: no host set.`, false); continue; }
    const r = await api('/api/modbus/probe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ Host: c.Host, Port: c.Port, UnitId: c.UnitId }) });
    toast(`${c.Name || c.Id}: ${r.body.message || (r.body.ok ? 'OK' : 'failed')}`, r.body.ok);
  }
}

export async function testMqtt() { const r = await api('/api/test/mqtt', { method: 'POST' }); toast(r.body.message, r.body.ok); refreshStatus(); }
export async function testPdu() { toast('Testing PDU…', true); const r = await api('/api/test/pdu', { method: 'POST' }); toast(r.body.message, r.body.ok); }
export async function testEmonCms() { toast('Testing EmonCMS…', true); const r = await api('/api/test/emoncms', { method: 'POST' }); toast(r.body.message, r.body.ok); refreshStatus(); }
export async function provisionEmonCmsFeeds() { toast('Provisioning EmonCMS feeds…', true); const r = await api('/api/emoncms/provision-feeds', { method: 'POST' }); toast(r.body.message, r.body.ok); }
export async function deleteEmonCmsFeeds() {
  if (!confirm('⚠️ DELETE ALL EmonCMS feeds created by rPDU2MQTT?\n\n'
    + 'This PERMANENTLY deletes every feed under rPDU2MQTT’s tag/node — and ALL of their stored history in EmonCMS.\n\n'
    + 'It CANNOT be undone. Any EmonCMS dashboards, graphs, apps or virtual feeds that use these feeds will break.\n\n'
    + 'Only continue if you intend to wipe and rebuild them.')) return;
  if (!confirm('Are you absolutely sure?\n\nThis is your last chance to cancel before every rPDU2MQTT feed and its data are destroyed.')) return;
  const typed = prompt('Final confirmation — type  DELETE  (all caps) to permanently delete all rPDU2MQTT feeds:');
  if (typed !== 'DELETE') { toast('Cancelled — nothing was deleted.', false); return; }
  toast('Deleting EmonCMS feeds…', true);
  const r = await api('/api/emoncms/delete-feeds', { method: 'POST' });
  toast(r.body.message, r.body.ok);
}
export async function rediscoverHa() { toast('Requesting discovery…', true); const r = await api('/api/discovery/rediscover', { method: 'POST' }); toast(r.body.message, r.body.ok); }
// Devices Home Assistant still lists for things that no longer exist anywhere — the ones no MQTT retraction
// can reach, because their discovery config is already gone. Removed through Home Assistant's own API.
// Lists them before doing anything: this deletes registry entries and nothing here can put them back.
export async function deleteStaleHaDevices() {
  const found = await api('/api/ha/devices/stale');
  if (!found.body?.ok) { toast('Could not ask Home Assistant: ' + (found.body?.message || 'unknown error'), false); return; }

  const devices = found.body.devices || [];
  if (!devices.length) { toast('Nothing stale — every device of ours in Home Assistant still has entities.', true); return; }

  const names = devices.slice(0, 25).map((d: any) => '  • ' + (d.name || '(unnamed)')).join('\n');
  const more = devices.length > 25 ? `\n  …and ${devices.length - 25} more` : '';
  if (!confirm(`Delete ${devices.length} stale device(s) from Home Assistant?\n\n${names}${more}\n\n`
    + 'These have no entities left. Anything still live is never listed, and will be re-created by discovery.')) return;

  const r = await api('/api/ha/devices/stale/delete', { method: 'POST' });
  toast(r.body?.ok ? `Deleted ${r.body.deleted} stale device(s) from Home Assistant.`
                   : 'Could not delete: ' + (r.body?.message || 'unknown error'), !!r.body?.ok);
}

// Retained discovery configs for tiers this build would no longer publish. Distinct from "Clear discovery",
// which retracts everything: this removes only what is already stale, leaving live devices alone.
export async function clearOrphanedDiscovery() {
  const found = await api('/api/ha/orphans');
  if (!found.body?.ok) { toast('Could not check: ' + (found.body?.message || 'unknown error'), false); return; }

  const topics = found.body.topics || [];
  if (!topics.length) { toast('Nothing orphaned — every retained discovery config still matches something.', true); return; }

  if (!confirm(`Clear ${topics.length} orphaned discovery config(s)?\n\n` + topics.slice(0, 25).join('\n')
    + (topics.length > 25 ? `\n…and ${topics.length - 25} more` : ''))) return;

  const r = await api('/api/ha/orphans/clear', { method: 'POST' });
  toast(r.body?.ok ? `Cleared ${r.body.cleared} orphaned config(s).`
                   : 'Could not clear: ' + (r.body?.message || 'unknown error'), !!r.body?.ok);
}

export async function clearHa() {
  if (!confirm('Clear ALL Home Assistant discovery messages published by rPDU2MQTT — including any left over '
    + 'from earlier versions or configurations? Every entity disappears from Home Assistant until discovery '
    + 'runs again. Nothing belonging to another integration is touched.')) return;
  const r = await api('/api/discovery/clear', { method: 'POST' });
  toast(r.body.message, r.body.ok);
}
