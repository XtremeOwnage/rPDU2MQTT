// Shell bootstrap: app bar, live indicator, theme, palette and save bar.
import { api, toast, slug, el, openSheet, closeSheet, sheetIsOpen } from './helpers.js';
import { state } from './state.js';
import { build } from './config-form.js';
import { exportData } from './overrides.js';
import { setBaseline, refreshDirty, discardChanges, isDirty, changes, formatValue, onDirty } from './dirty.js';
import { subscribeLive, onRealtimeState, expectedRestart, restartFinished, expectRestart, onExpectRestart } from './realtime.js';
import { initTheme } from './theme.js';
import { initPalette } from './palette.js';
import { loadPluginPages } from './plugin-pages.js';

// Back/forward and hash edits: open the matching tab if it isn't already active.
window.addEventListener('hashchange', () => {
  const wanted = decodeURIComponent((location.hash || '').slice(1));
  if (!wanted) return;
  const link = ([...document.querySelectorAll('nav a')] as any[]).find(a => slug(a.dataset?.label || a.textContent) === wanted);
  if (link && !link.classList.contains('active')) link.click();
});

export async function load() {
  state.schema = (await api('/api/schema')).body;
  state.data = (await api('/api/config')).body;
  // Older backends lack this endpoint.
  try { state.derivations = ((await api('/api/flow/derivations')).body || {}).metrics || []; }
  catch { state.derivations = []; }
  await loadPluginPages();
  build();
  setBaseline();
  refreshStatus();
}

// --- App-bar status --------------------------------------------------------------------------------

// Last operator report time, so "check now" can tell when a fresh result lands.
let lastCheckedAt: string | null = null;
let configWritable = true;
// null means no report seen yet, distinct from "".
let lastApplied: string | null = null;
let lastAppliedAt: string | null = null;

/// True when the operator has rolled the deployment since the last report; never on the first report.
export function appliedTagChanged(applied: string | undefined | null, appliedAt?: string | null): boolean {
  const at = appliedAt || '';
  if (at !== '') {
    const rolled = lastAppliedAt !== null && at !== lastAppliedAt;
    lastAppliedAt = at;
    if (applied) lastApplied = applied;
    return rolled;
  }

  const now = applied || '';
  // A report without a tag is not a tag change.
  if (now === '') return false;
  const changed = lastApplied !== null && now !== lastApplied;
  lastApplied = now;
  return changed;
}

// Header update chip from the operator's report; hidden when none is reporting.
function renderUpdate(u: any) {
  const upd: any = document.getElementById('st-update');
  if (!upd) return;
  if (!u) { upd.classList.add('is-hidden'); lastCheckedAt = null; return; }
  lastCheckedAt = u.checkedAt || null;
  // An operator-applied update is treated like a manual switch.
  if (appliedTagChanged(u.applied, u.appliedAt)) {
    expectRestart(`Auto-updating to ${u.applied}`);
    toast(`Update applied — rolling to ${u.applied}. The bridge is restarting.`, true);
  }
  upd.classList.remove('is-hidden', 'busy');
  if (u.available) {
    upd.className = 'pill pill-btn warn';
    upd.textContent = '↑ ' + (u.latest || 'Update');
    upd.title = 'Update available: ' + (u.latest || '?') + (u.current ? ' (on ' + u.current + ')' : '')
      + (u.applied ? ' — auto-updated' : '') + '\nClick to check now';
  } else if (u.current) {
    upd.className = 'pill pill-btn good';
    upd.textContent = '✓ ' + u.current;
    upd.title = 'Up to date' + (u.checkedAt ? ' (checked ' + new Date(u.checkedAt).toLocaleString() + ')' : '') + '\nClick to check now';
  } else {
    upd.className = 'pill pill-btn';
    upd.textContent = 'Check updates';
    upd.title = (u.message || '') + '\nClick to check now';
  }
}

/// Badge for settings saved but not yet running; clicking it restarts.
function renderRestartPending(r: any) {
  const pill: any = document.getElementById('st-restart');
  if (!pill) return;
  const settings: string[] = (r && r.settings) || [];
  if (!r || !r.required || !settings.length) { pill.classList.add('is-hidden'); return; }
  pill.classList.remove('is-hidden');
  pill.textContent = 'Restart required';
  pill.title = `${settings.length} saved setting(s) are not what this process is running:\n`
    + settings.slice(0, 12).map(s => '· ' + s).join('\n')
    + (settings.length > 12 ? `\n· …and ${settings.length - 12} more` : '')
    + '\nClick to restart the bridge and apply them.';
  pill.onclick = () => restartNow(settings);
}

