// Zero-dependency GUI build: TypeScript ES modules -> a single bundled app.js, using only the Node
// binary (no npm). Node's built-in module.stripTypeScriptTypes() removes the type annotations; the
// modules share one scope at runtime (as the GUI always has), so "bundling" is: strip each module's
// import/export lines and concatenate them with the entry (main) last. styles.css is minified too.
//
// A real bundler/minifier (esbuild) can replace bundle()/minifyJs() here verbatim once npm is available
// in the build image — the inputs (web/src/*.ts) and outputs (wwwroot/app.js, styles.css) stay the same.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = join(here, 'src');
const outDir = join(here, '..', 'wwwroot');

// Module order: declarations first, the entry (top-level bootstrap) last. Order among the rest is
// irrelevant — they only declare functions/consts — but the entry runs load() at the top level.
const MODULES = [
  'state.ts',
  'helpers.ts',
  'overrides.ts',
  'sections/paths.ts',
  'sections/diagnostics.ts',
  'sections/control.ts',
  'sections/livedata.ts',
  'sections/flow.ts',
  'sections/export.ts',
  'sections/ha-energy.ts',
  'sections/home.ts',
  'config-form.ts',
  'actions.ts',
  'main.ts',
];

// Drop import lines and the leading `export ` keyword: the bundle is one shared scope, like the
// original single file, so cross-module names resolve directly.
function debundle(js) {
  return js
    .split('\n')
    .filter(line => !/^\s*import\b/.test(line))
    .map(line => line.replace(/^(\s*)export\s+(?=(const|let|var|function|async|class)\b)/, '$1'))
    .join('\n');
}

// Safe, parser-free JS tidy-up: trim trailing whitespace and collapse runs of blank lines. (Does not
// touch line contents, so strings/templates/regex are untouched and ASI is preserved.)
function tidyJs(js) {
  return js.replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

// Safe CSS minify: strip /* */ comments and collapse whitespace (CSS has no regex literals).
function minifyCss(css) {
  return css
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\s+/g, ' ')
    .replace(/\s*([{}:;,>])\s*/g, '$1')
    .replace(/;}/g, '}')
    .trim() + '\n';
}

async function buildJs() {
  const parts = [];
  for (const rel of MODULES) {
    const ts = await readFile(join(srcDir, rel), 'utf8');
    const js = stripTypeScriptTypes(ts, { mode: 'strip' });
    parts.push(`// ── ${rel} ${'─'.repeat(Math.max(0, 60 - rel.length))}\n${debundle(js)}`);
  }
  await writeFile(join(outDir, 'app.js'), tidyJs(parts.join('\n\n')));
}

async function buildCss() {
  const css = await readFile(join(here, 'styles.css'), 'utf8');
  await writeFile(join(outDir, 'styles.css'), minifyCss(css));
}

await mkdir(outDir, { recursive: true });
await Promise.all([buildJs(), buildCss()]);
console.log('GUI build: wrote wwwroot/app.js + styles.css');
