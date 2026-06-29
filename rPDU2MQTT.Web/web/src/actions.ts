// Section-level connection tests + Home Assistant discovery actions (wired from sectionActions()).
import { api, toast } from './helpers.js';
import { refreshStatus } from './main.js';

export async function testMqtt() { const r = await api('/api/test/mqtt', { method: 'POST' }); toast(r.body.message, r.body.ok); refreshStatus(); }
export async function testPdu() { toast('Testing PDU…', true); const r = await api('/api/test/pdu', { method: 'POST' }); toast(r.body.message, r.body.ok); }
export async function testEmonCms() { toast('Testing EmonCMS…', true); const r = await api('/api/test/emoncms', { method: 'POST' }); toast(r.body.message, r.body.ok); refreshStatus(); }
export async function rediscoverHa() { toast('Requesting discovery…', true); const r = await api('/api/discovery/rediscover', { method: 'POST' }); toast(r.body.message, r.body.ok); }
export async function clearHa() {
  if (!confirm('Clear all Home Assistant discovery messages? The entities will disappear from Home Assistant until discovery runs again.')) return;
  const r = await api('/api/discovery/clear', { method: 'POST' });
  toast(r.body.message, r.body.ok);
}