async function restartNow(settings: string[]) {
  const what = settings.length === 1 ? settings[0] : `${settings.length} settings`;
  if (!confirm(`Restart the bridge now to apply ${what}?\n\nPolling and MQTT publishing stop for a few seconds. This page reconnects on its own.`)) return;
  expectRestart('Applying saved settings');
  const r = await api('/api/restart', { method: 'POST' });
  toast(r.body?.message || (r.ok ? 'Restarting…' : 'Could not restart.'), !!(r.body?.ok ?? r.ok));
}

// --- Coming back from a restart ----------------------------------------------------------------------

let bootVersion: string | null = null;
let returnWatch: any = null;
let watchingForReturn = false;
/// The process that last answered /api/status.
let lastInstance: string | null = null;

// --- The restart overlay -------------------------------------------------------------------------------
let restartBox: any = null;
let restartFrom: string | null = null;
let restartTimer: any = null;
let restartParts: { title: any, elapsed: any, dismiss: any } | null = null;

function showRestartOverlay(why: string) {
  restartFrom = lastInstance;
  const started = Date.now();
  if (!restartBox) {
    restartBox = el('div', { class: 'restart-overlay', role: 'alertdialog', 'aria-live': 'polite' });
    const box = el('div', { class: 'restart-box' });
    const title = el('div', { class: 'restart-title' });
    const elapsed = el('div', { class: 'restart-elapsed' });
    const dismiss = el('button', { class: 'ghost restart-dismiss', text: 'Dismiss' });
    dismiss.onclick = () => hideRestartOverlay();
    box.append(el('div', { class: 'restart-spinner' }), title,
      el('div', { class: 'restart-line', text: 'Waiting for the bridge to come back.' }), elapsed, dismiss);
    restartBox.appendChild(box);
    document.body.appendChild(restartBox);
    restartParts = { title, elapsed, dismiss };
  }
  const parts = restartParts!;
  parts.title.textContent = why;
  const tick = () => {
    const secs = Math.round((Date.now() - started) / 1000);
    parts.elapsed.textContent = secs < 90 ? `${secs} s` : `${secs} s — taking longer than expected`;
    parts.dismiss.hidden = secs < 30;
  };
  tick();
  clearInterval(restartTimer);
  restartTimer = setInterval(tick, 1000);
}

function hideRestartOverlay() {
  clearInterval(restartTimer);
  restartTimer = null;
  restartFrom = null;
  restartBox?.remove();
  restartBox = null;
  restartParts = null;
}

/// Poll until the bridge answers again.
function watchForReturn() {
  // A flag, not the timer id: timer ids are only reliably truthy in a browser.
  if (watchingForReturn) return;
  watchingForReturn = true;
  const poll = async () => {
    let body: any = null;
    try { const r: any = await api('/api/status'); body = r && r.ok ? r.body : null; } catch { body = null; }
    if (!body || !body.version) return;
    // During a rolling update the old instance still answers; wait for a different one.
    if (restartFrom && body.instance && body.instance === restartFrom) return;
    clearInterval(returnWatch);
    returnWatch = null;
    watchingForReturn = false;
    cameBack(body);
  };
  returnWatch = setInterval(poll, 2500);
  setTimeout(poll, 1000);
}

/// Reload on a different build; otherwise refresh the page.
function cameBack(body: any) {
  restartFinished();
  hideRestartOverlay();
  renderStatus(body);

  const now = body.version || '';
  if (bootVersion && now && now !== bootVersion) {
    // Do not reload over unsaved changes.
    if (isDirty()) {
      toast(`The bridge is back on v${now}, but this page is still the old build. Save or discard your `
          + 'changes, then reload to catch up.', true);
      return;
    }
    toast(`Updated to v${now} — reloading this page.`, true);
    setTimeout(() => location.reload(), 600);
    return;
  }

  toast('The bridge is back.', true);
  try { window.dispatchEvent?.(new CustomEvent('rpdu:activate')); } catch { }
}

