// Bootstrap & shared status: load the schema + config, build the UI, and wire the global Save/Reload.
import { api, toast } from './helpers.js';
import { state } from './state.js';
import { build } from './config-form.js';
import { exportData } from './overrides.js';

export async function load() {
  state.schema = (await api('/api/schema')).body;
  state.data = (await api('/api/config')).body;
  build();
  refreshStatus();
}

export async function refreshStatus() {
  const { body } = await api('/api/status');
  (document.getElementById('st-version') as any).textContent = 'v' + (body.version || '?');
  (document.getElementById('st-mqtt-dot') as any).className = 'dot ' + (body.mqttConnected ? 'good' : 'bad');
  // A ConfigMap / read-only mount can't be saved; disable Save and explain why.
  const readOnly = body.configWritable === false;
  const save = document.getElementById('btn-save') as any;
  save.disabled = readOnly;
  save.title = readOnly ? 'Config file is read-only and cannot be saved.' : '';
  (document.getElementById('ro-note') as any).style.display = readOnly ? 'inline' : 'none';
  // Show a logout link + signed-in user when OIDC is in use.
  if (body.auth === 'oidc') {
    (document.getElementById('st-logout') as any).style.display = 'inline';
    if (body.user) (document.getElementById('st-user') as any).textContent = body.user;
  }
}

(document.getElementById('btn-reload') as any).onclick = load;
(document.getElementById('btn-save') as any).onclick = async () => {
  const r = await api('/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(exportData()) });
  toast(r.body.message || (r.ok ? 'Saved.' : 'Save failed.'), r.ok && r.body.ok);
};

load();
