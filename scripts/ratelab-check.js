/*
 * ratelab-check.js: prove the Rate Lab is the sequence it was asked to be,
 * laid out like the laps that sequence was copied from.
 *
 * The features and the order are the owner's: a first gate, slalom flags,
 * a triple stack up and then down, a triple corkscrew up, then split-S
 * gates. The spacing is not a guess. It is the spacing of the fastest ghost
 * on a public track of that shape, named in scripts/ratelab-track.js. This
 * file checks the sequence and those distances, and that the course the
 * game derives from it is a closed lap whose line stays off the ground.
 *
 * This file is part of WebFPVSimulator.
 *
 * WebFPVSimulator is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or (at
 * your option) any later version.
 *
 * WebFPVSimulator is distributed in the hope that it will be useful, but
 * WITHOUT ANY WARRANTY, without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU
 * General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with WebFPVSimulator. If not, see <https://www.gnu.org/licenses/>.
 */

import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalize } from '../src/trackbuilder/model.js';
import { courseFromDocument } from '../src/game/trackdoc.js';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

let passed = 0;
let failed = 0;
const fails = [];

function check(what, ok, detail = '') {
  if (ok) {
    passed += 1;
    console.log(`  pass  ${what}${detail ? `, ${detail}` : ''}`);
    return;
  }
  failed += 1;
  fails.push(`${what}${detail ? `, ${detail}` : ''}`);
  console.log(`  FAIL  ${what}${detail ? `, ${detail}` : ''}`);
}

console.log('ratelab-check');

const raw = JSON.parse(await readFile(join(root, 'tracks/json/ratelab.json'), 'utf8'));
const near = (a, b, tol = 0.05) => Math.abs(a - b) <= tol;
const byName = (name) => raw.elements.find((e) => e.name === name);
const flownOf = (id) => raw.sequence.filter((s) => s.elementId === id);

console.log('\n the document');
const norm = normalize(raw);
const repairs = norm.repairs ?? [];
check('the builder normalises it with nothing to repair', repairs.length === 0,
  repairs.length ? JSON.stringify(repairs).slice(0, 300) : 'no repairs');
check('it is schema version 3', raw.schemaVersion === 3);
check('it is a full sized race track, not a room and not a map',
  raw.trackClass === 'full' && raw.mode === undefined);

console.log('\n the order');
const names = raw.sequence.map((s) => {
  const e = raw.elements.find((el) => el.id === s.elementId);
  return e ? e.name : s.elementId;
});
const order = [];
for (const name of names) {
  if (order[order.length - 1] !== name) {
    order.push(name);
  }
}
check('the flying order is first gate, four slalom flags, triple up, triple down, corkscrew, split-S, then the return',
  order.join(' | ') === [
    'First',
    'Slalom 1', 'Slalom 2', 'Slalom 3', 'Slalom 4',
    'Onto the stack',
    'Triple up', 'Triple down', 'Corkscrew',
    'Split-S in', 'Split-S out',
    'Return high', 'Return low',
  ].join(' | '),
  order.join(' | '));

console.log('\n the slalom');
const flags = raw.elements.filter((e) => e.type === 'flag');
check('there are four slalom flags', flags.length === 4, `${flags.length}`);
const sides = flags.map((f) => flownOf(f.id)[0]?.passSide);
check('the pass side alternates, which is what makes it a weave',
  sides.join(',') === 'right,left,right,left', sides.join(','));
check('each flag is passed at the 1.5 m clearance the slalom laps use',
  flags.every((f) => f.dims.clearance === 1.5 && flownOf(f.id)[0]?.clearance === 1.5));
const xs = flags.map((f) => f.position.x);
const gaps = xs.slice(1).map((x, i) => x - xs[i]);
check('they stand 10 m apart along the lane, the short slalom pitch',
  gaps.every((g) => near(g, 10)), gaps.map((g) => g.toFixed(1)).join(' '));
check('and 2 m off the lane, alternating, which is where those flags stand',
  flags.every((f, i) => near(Math.abs(f.position.y - 18), 2)
    && ((i % 2 === 0) === (f.position.y < 18))));

console.log('\n the triples');
function climb(name, indexes) {
  const e = byName(name);
  const got = flownOf(e.id).map((s) => `${s.apertureIndex}${s.entry > 0 ? '+' : '-'}`).join(' ');
  const want = indexes.map((i) => `${i}+`).join(' ');
  check(`${name} is a three level ladder flown ${want} from one face`,
    e && e.type === 'ladder' && e.dims.levels === 3 && got === want, got);
}
climb('Triple up', [0, 1, 2]);
climb('Triple down', [2, 1, 0]);
climb('Corkscrew', [0, 1, 2]);
const up = byName('Triple up');
const down = byName('Triple down');
check('the up stack and the down stack are 12 m apart, clear of each other\'s wrap',
  up && down && near(Math.hypot(up.position.x - down.position.x, up.position.y - down.position.y), 12),
  up && down ? Math.hypot(up.position.x - down.position.x, up.position.y - down.position.y).toFixed(1) : 'missing');
check('the corkscrew is its own stack, not a third pass at the other two',
  byName('Corkscrew').id !== up.id && byName('Corkscrew').id !== down.id);

console.log('\n the split-S');
const inn = byName('Split-S in');
const out = byName('Split-S out');
check('two dive gates', inn?.type === 'diveGate' && out?.type === 'diveGate');
check('both sit on a 5 m sill with a 5 m hole, as the posted pair does',
  inn && out && inn.dims.sillH === 5 && out.dims.sillH === 5
  && inn.dims.clearW === 5 && out.dims.clearW === 5);
check('they are 6 m apart',
  inn && out && near(Math.hypot(inn.position.x - out.position.x, inn.position.y - out.position.y), 6));
check('and they are flown from opposite faces',
  flownOf(inn.id)[0]?.entry === 1 && flownOf(out.id)[0]?.entry === -1);

console.log('\n the course it derives');
const course = courseFromDocument(raw);
check('the course derives with no warnings', (course.warnings ?? []).length === 0,
  JSON.stringify(course.warnings ?? []).slice(0, 400));
check('the lap closes, so it can be flown round and round', course.closed === true);
check('the lap is long enough to be the sequence and short enough to be one lap',
  course.lapLength > 80 && course.lapLength < 400, `${course.lapLength.toFixed(0)} m`);
const heights = course.line.map((p) => p.y);
check('the racing line stays above the ground for the whole lap',
  Math.min(...heights) > 0.2,
  `lowest ${Math.min(...heights).toFixed(2)} m, highest ${Math.max(...heights).toFixed(2)} m`);
check('and it climbs through the stacks',
  Math.max(...heights) > 4, `${Math.max(...heights).toFixed(2)} m`);
check('every element in the flying order is one that exists',
  raw.sequence.every((s) => raw.elements.some((e) => e.id === s.elementId)));

console.log('\n the shipped file is the generator\'s output');
const { spawnSync } = await import('node:child_process');
const gen = spawnSync('node', [join(root, 'scripts/ratelab-track.js'), '--check'],
  { cwd: root, encoding: 'utf8' });
check('tracks/json/ratelab.json matches scripts/ratelab-track.js', gen.status === 0,
  (gen.stdout || '').trim().split('\n').pop());

console.log(failed ? `\n${failed} failed, ${passed} passed` : `\nall ${passed} passed`);
for (const f of fails) {
  console.log(`  FAIL ${f}`);
}
process.exitCode = failed ? 1 : 0;
