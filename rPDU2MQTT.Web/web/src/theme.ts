// Light / dark / follow-the-system theming.
//
// The GUI was dark-only, which is fine at 2am in a rack room and rough on a laptop in daylight. The
// stylesheet carries both palettes; this file only decides which one is in force, by setting
// `data-theme` on <html> (absent = follow the OS). index.html applies the stored choice inline before
// first paint so a reload never flashes the wrong palette.
//
// Anything that paints from the tokens (the flow SVG reads var(--accent) & friends) is repainted by
// listening for the `rpdu:theme` event.

const THEME_KEY = 'rpdu-theme';
const THEME_ORDER = ['system', 'dark', 'light'];
const THEME_GLYPH: Record<string, string> = { system: '◐', dark: '☾', light: '☀' };
const THEME_NAME: Record<string, string> = { system: 'Follow system', dark: 'Dark', light: 'Light' };

function readTheme(): string {
  try { const v = localStorage.getItem(THEME_KEY); return THEME_ORDER.includes(v as any) ? (v as string) : 'system'; }
  catch { return 'system'; }
}

export function applyTheme(theme: string) {
  const root: any = document.documentElement;
  if (!root) return;
  // No attribute = the stylesheet's prefers-color-scheme branch decides.
  if (theme === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', theme);
  try { localStorage.setItem(THEME_KEY, theme); } catch { /* private mode: the choice just won't persist */ }
  window.dispatchEvent?.(new CustomEvent('rpdu:theme', { detail: { theme } }));
}

// Wire the app-bar button: click cycles system -> dark -> light, and the glyph says where you are.
export function initTheme() {
  const btn: any = document.getElementById('st-theme');
  let theme = readTheme();
  const paint = () => {
    if (!btn) return;
    btn.textContent = THEME_GLYPH[theme];
    btn.title = `Theme: ${THEME_NAME[theme]} — click to switch`;
  };
  applyTheme(theme);
  paint();
  if (btn) btn.onclick = () => {
    theme = THEME_ORDER[(THEME_ORDER.indexOf(theme) + 1) % THEME_ORDER.length];
    applyTheme(theme);
    paint();
  };
}
