// The two Home Assistant cleanups that "Clear discovery" cannot do, rendered on the Home Assistant page
// beside the discovery buttons they belong with.
//
// Both list what they found — names and identifiers — before anything happens. A bare confirm() with a count
// is not enough here: deleting registry entries out of someone's Home Assistant is not undoable from this
// side, and the identifiers are what let you recognise a device from an older naming scheme as genuinely
// dead rather than merely unfamiliar.
import { api, btn, el, toast } from '../helpers.js';

export function addDiscoveryCleanup(sec: any) {
  // ---- Retained configs for tiers this build would no longer publish ----
  sec.appendChild(el('h3', { text: 'Orphaned discovery configs', style: { margin: '20px 0 4px' } }));
  sec.appendChild(el('div', { class: 'desc' },
    'Discovery messages are retained, so a config outlives what it described — an outlet that gained its own '
    + 'native energy sensor, a renamed node, a deleted tier. This finds configs published under this project’s '
    + 'own prefix that the current setup would no longer publish, and retracts them. Live devices are left '
    + 'alone, and nothing belonging to another integration is ever listed or touched.'));

  const orphanOut = el('div', { class: 'desc' }) as HTMLElement;
  const orphanFind = btn('Find orphaned configs');
  const orphanClear = btn('Clear them', 'danger');
  orphanClear.disabled = true;
  sec.appendChild(el('div', { class: 'sec-actions' }, orphanFind, orphanClear));
  sec.appendChild(orphanOut);

  const showOrphans = (topics: string[]) => {
    orphanOut.innerHTML = '';
    orphanClear.disabled = !topics.length;
    if (!topics.length) { orphanOut.textContent = 'Nothing orphaned — every retained discovery config still matches something that exists.'; return; }
    orphanOut.appendChild(el('div', { text: `${topics.length} orphaned config(s) would be cleared:` }));
    const list = el('ul', { style: { margin: '4px 0 0 18px' } });
    topics.forEach(t => list.appendChild(el('li', { text: t, style: { fontFamily: 'var(--mono)', fontSize: '11px' } })));
    orphanOut.appendChild(list);
  };

  orphanFind.onclick = async () => {
    orphanOut.textContent = 'Looking…';
    const r = await api('/api/ha/orphans');
    if (!r.body?.ok) { orphanOut.textContent = 'Could not check: ' + (r.body?.message || 'unknown error'); return; }
    showOrphans(r.body.topics || []);
  };
  orphanClear.onclick = async () => {
    orphanClear.disabled = true;
    const r = await api('/api/ha/orphans/clear', { method: 'POST' });
    if (!r.body?.ok) { toast('Could not clear: ' + (r.body?.message || 'unknown error'), false); return; }
    toast(`Cleared ${r.body.cleared} orphaned config(s).`, true);
    showOrphans([]);
  };

  // ---- Devices Home Assistant still lists whose config is already gone ----
  sec.appendChild(el('h3', { text: 'Stale Home Assistant device registrations', style: { margin: '20px 0 4px' } }));
  sec.appendChild(el('div', { class: 'desc' },
    'Home Assistant keeps a device even after its discovery message is gone, so devices from earlier versions '
    + '— an outlet named under an older scheme, a tier since removed — linger in the UI with no way to clear '
    + 'them over MQTT: there is no config left to retract. This lists ones belonging to this project that have '
    + 'no entities left at all, and deletes them through Home Assistant’s own API. A device that still has '
    + 'entities is live and is never listed; nothing from another integration is either.'));

  const devOut = el('div', { class: 'desc' }) as HTMLElement;
  const devFind = btn('Find stale devices');
  const devDelete = btn('Delete them', 'danger');
  devDelete.disabled = true;
  sec.appendChild(el('div', { class: 'sec-actions' }, devFind, devDelete));
  sec.appendChild(devOut);

  let lastDevices: any[] = [];
  const showDevices = (devices: any[]) => {
    lastDevices = devices;
    devOut.innerHTML = '';
    devDelete.disabled = !devices.length;
    if (!devices.length) { devOut.textContent = 'Nothing stale — every device of ours in Home Assistant still has entities.'; return; }
    devOut.appendChild(el('div', { text: `${devices.length} stale device(s) would be deleted from Home Assistant:` }));
    const list = el('ul', { style: { margin: '4px 0 0 18px' } });
    devices.forEach((d: any) => list.appendChild(el('li', {},
      el('span', { text: d.name || '(unnamed)' }),
      el('span', { style: { color: 'var(--faint)', fontFamily: 'var(--mono)', fontSize: '11px' }, text: '  ' + (d.identifiers || []).join(', ') }))));
    devOut.appendChild(list);
  };

  devFind.onclick = async () => {
    devOut.textContent = 'Asking Home Assistant…';
    const r = await api('/api/ha/devices/stale');
    if (!r.body?.ok) { devOut.textContent = 'Could not check: ' + (r.body?.message || 'unknown error'); return; }
    showDevices(r.body.devices || []);
  };
  devDelete.onclick = async () => {
    if (!confirm('Delete these devices from Home Assistant? They have no entities left, and anything still live '
      + 'is never listed — discovery re-creates a device if it comes back.')) return;

    // Deleted in batches so the count is the truth rather than an animation. Each device is a WebSocket
    // round trip to Home Assistant, so thirty-odd of them takes long enough that a spinner with nothing
    // behind it is indistinguishable from a hang.
    const ids = lastDevices.map((d: any) => d.id).filter(Boolean);
    const total = ids.length;
    devDelete.disabled = true;
    devFind.disabled = true;
    devOut.innerHTML = '';
    const label = el('div', { text: `Deleting 0 of ${total}…` });
    const bar = el('div', { class: 'progress' }, el('span', { style: { width: '0%' } }));
    devOut.appendChild(label); devOut.appendChild(bar);

    let done = 0, removed = 0, failed = '';
    for (let i = 0; i < ids.length; i += 5) {
      const batch = ids.slice(i, i + 5);
      const r = await api('/api/ha/devices/stale/delete', { method: 'POST', body: JSON.stringify({ ids: batch }) });
      if (!r.body?.ok) { failed = r.body?.message || 'unknown error'; break; }
      removed += r.body.deleted || 0;
      done += batch.length;
      label.textContent = `Deleting ${done} of ${total}…`;
      (bar.firstChild as HTMLElement).style.width = Math.round((done / total) * 100) + '%';
    }

    devFind.disabled = false;
    if (failed) { toast('Stopped after ' + removed + ': ' + failed, false); devOut.textContent = `Deleted ${removed} of ${total} before failing: ${failed}`; return; }
    toast(`Deleted ${removed} stale device(s) from Home Assistant.`, true);
    showDevices([]);
  };
}