// Paint the app bar from a /api/status body.
function renderStatus(body: any) {
  if (!body) return;
  const set = (id: string, fn: (e: any) => void) => { const e = document.getElementById(id); if (e) fn(e); };

  // The build this page was loaded against.
  if (!bootVersion && body.version) bootVersion = body.version;
  if (body.instance) lastInstance = body.instance;
  set('st-version', e => { e.textContent = 'v' + (body.version || '?'); e.title = body.configSource ? 'Config source: ' + body.configSource : ''; });
  set('st-mqtt', e => {
    e.className = 'pill ' + (body.mqttConnected ? 'good' : 'bad');
    e.title = (body.mqttConnected ? 'Connected to ' : 'Not connected to ') + (body.mqttHost || 'the broker');
  });
  set('st-mqtt-dot', e => e.className = 'dot ' + (body.mqttConnected ? 'good' : 'bad'));
  renderUpdate(body.update);

  renderRestartPending(body.restart);

  // A read-only config source cannot be saved.
  configWritable = body.configWritable !== false;
  set('st-readonly', e => e.classList[configWritable ? 'add' : 'remove']('is-hidden'));
  renderSaveBar();

  // Absent (older server) means show it.
  set('project-link', e => e.classList[body.showProjectLink === false ? 'add' : 'remove']('is-hidden'));

  if (body.auth === 'oidc') {
    set('st-logout', e => e.classList.remove('is-hidden'));
    if (body.user) set('st-user', e => e.textContent = body.user);
  }
}

export async function refreshStatus() {
  renderStatus((await api('/api/status')).body);
}

function initLiveIndicator() {
  const pill: any = document.getElementById('st-live');
  const LOOK: Record<string, any> = {
    live: ['pill good', 'Live', 'Live updates are streaming from the bridge.'],
    connecting: ['pill warn', 'Connecting', 'Opening the live update stream…'],
    down: ['pill bad', 'Offline', 'The live update stream dropped — retrying. Pages fall back to manual refresh.'],
    idle: ['pill', 'Idle', 'Nothing on this page needs live updates.'],
  };
  onExpectRestart(() => { showRestartOverlay(expectedRestart() || 'Restarting'); watchForReturn(); });
  onRealtimeState(s => {
    if (s === 'down') watchForReturn();
    if (!pill) return;
    // An expected restart shows "Updating" instead of "Offline".
    const why = expectedRestart();
    if (s === 'live') restartFinished();
    const restarting = why && s !== 'live';
    const [cls, text, title] = restarting
      ? ['pill warn', 'Updating', `${why} — the bridge is restarting, so live updates have paused. This page reconnects on its own.`]
      : (LOOK[s] || LOOK.idle);
    pill.className = cls;
    pill.title = title;
    pill.innerHTML = '';
    const dot = restarting ? ' warn' : s === 'live' ? ' good' : s === 'down' ? ' bad' : s === 'connecting' ? ' warn' : '';
    pill.append(el('span', { class: 'dot' + dot }), text);
  });
  subscribeLive('status', renderStatus);
}

// Ask the operator to run a registry check, then poll for the result.
async function checkUpdatesNow() {
  const upd: any = document.getElementById('st-update');
  if (upd.classList.contains('busy')) return;
  const priorCheckedAt = lastCheckedAt;
  upd.classList.add('busy'); upd.textContent = '⏳ Checking…'; upd.title = 'Checking for updates…';

  const r = await api('/api/operator/check', { method: 'POST' });
  if (!r.ok || !r.body?.ok) { toast(r.body?.message || 'Update check failed.', false); await refreshStatus(); return; }

  // The operator updates its status asynchronously; poll for a newer checkedAt.
  const started = Date.now();
  while (Date.now() - started < 12000) {
    await new Promise(res => setTimeout(res, 1500));
    const s = (await api('/api/status')).body;
    if (s.update && s.update.checkedAt && s.update.checkedAt !== priorCheckedAt) {
      renderUpdate(s.update);
      toast(s.update.available ? ('Update available: ' + (s.update.latest || '?')) : 'Up to date.', true);
      return;
    }
  }
  await refreshStatus();
  toast('Requested a check — no response yet. Is the operator role running?', false);
}

// --- Save bar --------------------------------------------------------------------------------------

let saving = false;

/// Reserve the save bar's height at the page foot so content can scroll past it.
function reserveForSaveBar() {
  const bar: any = document.getElementById('savebar');
  const h = bar && !bar.classList.contains('is-hidden') ? Math.ceil(bar.offsetHeight || 0) : 0;
  document.documentElement?.style?.setProperty?.('--savebar-h', h + 'px');
}
try { window.addEventListener('resize', () => reserveForSaveBar()); } catch { }

function renderSaveBar() {
  const bar: any = document.getElementById('savebar');
  const count: any = document.getElementById('save-count');
  const save: any = document.getElementById('btn-save');
  const note: any = document.getElementById('ro-note');
  if (!bar) return;

  const n = changes().length;
  bar.classList[n ? 'remove' : 'add']('is-hidden');
  if (count) count.textContent = n === 1 ? '1 unsaved change' : n + ' unsaved changes';
  reserveForSaveBar();
  if (note) note.classList[configWritable ? 'add' : 'remove']('is-hidden');
  if (save) {
    save.disabled = saving || !configWritable;
    save.title = configWritable ? 'Write these changes to the configuration source' : 'The configuration source is read-only and cannot be saved.';
  }
}

