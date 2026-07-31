// Shell bootstrap: load the schema + config, build the UI, and own everything that lives outside a
// section — the app bar, the live-stream indicator, the theme, the palette, and the save bar.
import { api, toast, slug, el, openSheet, closeSheet, sheetIsOpen } from './helpers.js';
import { state } from './state.js';
import { build } from './config-form.js';
import { exportData } from './overrides.js';
import { setBaseline, refreshDirty, discardChanges, isDirty, changes, formatValue, onDirty } from './dirty.js';
import { subscribeLive, onRealtimeState, expectedRestart, restartFinished } from './realtime.js';
import { initTheme } from './theme.js';
import { initPalette } from './palette.js';

// Back/forward navigation + direct hash edits: open the matching tab if it isn't already active. (Normal
// tab clicks already set the hash via activate(), so by the time this fires the tab is active -> no-op,
// which also avoids re-loading a tab's data on every click.)
window.addEventListener('hashchange', () => {
  const wanted = decodeURIComponent((location.hash || '').slice(1));
  if (!wanted) return;
  const link = ([...document.querySelectorAll('nav a')] as any[]).find(a => slug(a.dataset?.label || a.textContent) === wanted);
  if (link && !link.classList.contains('active')) link.click();
});

export async function load() {
  state.schema = (await api('/api/schema')).body;
  state.data = (await api('/api/config')).body;
  build();
  // Whatever the server just handed us is, by definition, the saved state.
  setBaseline();
  refreshStatus();
}

// --- App-bar status --------------------------------------------------------------------------------

// Last-seen operator update report, so "check now" can tell when a fresh result has landed.
let lastCheckedAt: string | null = null;
let configWritable = true;

