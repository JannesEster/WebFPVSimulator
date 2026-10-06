/*
 * ratelab-check.js: prove the Rate Lab is the instrument it claims to be.
 *
 * The track exists so that two Rate my Rates passes measure the same kind
 * of flying, and every claim this rests on is a geometric property that can
 * be checked rather than eyeballed. A track whose left turn is tighter than
 * its right would quietly bias every rate profile it ever produced toward
 * one hand, and nobody flying it would be able to tell.
 *
 * So: the symmetry, the three features it was asked for, and the things
 * that make it flyable at all.
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

/*
 * IT IS A DOCUMENT THE BUILDER WOULD ACCEPT UNCHANGED.
 *
 * `normalize` repairs what it cannot read, and a repair is the builder
 * telling us the generator wrote something wrong. An empty repair list is
 * the only acceptable answer for a file this repository ships.
 */
console.log('\n the document');
const norm = normalize(raw);
const repairs = norm.repairs ?? [];
check('the builder normalises it with nothing to repair', repairs.length === 0,
  repairs.length ? JSON.stringify(repairs).slice(0, 300) : 'no repairs');
check('it is schema version 3', raw.schemaVersion === 3);
check('it is a full sized race track, not a room and not a map',
  raw.trackClass === 'full' && raw.mode === undefined);

/*
 * MIRROR SYMMETRY, WHICH IS THE WHOLE CLAIM.
 *
 * Every element that is not on the centre line has a partner at the
 * reflected x, with the reflected yaw and the same y and the same opening
 * heights. Checked by pairing them up rather than by trusting the
 * generator's mirror function, because the point of a check is to disagree
 * with the code it checks.
 */
console.log('\n the symmetry');
const W = raw.field.width;
const near = (a, b, tol = 1e-4) => Math.abs(a - b) <= tol;
const wrapPi = (a) => {
  let v = a;
  while (v > Math.PI) {
    v -= 2 * Math.PI;
  }
  while (v < -Math.PI) {
    v += 2 * Math.PI;
  }
  return v;
};
/* The grid and the two centre line gates are their own reflection, so they
 * are expected on the middle and not paired with anything. */
const onMid = raw.elements.filter((e) => near(e.position.x, W / 2, 1e-6));
const offMid = raw.elements.filter((e) => !near(e.position.x, W / 2, 1e-6));
check('the grid and the centre line gates sit exactly on the centre line',
  onMid.length >= 3 && onMid.some((e) => e.type === 'startPads'),
  `${onMid.length} on the line: ${onMid.map((e) => e.name || e.type).join(', ')}`);
check('everything else comes in pairs', offMid.length % 2 === 0, `${offMid.length} elements`);

/*
 * MIRROR SYMMETRY APPLIES TO THE TURNS AND THE LADDERS, AND NOT TO THE
 * SPIRALS, and the distinction was found by this check disagreeing with the
 * generator's own comment.
 *
 * The first version of both claimed the whole track was a reflection about
 * the centre line. It cannot be, and no amount of care in the generator
 * would have made it so: a spiral that climbs as it sweeps across the field
 * has a low end and a high end, so its reflection has them the other way
 * round and the two are not the same spiral. The check reported four gates
 * paired with sills of 0 against 4.67, which is that fact arriving.
 *
 * So the claims are separated, because they are separate claims:
 *
 *   the HAIRPINS are exact reflections, which is the one the owner asked
 *     for ("equil right and left sharp turns") and the one that matters, as
 *     an unequal pair would bias every profile the track ever produced
 *     toward one hand;
 *   the LADDERS are exact reflections in position and heading, flown in
 *     opposite senses;
 *   the SPIRALS are the same helix, the same x and the same sills, offset
 *     down the field and flown in opposite senses, so one climbs the thing
 *     the other descends. Checked below under the three features.
 *
 * A marker has no facing, so a flag's and a waypoint's yaw is not part of
 * any of this and is asserted to be zero instead.
 */