async function saveConfigChanges() {
  if (saving || !isDirty() || !configWritable) return;
  const save: any = document.getElementById('btn-save');
  const payload = exportData();
  saving = true; renderSaveBar();
  if (save) save.textContent = 'Saving…';

  const r = await api('/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  saving = false;
  if (save) { save.innerHTML = ''; save.append('Save', el('kbd', { text: 'Ctrl' }), el('kbd', { text: 'S' })); }

  const ok = r.ok && r.body.ok;
  // Re-baseline only on success.
  if (ok) setBaseline(payload);
  else renderSaveBar();
  toast(r.body.message || (ok ? 'Saved.' : 'Save failed.'), ok);

  if (ok && r.body.restartRequired) {
    const settings: string[] = r.body.restartSettings || [];
    renderRestartPending({ required: true, settings });
    restartNow(settings);
  }
}

// Review sheet: one row per changed setting, old -> new.
function reviewChanges() {
  const list = changes();
  const body = el('div');
  if (!list.length) body.appendChild(el('div', { class: 'cmd-empty', text: 'Nothing has been changed.' }));

  const groups = new Map<string, any[]>();
  list.forEach(c => {
    const g = c.path[0] || 'Config';
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g)!.push(c);
  });

  groups.forEach((rows, g) => {
    const box = el('div', { class: 'diff-group' }, el('h4', { text: g }));
    rows.forEach(c => box.appendChild(el('div', { class: 'diff-row' },
      el('div', { class: 'diff-path', text: (c.label || c.path).join(' › ') }),
      el('span', { class: 'diff-val diff-old', text: formatValue(c.from, c.secret) }),
      el('span', { class: 'diff-arrow', text: '→' }),
      el('span', { class: 'diff-val diff-new', text: formatValue(c.to, c.secret) }))));
    body.appendChild(box);
  });

  const discard = el('button', { class: 'danger', text: 'Discard all', onclick: () => { closeSheet(); discardAll(); } });
  const saveBtn = el('button', { class: 'primary', text: 'Save', onclick: () => { closeSheet(); saveConfigChanges(); } });
  openSheet({ title: list.length === 1 ? '1 unsaved change' : list.length + ' unsaved changes', body, wide: true, footer: list.length ? [discard, saveBtn] : null });
}

function discardAll() {
  if (!isDirty()) return;
  if (!confirm(`Discard ${changes().length} unsaved change(s) and go back to the saved configuration?`)) return;
  discardChanges();
  build();
  refreshDirty();
  toast('Changes discarded.', true);
}

// --- Wiring ----------------------------------------------------------------------------------------

function initShell() {
  const on = (id: string, fn: any) => { const e: any = document.getElementById(id); if (e) e.onclick = fn; };
  on('st-update', checkUpdatesNow);
  on('btn-save', saveConfigChanges);
  on('btn-review', reviewChanges);
  on('btn-discard', discardAll);
  on('btn-reload', () => {
    if (isDirty() && !confirm(`Reload from the server and lose ${changes().length} unsaved change(s)?`)) return;
    load();
  });

  // Narrow screens: the sidebar is a drawer; a nav click closes it.
  const closeNav = () => document.body.classList.remove('nav-open');
  on('nav-toggle', () => document.body.classList.toggle('nav-open'));
  on('nav-scrim', closeNav);
  document.getElementById('nav')?.addEventListener('click', (e: any) => { if (e.target?.closest?.('a')) closeNav(); });

  window.addEventListener('keydown', (e: any) => {
    if (e.key === 'Escape' && sheetIsOpen()) { e.preventDefault(); closeSheet(); return; }
    if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) { e.preventDefault(); saveConfigChanges(); }
  });

  window.addEventListener('beforeunload', (e: any) => {
    if (!isDirty()) return;
    e.preventDefault();
    e.returnValue = '';
  });

  onDirty(renderSaveBar);

  // Bespoke editors mutate the document directly, so re-diff after any interaction.
  let dirtyTick: any = null;
  const scheduleDirty = () => { clearTimeout(dirtyTick); dirtyTick = setTimeout(refreshDirty, 120); };
  const sections = document.getElementById('sections');
  ['change', 'input', 'click'].forEach(ev => sections?.addEventListener(ev, scheduleDirty, true));

  initTheme();
  initPalette();
  initLiveIndicator();
}

initShell();
load();