// Render the header update chip from the operator's report (#210). Hidden when no operator is reporting.
function renderUpdate(u: any) {
  const upd: any = document.getElementById('st-update');
  if (!upd) return;
  if (!u) { upd.classList.add('is-hidden'); lastCheckedAt = null; return; }
  lastCheckedAt = u.checkedAt || null;
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

// Paint the app bar from a /api/status body — from the initial fetch, or pushed on the `status` feed.
function renderStatus(body: any) {
  if (!body) return;
  const set = (id: string, fn: (e: any) => void) => { const e = document.getElementById(id); if (e) fn(e); };

  set('st-version', e => { e.textContent = 'v' + (body.version || '?'); e.title = body.configSource ? 'Config source: ' + body.configSource : ''; });
  set('st-mqtt', e => {
    e.className = 'pill ' + (body.mqttConnected ? 'good' : 'bad');
    e.title = (body.mqttConnected ? 'Connected to ' : 'Not connected to ') + (body.mqttHost || 'the broker');
  });
  set('st-mqtt-dot', e => e.className = 'dot ' + (body.mqttConnected ? 'good' : 'bad'));
  renderUpdate(body.update);

  // A ConfigMap / read-only mount can't be saved: say so up front, not after the save fails.
  configWritable = body.configWritable !== false;
  set('st-readonly', e => e.classList[configWritable ? 'add' : 'remove']('is-hidden'));
  renderSaveBar();

  // Off by default only if the operator turned it off; absent (an older server) means show it.
  set('project-link', e => e.classList[body.showProjectLink === false ? 'add' : 'remove']('is-hidden'));

  // Show a logout link + signed-in user when OIDC is in use.
  if (body.auth === 'oidc') {
    set('st-logout', e => e.classList.remove('is-hidden'));
    if (body.user) set('st-user', e => e.textContent = body.user);
  }
}

export async function refreshStatus() {
  renderStatus((await api('/api/status')).body);
}

// The live pill: the one place that says whether anything on screen is actually moving.
function initLiveIndicator() {
  const pill: any = document.getElementById('st-live');
  const LOOK: Record<string, any> = {
    live: ['pill good', 'Live', 'Live updates are streaming from the bridge.'],
    connecting: ['pill warn', 'Connecting', 'Opening the live update stream…'],
    down: ['pill bad', 'Offline', 'The live update stream dropped — retrying. Pages fall back to manual refresh.'],
    idle: ['pill', 'Idle', 'Nothing on this page needs live updates.'],
  };
  onRealtimeState(s => {
    if (!pill) return;
    // A gap we asked for is not a fault. While a switch/redeploy/restart is in flight the stream is
    // expected to drop, so say "Updating" rather than flashing red "Offline" at someone who just clicked
    // the button that caused it. Once the stream is back, the window closes and normal reporting resumes —
    // and if it never comes back, the window expires and it goes red for real.
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
  // The app bar is always watching, so the stream is up as soon as the page is.
  subscribeLive('status', renderStatus);
}

// "Check now": ask the operator (a separate process) to run a registry check, then poll for the result.
async function checkUpdatesNow() {
  const upd: any = document.getElementById('st-update');
  if (upd.classList.contains('busy')) return;
  const priorCheckedAt = lastCheckedAt;
  upd.classList.add('busy'); upd.textContent = '⏳ Checking…'; upd.title = 'Checking for updates…';

  const r = await api('/api/operator/check', { method: 'POST' });
  if (!r.ok || !r.body?.ok) { toast(r.body?.message || 'Update check failed.', false); await refreshStatus(); return; }

  // The operator patches the CR status asynchronously; poll a few times for a newer checkedAt.
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
// It only exists when there is something to save, and it says how much. The old bar was permanent and
// always enabled: identical whether you'd changed nothing or twenty settings, with no way to see what
// a click would write, and no way back.

let saving = false;

function renderSaveBar() {
  const bar: any = document.getElementById('savebar');
  const count: any = document.getElementById('save-count');
  const save: any = document.getElementById('btn-save');
  const note: any = document.getElementById('ro-note');
  if (!bar) return;

  const n = changes().length;
  bar.classList[n ? 'remove' : 'add']('is-hidden');
  if (count) count.textContent = n === 1 ? '1 unsaved change' : n + ' unsaved changes';
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
  // Only re-baseline on success — a failed save must leave the changes (and the bar) exactly as they were.
  if (ok) setBaseline(payload);
  else renderSaveBar();
  toast(r.body.message || (ok ? 'Saved.' : 'Save failed.'), ok);
}

// The reviewable list of what a save would write: one row per setting, old value -> new value.
function reviewChanges() {
  const list = changes();
  const body = el('div');
  if (!list.length) body.appendChild(el('div', { class: 'cmd-empty', text: 'Nothing has been changed.' }));

  // Grouped by the config section each setting belongs to, matching how the nav is organised.
  const groups = new Map<string, any[]>();
  list.forEach(c => {
    const g = c.path[0] || 'Config';
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g)!.push(c);
  });

  groups.forEach((rows, g) => {
    const box = el('div', { class: 'diff-group' }, el('h4', { text: g }));
    rows.forEach(c => box.appendChild(el('div', { class: 'diff-row' },
      el('div', { class: 'diff-path', text: c.path.join(' › ') }),
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
  on('btn-save', saveConfig);
  on('btn-review', reviewChanges);
  on('btn-discard', discardAll);
  on('btn-reload', () => {
    if (isDirty() && !confirm(`Reload from the server and lose ${changes().length} unsaved change(s)?`)) return;
    load();
  });

  // Narrow screens: the sidebar is a drawer. Any nav click closes it again.
  const closeNav = () => document.body.classList.remove('nav-open');
  on('nav-toggle', () => document.body.classList.toggle('nav-open'));
  on('nav-scrim', closeNav);
  document.getElementById('nav')?.addEventListener('click', (e: any) => { if (e.target?.closest?.('a')) closeNav(); });

  window.addEventListener('keydown', (e: any) => {
    if (e.key === 'Escape' && sheetIsOpen()) { e.preventDefault(); closeSheet(); return; }
    // Ctrl/⌘+S is what everyone's fingers already do in a form this size.
    if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) { e.preventDefault(); saveConfigChanges(); }
  });

  // Don't let a tab close silently take edits with it.
  window.addEventListener('beforeunload', (e: any) => {
    if (!isDirty()) return;
    e.preventDefault();
    e.returnValue = '';
  });

  // The bar is a pure function of the pending changes, so it repaints whenever they move.
  onDirty(renderSaveBar);

  // The bespoke editors (energy-flow nodes, the overrides table) mutate the same document directly
  // rather than going through the schema form. Instead of making every one of them report in, re-diff
  // after any interaction with the page: the document is small, and this runs once per event burst.
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
