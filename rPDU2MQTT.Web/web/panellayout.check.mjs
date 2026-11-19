// Panel layout (#630): quad breakers, half-width double-poles.
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';

const src = stripTypeScriptTypes(await readFile(new URL('./src/panel-layout.ts', import.meta.url), 'utf8'));
const { column, collides } = await import('data:text/javascript,' + encodeURIComponent(src));
const fail = (m) => { console.error('panel layout check FAILED: ' + m); process.exit(1); };
const shape = (cells) => JSON.stringify(cells.map(c => [c.slot, c.span, c.parts.map(p => p.b ? p.b.n : `${p.slot}.${p.half}-`)]));
const expect = (got, want, what) => { if (shape(got) !== JSON.stringify(want)) fail(`${what}: ${shape(got)}`); };

// The issue's repro: outer 2.1, inner 2-pole 2.2, outer 4.2.
const quad = [
  { n: '2.1', slot: 2, poles: 1, half: 1 },
  { n: '2.2', slot: 2, poles: 2, half: 2 },
  { n: '4.2', slot: 4, poles: 1, half: 2 },
];
expect(column(8, quad, false), [[2, 2, ['2.1', '2.2', '4.2']], [6, 1, []], [8, 1, []]], 'quad with inner 2-pole');
if (quad.some(a => quad.some(b => collides(a, b)))) fail('the halves of a quad collide');

// Two 2-poles: the outer pair and the inner pair.
const two = [{ n: 'outer', slot: 2, poles: 2, half: 1 }, { n: 'inner', slot: 2, poles: 2, half: 2 }];
expect(column(4, two, false), [[2, 2, ['outer', 'inner']]], 'quad of two 2-poles');
if (collides(two[0], two[1])) fail('the outer and inner pair collide');

// The free halves are offered.
expect(column(4, [quad[1]], false), [[2, 2, ['2.1-', '2.2', '4.2-']]], 'inner 2-pole alone');

// Same half of slot + 2 is taken.
if (!collides(quad[1], { slot: 4, poles: 1, half: 1 })) fail('a breaker on the half the 2-pole reaches into does not collide');
if (!collides(quad[1], { slot: 4, poles: 1 })) fail('a whole-slot breaker under a half-width 2-pole does not collide');

// Unchanged: full double-pole, plain tandem, single.
const plain = [
  { n: '1,3', slot: 1, poles: 2 },
  { n: '5.1', slot: 5, poles: 1, half: 1 },
  { n: '5.2', slot: 5, poles: 1, half: 2 },
  { n: '7.1', slot: 7, poles: 1, half: 1 },
  { n: '9', slot: 9, poles: 1 },
];
expect(column(10, plain, true), [[1, 2, ['1,3']], [5, 1, ['5.1', '5.2']], [7, 1, ['7.1', '7.2-']], [9, 1, ['9']]], 'plain breakers');
if (!collides(plain[0], { slot: 3, poles: 1 })) fail('a full double-pole no longer holds slot + 2');
// A double-pole in the last slot has nothing to reach into.
expect(column(4, [{ n: '3', slot: 3, poles: 2 }], true), [[1, 1, []], [3, 1, ['3']]], 'double-pole in the last slot');

console.log('panel layout: quad breakers draw all four handles; full double-poles and tandems unchanged');
