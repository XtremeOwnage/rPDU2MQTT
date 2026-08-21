// Rules about the stylesheet that a DOM stub cannot see, because they are about layout in a real browser.
import { readFile } from 'node:fs/promises';

const css = await readFile(new URL('../wwwroot/styles.css', import.meta.url), 'utf8');
const fail = (m) => { console.error('css check FAILED: ' + m); process.exit(1); };

// A sticky element resolves `top` against its nearest SCROLLING ancestor, and `overflow:hidden` makes one.
// `table.ld` carried it for the rounded corners, so Chrome pinned every table header 56px down INSIDE its
// own table, on top of the first row — measured at inset=57px against inset=1px without it (#395). Firefox
// did not, so it survived review. The corners are rounded on the corner cells instead.
const tableRule = /table\.ld\s*\{[^}]*\}/.exec(css);
if (!tableRule) fail('no table.ld rule found — has the class been renamed?');
const stickyHeader = /table\.ld th\s*\{[^}]*position:\s*sticky/.test(css);
if (stickyHeader && /overflow\s*:\s*hidden/.test(tableRule[0]))
  fail('table.ld sets overflow:hidden while its <th> is sticky — the header will pin inside the table');

// The corners still have to be round, and with no clipping that means the corner cells carry it.
if (!/table\.ld thead tr:first-child th:first-child\s*\{[^}]*border-top-left-radius/.test(css))
  fail('the table lost its rounded corners along with overflow:hidden');

console.log('css: a sticky table header is not trapped inside its own table, and the corners are still round');