const FACING = new Set(['gate', 'flaggedGate', 'doubleStack', 'ladder', 'tower', 'diveGate', 'startPads']);
function mirrorsOf(label, group) {
  const bad = [];
  const used = new Set();
  for (const e of group) {
    if (used.has(e.id)) {
      continue;
    }
    /*
     * PAIRED BY POSITION, NOT BY NAME, and that is a correction this check
     * needed rather than the track.
     *
     * Matching "Left in" to "Right in" reported the hairpins asymmetric.
     * They are not: reflecting a hairpin swaps which of its two gates you
     * reach first, so the mirror of the left hand ENTRY gate is the right
     * hand EXIT gate. The names follow the flying order and the geometry
     * follows the reflection, and the two disagree by design. Pairing on
     * where a thing stands is the only pairing that tests the claim.
     */
    const partner = group.find((o) => !used.has(o.id) && o.id !== e.id
      && near(o.position.x, W - e.position.x)
      && near(o.position.y, e.position.y)
      && o.type === e.type);
    if (!partner) {
      bad.push(`${e.name || e.id} has nothing at the mirrored`
        + ` (${(W - e.position.x).toFixed(2)}, ${e.position.y.toFixed(2)})`);
      continue;
    }
    used.add(e.id);
    used.add(partner.id);
    /* A yaw reflected about a vertical plane is pi minus itself, wrapped,
     * because the two are the same heading written differently. */
    if (FACING.has(e.type) && !near(wrapPi(partner.yaw - (Math.PI - e.yaw)), 0, 1e-4)) {
      bad.push(`${e.name} yaw ${e.yaw.toFixed(4)} against ${partner.name} ${partner.yaw.toFixed(4)}`);
    }
    if ((e.dims.sillH ?? 0) !== (partner.dims.sillH ?? 0)) {
      bad.push(`${e.name} sill ${e.dims.sillH} against ${partner.dims.sillH}`);
    }
  }
  check(label, bad.length === 0, bad.length ? bad.join('; ') : `${used.size / 2} exact pairs`);
}

const hairpinParts = raw.elements.filter((e) => /^(Left|Right) (in|out|apex)$/.test(e.name));
check('the hairpins are six elements, three a side', hairpinParts.length === 6);
mirrorsOf('the two hairpins are exact reflections of each other, so a left hander'
  + ' and a right hander are the same manoeuvre', hairpinParts);

const ladderParts = raw.elements.filter((e) => e.type === 'ladder');
mirrorsOf('the two ladders are exact reflections in position and heading', ladderParts);

check('a marker has no facing, so its yaw is zero rather than mirrored',
  raw.elements.filter((e) => e.type === 'flag' || e.type === 'waypoint')
    .every((e) => e.yaw === 0));

/*
 * THE THREE FEATURES, BY NAME, because they were asked for by name and a
 * track that quietly lost its spirals in an edit would still be a track.
 */
console.log('\n the three features');
const byType = (t) => raw.elements.filter((e) => e.type === t);
const flownOf = (id) => raw.sequence.filter((s) => s.elementId === id);

const ladders = byType('ladder');
check('there are two three gate ladders', ladders.length === 2
  && ladders.every((l) => l.dims.levels === 3), `${ladders.length} found`);
check('each has all three of its openings in the flying order',
  ladders.every((l) => {
    const idx = flownOf(l.id).map((s) => s.apertureIndex).sort();
    return idx.length === 3 && idx[0] === 0 && idx[1] === 1 && idx[2] === 2;
  }),
  ladders.map((l) => `${l.name}: ${flownOf(l.id).map((s) => s.apertureIndex).join('')}`).join(', '));
check('and the entry direction alternates, so it is a zigzag up the stack'
  + ' rather than three passes the same way',
  ladders.every((l) => {
    const dirs = flownOf(l.id).map((s) => s.entry);
    return dirs.length === 3 && dirs[0] !== dirs[1] && dirs[1] !== dirs[2];
  }),
  ladders.map((l) => `${l.name}: ${flownOf(l.id).map((s) => (s.entry > 0 ? '+' : '-')).join('')}`).join(', '));
check('one ladder is flown bottom upward and the other top downward',
  (() => {
    const order = (l) => flownOf(l.id).map((s) => s.apertureIndex).join('');
    const orders = ladders.map(order).sort();
    return orders[0] === '012' && orders[1] === '210';
  })(),
  ladders.map((l) => `${l.name}: ${flownOf(l.id).map((s) => s.apertureIndex).join('')}`).join(', '));

const hairpinFlags = byType('flag');
check('there are two hairpin apexes', hairpinFlags.length === 2);
check('and they are flown round opposite sides, which is what makes one a'
  + ' left hander and the other a right',
  (() => {
    const sides = hairpinFlags.map((f) => flownOf(f.id)[0]?.passSide).sort();
    return sides.length === 2 && sides[0] === 'left' && sides[1] === 'right';
  })(),
  hairpinFlags.map((f) => `${f.name}: ${flownOf(f.id)[0]?.passSide}`).join(', '));

