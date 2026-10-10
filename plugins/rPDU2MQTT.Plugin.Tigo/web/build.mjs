// Builds web/{page}.ts and .css into wwwroot.
import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '..', 'wwwroot');
await mkdir(outDir, { recursive: true });

const minifyCss = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, ' ')
  .replace(/\s*([{}:;,>])\s*/g, '$1').replace(/;}/g, '}').trim() + '\n';

for (const file of (await readdir(here)).filter(f => f.endsWith('.ts'))) {
  const page = file.slice(0, -3);
  const js = stripTypeScriptTypes(await readFile(join(here, file), 'utf8'), { mode: 'strip' })
    .replace(/^(\s*)export\s+default\s+(?=function\b)/m, '$1')
    .replace(/^(\s*)export\s+(?=(const|let|var|function|async|class)\b)/gm, '$1')
    .replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trimEnd();
  await writeFile(join(outDir, page + '.js'), js + '\nreturn mount;\n');
  const css = await readFile(join(here, page + '.css'), 'utf8').catch(() => null);
  if (css != null) await writeFile(join(outDir, page + '.css'), minifyCss(css));
  console.log(`plugin page: wrote wwwroot/${page}.js${css != null ? ' + .css' : ''}`);
}
