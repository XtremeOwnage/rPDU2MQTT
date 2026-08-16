// Section-level connection tests + Home Assistant discovery actions (wired from sectionActions()).
import { api, toast, el, btn } from './helpers.js';
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

/// Run a connection test and always end with a verdict.
///
/// Each of these used to end at `toast(r.body.message, r.body.ok)`. An answer carrying no message toasted
/// an empty toast, and a fetch that threw — the bridge restarting, a proxy dropping the request — never
/// reached the toast at all: the page kept the optimistic "Testing…" and nothing else, which reads as a
/// test that is still running rather than one that failed.
export type TestResult = { ok: boolean; message: string };

async function runTest(what: string, path: string): Promise<TestResult> {
  let out: TestResult;
  try {
    const r = await api(path, { method: 'POST' });
    out = {
      ok: !!(r.body && r.body.ok),
      message: (r.body && r.body.message)
        || (r.ok ? `${what}: the test answered without saying anything.` : `${what}: the bridge answered ${r.status}.`),
    };
  } catch (e: any) {
    out = { ok: false, message: `${what}: could not reach the bridge (${e?.message || e}).` };
  }
  toast(out.message, out.ok);
  return out;
}

export async function testMqtt() { const r = await runTest('MQTT', '/api/test/mqtt'); refreshStatus(); return r; }
export async function testPdu() { return runTest('PDU', '/api/test/pdu'); }
export async function testEmonCms() { const r = await runTest('EmonCMS', '/api/integrations/emoncms/probe'); refreshStatus(); return r; }
export async function testHistory() { const r = await runTest('History', '/api/test/history'); refreshStatus(); return r; }
export async function provisionEmonCmsFeeds() { await runIntegrationAction('emoncms', { name: 'publish', title: 'Provision EmonCMS feeds', description: '', effect: 'write' }); }
export async function deleteEmonCmsFeeds() {
  if (!confirm('⚠️ DELETE ALL EmonCMS feeds created by rPDU2MQTT?\n\n'
    + 'This PERMANENTLY deletes every feed under rPDU2MQTT’s tag/node — and ALL of their stored history in EmonCMS.\n\n'
    + 'It CANNOT be undone. Any EmonCMS dashboards, graphs, apps or virtual feeds that use these feeds will break.\n\n'
    + 'Only continue if you intend to wipe and rebuild them.')) return;
  if (!confirm('Are you absolutely sure?\n\nThis is your last chance to cancel before every rPDU2MQTT feed and its data are destroyed.')) return;
  const typed = prompt('Final confirmation — type  DELETE  (all caps) to permanently delete all rPDU2MQTT feeds:');
  if (typed !== 'DELETE') { toast('Cancelled — nothing was deleted.', false); return; }
  toast('Deleting EmonCMS feeds…', true);
  // Through the generic route: the integration owns the rule and the single-owner lease, so the button and
  // the API cannot do different things.
  const r = await api('/api/integrations/emoncms/sweep', { method: 'POST' });
  const inner = (r.body || {}).result || {};
  toast(inner.message ?? r.body?.message ?? 'Done.', r.body?.ok !== false);
}
export async function rediscoverHa() { toast('Requesting discovery…', true); const r = await api('/api/discovery/rediscover', { method: 'POST' }); toast(r.body.message, r.body.ok); }
export async function clearHa() {
  if (!confirm('Clear ALL Home Assistant discovery messages published by rPDU2MQTT — including any left over '
    + 'from earlier versions or configurations? Every entity disappears from Home Assistant until discovery '
    + 'runs again. Nothing belonging to another integration is touched.')) return;
  const r = await api('/api/discovery/clear', { method: 'POST' });
  toast(r.body.message, r.body.ok);
}

// --- Integration actions, rendered from what each integration says it can do -----------------------------
// Nothing here names an integration. The server derives the action list from the capabilities each one
// declares, so a plugin dropped into plugins/ gets its buttons with no TypeScript written for it — which is
// the whole point of the plugin contracts. The hand-wired per-destination functions above are what this
// replaces; they stay until every built-in is converted.

/// Run one action and report what came back.
export async function runIntegrationAction(id: string, action: any) {
  // Anything that removes something at the far end is confirmed, and named, before it happens.
  if (action.effect === 'destructive'
    && !confirm(`${action.title}\n\n${action.description}\n\nThis cannot be undone. Continue?`)) return;

  toast(`${action.title}…`, true);
  const r = await api(`/api/integrations/${encodeURIComponent(id)}/${encodeURIComponent(action.name)}`, { method: 'POST' });
  const body: any = r.body || {};
  // An action returns whatever it likes; show a message if it gave one, otherwise say it finished.
  const result = body.result ?? {};
  const message = body.message ?? result.message ?? result.detail
    ?? (body.ok ? `${action.title} finished.` : `${action.title} failed.`);
  toast(message, body.ok !== false && result.ok !== false);
  return body;
}

/// The buttons for one integration, or null when it has none to offer.
export async function integrationActionBar(id: string): Promise<any> {
  const r = await api('/api/integrations');
  if (!r.body?.ok) return null;
  const found = (r.body.integrations || []).find((i: any) => i.id === id);
  if (!found || !(found.actions || []).length) return null;

  const bar = el('div', { class: 'ld-toolbar' });
  found.actions.forEach((a: any) => {
    const b = btn(a.title, a.effect === 'destructive' ? 'danger' : a.effect === 'write' ? 'primary' : undefined);
    b.title = a.description;
    b.onclick = () => runIntegrationAction(id, a);
    bar.appendChild(b);
  });
  return bar;
}