const spiralUp = raw.elements.filter((e) => e.name.startsWith('Spiral up'));
const spiralDown = raw.elements.filter((e) => e.name.startsWith('Spiral down'));
check('there is a spiral up of four gates and a spiral down of four',
  spiralUp.length === 4 && spiralDown.length === 4,
  `${spiralUp.length} up, ${spiralDown.length} down`);
const sills = (list) => list
  .sort((a, b) => Number(a.name.slice(-1)) - Number(b.name.slice(-1)))
  .map((e) => e.dims.sillH);
const upSills = sills(spiralUp);
const downSills = sills(spiralDown);
check('the sills climb through the one and fall through the other, a level at a time',
  upSills.every((v, i) => i === 0 || v > upSills[i - 1])
  && downSills.every((v, i) => i === 0 || v < downSills[i - 1]),
  `up ${upSills.map((v) => v.toFixed(2)).join(' ')}, down ${downSills.map((v) => v.toFixed(2)).join(' ')}`);
check('and the two spirals cover the same heights, so the climb and the'
  + ' descent are the same manoeuvre',
  JSON.stringify([...upSills].sort()) === JSON.stringify([...downSills].sort()));
/*
 * THE SPIRALS ARE THE SAME HELIX, not reflections of each other. Gate i of
 * the descent stands at the same x and the same sill as gate N-1-i of the
 * climb, so the pilot flies one piece of geometry twice, once up and once
 * down. This is the honest version of the symmetry claim for this part of
 * the track: see the note under the symmetry section.
 */
const upByIndex = [...spiralUp].sort((a, b) => Number(a.name.slice(-1)) - Number(b.name.slice(-1)));
const downByIndex = [...spiralDown].sort((a, b) => Number(a.name.slice(-1)) - Number(b.name.slice(-1)));
const helixBad = [];
for (let i = 0; i < downByIndex.length; i += 1) {
  const d = downByIndex[i];
  const u = upByIndex[upByIndex.length - 1 - i];
  if (!near(d.position.x, u.position.x) || d.dims.sillH !== u.dims.sillH) {
    helixBad.push(`${d.name} x ${d.position.x} sill ${d.dims.sillH}`
      + ` against ${u.name} x ${u.position.x} sill ${u.dims.sillH}`);
  }
}
check('the descent retraces the climb: same x and same sill, in reverse order',
  helixBad.length === 0, helixBad.length ? helixBad.join('; ') : `${downByIndex.length} stations`);
check('and the two spirals are at different places down the field, so the lap'
  + ' goes somewhere rather than doubling back on itself',
  Math.abs(upByIndex[0].position.y - downByIndex[downByIndex.length - 1].position.y) > 10,
  `${Math.abs(upByIndex[0].position.y - downByIndex[downByIndex.length - 1].position.y).toFixed(1)} m apart`);

/*
 * AND IT IS FLYABLE, which the builder's own course derivation decides.
 */
console.log('\n the course it derives');
const course = courseFromDocument(raw);
check('the course derives with no warnings', (course.warnings ?? []).length === 0,
  JSON.stringify(course.warnings ?? []).slice(0, 300));
check('the lap closes, so it can be flown round and round',
  course.closed === true);
check('the lap is a racing lap rather than a sprint',
  course.lapLength > 150 && course.lapLength < 600, `${course.lapLength.toFixed(0)} m`);
/*
 * THE LINE NEVER GOES UNDERGROUND. The derived spline is a Hermite through
 * the gate centres, so a stack flown in the wrong order, or a sill typed
 * with the wrong sign, puts it through the floor and the track is
 * unflyable in a way no element on its own would show.
 */
const heights = course.line.map((p) => p.y);
check('the racing line stays above the ground for the whole lap',
  Math.min(...heights) > 0.2,
  `lowest ${Math.min(...heights).toFixed(2)} m, highest ${Math.max(...heights).toFixed(2)} m`);
check('and it climbs enough to have used the ladders and the spirals',
  Math.max(...heights) > 4, `${Math.max(...heights).toFixed(2)} m`);
check('every element in the flying order is one that exists',
  raw.sequence.every((s) => raw.elements.some((e) => e.id === s.elementId)));
check('and every gate on the field is actually flown',
  raw.elements.filter((e) => e.type === 'gate' || e.type === 'ladder')
    .every((e) => flownOf(e.id).length > 0));

/* The generator is the source, so the shipped file has to be its output. */
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
