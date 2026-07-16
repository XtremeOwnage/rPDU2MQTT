// Section-level connection tests + Home Assistant discovery actions (wired from sectionActions()).
import { api, toast } from './helpers.js';
import { refreshStatus } from './main.js';

export async function testMqtt() { const r = await api('/api/test/mqtt', { method: 'POST' }); toast(r.body.message, r.body.ok); refreshStatus(); }
export async function testPdu() { toast('Testing PDU…', true); const r = await api('/api/test/pdu', { method: 'POST' }); toast(r.body.message, r.body.ok); }
export async function testEmonCms() { toast('Testing EmonCMS…', true); const r = await api('/api/test/emoncms', { method: 'POST' }); toast(r.body.message, r.body.ok); refreshStatus(); }
export async function provisionEmonCmsFeeds() { toast('Provisioning EmonCMS feeds…', true); const r = await api('/api/emoncms/provision-feeds', { method: 'POST' }); toast(r.body.message, r.body.ok); }
export async function deleteEmonCmsFeeds() {
  if (!confirm('Delete ALL EmonCMS feeds created by rPDU2MQTT (under its tag/node)?\n\nThis removes the feeds and their stored data in EmonCMS. It cannot be undone.')) return;
  toast('Deleting EmonCMS feeds…', true);
  const r = await api('/api/emoncms/delete-feeds', { method: 'POST' });
  toast(r.body.message, r.body.ok);
}
export async function rediscoverHa() { toast('Requesting discovery…', true); const r = await api('/api/discovery/rediscover', { method: 'POST' }); toast(r.body.message, r.body.ok); }
export async function clearHa() {
  if (!confirm('Clear all Home Assistant discovery messages? The entities will disappear from Home Assistant until discovery runs again.')) return;
  const r = await api('/api/discovery/clear', { method: 'POST' });
  toast(r.body.message, r.body.ok);
}
