// Renaming a node rewrites every config reference and queues its history move for the save.
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { makeDom } from './domstub.mjs';

const code = await readFile(new URL('../wwwroot/app.js', import.meta.url), 'utf8');
const fail = (m) => { console.error('rename check FAILED: ' + m); process.exit(1); };

const { sandbox } = makeDom({ bodies: (url) => url.includes('/api/schema') ? [] : { ok: true } });
vm.createContext(sandbox);
vm.runInContext(code, sandbox, { filename: 'app.js' });

const data = {
  EnergyFlow: {
    Nodes: [{ Id: 'n30_3_4' }, { Id: 'sub' }],
    Links: [{ From: 'sub', To: 'n30_3_4' }],
    Parents: { n30_3_4: 'sub' },
    Groups: [{ Id: 'g', Members: ['n30_3_4'] }],
    Balance: { Home: ['n30_3_4'] },
    Panels: [{ Id: 'p', Node: 'sub', Breakers: [{ Slot: 1, Node: 'n30_3_4' }] }],
    Clamps: [{ Channel: 'n30_3_4' }, { Channel: 'n30_3_40' }],
  },
  Plugins: { locations: {
    Placements: [{ Id: 'ac', Node: 'n30_3_4' }],
    Sites: [{ Floors: [{ Rooms: [{ Climate: { Temperature: ['n30_3_4'] } }] }] }],
  } },
};

if (sandbox.countNodeRefs(data, 'n30_3_4') !== 8) fail(`counted ${sandbox.countNodeRefs(data, 'n30_3_4')} references, expected 8`);
sandbox.renameNodeRefs(data, 'n30_3_4', 'n31_3_6');
const left = JSON.stringify(data).match(/"n30_3_4"/g) || [];
if (left.length !== 1) fail(`old id left in ${left.length - 1} reference(s)`);
if (data.EnergyFlow.Clamps[1].Channel !== 'n30_3_40') fail('a different channel was renamed');
if (data.EnergyFlow.Parents.n31_3_6 !== 'sub') fail('Parents key not moved');

sandbox.noteRename('a', 'b');
sandbox.noteRename('b', 'c');
const url = decodeURIComponent(sandbox.configSaveUrl());
if (url !== '/api/config?renames=[["a","c"]]') fail('chained rename not merged: ' + url);
sandbox.noteRename('c', 'a');
if (sandbox.configSaveUrl() !== '/api/config') fail('rename back to the original id still queued');

console.log('rename check passed');
process.exit(0);
