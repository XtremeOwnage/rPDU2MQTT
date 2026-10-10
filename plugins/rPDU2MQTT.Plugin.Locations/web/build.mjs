// Builds each page: its modules concatenated into wwwroot/<page>.js, and its stylesheet.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '..', 'wwwroot');
await mkdir(outDir, { recursive: true });

// Helpers first; the page (which defines mount) last.
const PAGES = {
  'floor-plans': ['host.ts', 'plan-geometry.ts', 'plan-units.ts', 'plan-history.ts', 'plan-constraints.ts', 'plan-art.ts', 'floor-plans.ts'],
  'locations': ['host.ts', 'locations.ts'],
};

function debundle(js) {
  const out = [];
  let inImport = false;
  for (const line of js.split('\n')) {
    if (inImport) {
      if (/\bfrom\s*['"]/.test(line) || /^\s*['"]/.test(line)) inImport = false;
      continue;
    }
    if (/^\s*import\b/.test(line)) {
      if (!/\bfrom\s*['"]/.test(line) && !/;\s*$/.test(line)) inImport = true;
      continue;
    }
    out.push(line.replace(/^(\s*)export\s+default\s+(?=function\b)/, '$1')
                 .replace(/^(\s*)export\s+(?=(const|let|var|function|async|class|type|interface)\b)/, '$1'));
  }
  return out.join('\n');
}

const minifyCss = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, ' ')
  .replace(/\s*([{}:;,>])\s*/g, '$1').replace(/;}/g, '}').trim() + '\n';

for (const [page, modules] of Object.entries(PAGES)) {
  const parts = [];
  for (const file of modules) {
    const js = stripTypeScriptTypes(await readFile(join(here, file), 'utf8'), { mode: 'strip' });
    parts.push(`// ── ${file} ${'─'.repeat(Math.max(0, 60 - file.length))}\n${debundle(js)}`);
  }
  const js = parts.join('\n\n').replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trimEnd();
  await writeFile(join(outDir, `${page}.js`), js + '\nreturn mount;\n');
  await writeFile(join(outDir, `${page}.css`), minifyCss(await readFile(join(here, `${page}.css`), 'utf8')));
}
console.log(`plugin pages: wrote ${Object.keys(PAGES).map(p => p + '.js').join(', ')}`);
