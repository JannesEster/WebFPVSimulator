/*
 * ratelab-track.js: generate the Rate Lab, the track Rate my Rates flies.
 *
 * THE ORDER, as asked: a first gate, a slalom of flags, a triple stack up
 * and then one down, a triple stack corkscrewing up, then split-S gates.
 *
 * THE LINE IS NOT INVENTED. Each of those shapes is already flown on the
 * public board, and the fastest ghost on that track is a position trace at
 * 30 Hz with a split on every gate. scripts/line-from-ghosts.js reads it.
 * What was copied here is the layout those laps were flown on, not a spline
 * guessed through gate centres:
 *
 *   Slalom. "So long, Schlalom!" (trk-c0600456), AsylumFPV, 27.80 s, the
 *   best of 6 ghosts. Flags sit 2 m off the lane, clearance 1.5 m, and the
 *   early weave stays inside about 1.5 m of the straight. Spacing is the
 *   10 to 12 m chord of "Flags and cones" (trk-2397fd92), Alexulfer, 6.01 s,
 *   the best of 66 ghosts. The 14 to 16 m pitch of the long slalom does not
 *   fit a field a lap can close on.
 *
 *   Triple up, then down. "ladder-up, ladder-down" (trk-66483691), Asylum
 *   Fpv, 9.13 s. Two three-level ladders, the first flown bottom middle top
 *   all from the same face, the second top middle bottom the same way. The
 *   ghost wraps about 3.6 m out while it climbs from under 1 m to about 5 m.
 *   The stacks stand 9 m apart on that track; 12 m here keeps the two wraps
 *   from meeting.
 *
 *   Corkscrew up. The same same-face climb, which is the spiral the builder
 *   calls a corkscrew: each hole, then around the side, then the next hole
 *   from the same face. "Corkscrew" (trk-b3583898), AsylumFPV, 19.09 s, is
 *   the flown version of that orbit: single gates 2 m apart, and the ghost
 *   loops about 3 m out with a height change of about 4 m a gate.
 *
 *   Split-S. "Immelman Turn / Hammerhead" (trk-efee501b), Crapshack, 4.00 s.
 *   Two dive gates, sill 5 m, a 5 m hole, 6 m apart, opposite faces. That is
 *   the posted split-S, so these two are that pair.
 *
 * A ghost is a position, not a stick. It says where the fast lap went. It
 * does not say how much stick that pilot used to stay on it.
 *
 * Usage:
 *     node scripts/ratelab-track.js            write tracks/json/ratelab.json
 *     node scripts/ratelab-track.js --check     verify the shipped file matches
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

import { readFile, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const OUT = join(root, 'tracks/json/ratelab.json');

/* Wide enough for four flags at the posted slalom pitch, and deep enough
 * for the stacks to stand clear of that lane. */
const W = 70;
const D = 60;

/* MultiGP's 5 inch opening, the one the ladder laps were flown through. */
const CLEAR = 1.524;
const PITCH = 1.557401;

const r6 = (v) => Math.round(v * 1e6) / 1e6;

const elements = [];
const sequence = [];

function el(type, name, x, y, dims, yaw = 0, pitch = 0) {
  const id = `el-${elements.length + 1}`;
  elements.push({
    id,
    type,
    name,
    position: { x: r6(x), y: r6(y), z: 0 },
    yaw: r6(yaw),
    pitch: r6(pitch),
    yawOverridden: true,
    dims,
  });
  return id;
}

function fly(elementId, apertureIndex, entry) {
  sequence.push({
    id: `sq-${sequence.length + 1}`,
    elementId,
    apertureIndex,
    entry,
    passSide: null,
    clearance: null,
    overridden: true,
  });
}

function round(elementId, passSide, clearance) {
  sequence.push({
    id: `sq-${sequence.length + 1}`,
    elementId,
    apertureIndex: null,
    entry: null,
    passSide,
    clearance,
    overridden: true,
  });
}

function waypointAt(name, x, y, height, yaw) {
  const id = `el-${elements.length + 1}`;
  elements.push({
    id,
    type: 'waypoint',
    name,
    position: { x: r6(x), y: r6(y), z: r6(height) },
    yaw: r6(yaw),
    pitch: 0,
    yawOverridden: true,
    dims: { height: 0.1, poleRadius: 0.02, clearance: 0 },
  });
  return id;
}

function gateDims(levels, sillH, clear = CLEAR) {
  return {
    levels,
    sillH: r6(sillH),
    clearW: clear,
    clearH: clear,
    levelPitch: r6(levels > 1 ? PITCH : clear),
  };
}

/* The lane the slalom runs along, and which side of it the first flag is
 * passed. Two metres off the lane is where AsylumFPV's flags stand. */
const LANE_Y = 18;
const OFF = 2;
const FLAG_CLEAR = 1.5;

el('startPads', 'Grid', 8, LANE_Y, { pads: 4, spacing: 1.5, padSize: 0.6 }, 0);

/* Sill 1 m, so the lane sits where the slalom ghosts flew (about 1 to 2 m)
 * rather than on the grass. A Hermite between ground-level knots bows
 * under the floor; one between knots at this height does not. */
const first = el('gate', 'First', 16, LANE_Y, gateDims(1, 1), 0);
fly(first, 0, 1);

/* Four flags, 10 m apart, alternating sides. 10 m is the short end of the
 * chords Alexulfer's best lap took between flags. */
const FLAG_X = [26, 36, 46, 56];
const FLAG_SIDE = ['right', 'left', 'right', 'left'];
FLAG_X.forEach((x, i) => {
  const side = FLAG_SIDE[i];
  const y = LANE_Y + (side === 'left' ? OFF : -OFF);
  const id = el('flag', `Slalom ${i + 1}`, x, y, {
    height: 2.4, poleRadius: 0.03, clearance: FLAG_CLEAR,
  });
  round(id, side, FLAG_CLEAR);
});

/* Two triples, 12 m apart, both facing on up the field. Up is bottom to
 * top, down is top to bottom, every pass from the same face, which is how
 * Asylum Fpv's 9.13 s was flown. */
const STACK_X = 62;
/* Between the last flag and the stack, at the height the lane is flying,
 * so the flag knots are not pulled down to the stack's bottom hole. */
round(waypointAt('Onto the stack', 59, 24, 1.6, Math.atan2(30 - 24, STACK_X - 59)), null, 0);

const up = el('ladder', 'Triple up', STACK_X, 30, gateDims(3, 0), Math.PI / 2);
fly(up, 0, 1);
fly(up, 1, 1);
fly(up, 2, 1);
const down = el('ladder', 'Triple down', STACK_X, 42, gateDims(3, 0), Math.PI / 2);
fly(down, 2, 1);
fly(down, 1, 1);
fly(down, 0, 1);

/* The corkscrew: one more triple, flown the same way, so the line wraps
 * the stack on the way up. Facing back across the field. */
const cork = el('ladder', 'Corkscrew', 48, 52, gateDims(3, 0), Math.PI);
fly(cork, 0, 1);
fly(cork, 1, 1);
fly(cork, 2, 1);

/* The split-S pair, copied off the Immelman: flat gates, sill 5 m, a 5 m
 * hole, 6 m apart, opposite faces. */
const DIVE = { sillH: 5, clearH: 5, clearW: 5, levels: 1, levelPitch: 5 };
const splitIn = el('diveGate', 'Split-S in', 36, 52, DIVE, Math.PI, Math.PI / 2);
fly(splitIn, 0, 1);
const splitOut = el('diveGate', 'Split-S out', 36, 46, DIVE, 0, Math.PI / 2);
fly(splitOut, 0, -1);

/*
 * THE RETURN TO THE FIRST GATE.
 *
 * The split-S is at 8 m and the first gate is under 1 m, and one Hermite
 * between two level tangents that far apart bows through the floor. Two
 * waypoints step the line down. They are points, not gates. The heading is
 * the direction from the split-S back to the first gate, atan2 of that
 * run, so the tangent does not kink.
 */
const back = Math.atan2(18 - 46, 16 - 36);
round(waypointAt('Return high', 28, 38, 5, back), null, 0);
round(waypointAt('Return low', 22, 28, 2.5, back), null, 0);

const doc = {
  schemaVersion: 3,
  id: 'trk-ra7e1ab0',
  name: 'Rate Lab',
  createdUtc: '2026-10-06T00:00:00Z',
  modifiedUtc: '2026-10-06T00:00:00Z',
  trackClass: 'full',
  field: { width: W, depth: D, gridSize: 1 },
  settings: { tangentScale: 1.1, minCurveRadius: 2.5, samplesPerSegment: 48 },
  branding: { logos: [] },
  credit: {
    designer: 'WebFPVSimulator',
    note: 'Generated by scripts/ratelab-track.js. First gate, four slalom flags, '
      + 'a triple stack up and one down, a triple corkscrew up, then two split-S '
      + 'gates. The spacing is taken from the fastest ghosts on the same shapes '
      + 'on the public board. Edit the script, not this file.',
  },
  elements,
  sequence,
};

const text = `${JSON.stringify(doc, null, 2)}\n`;

const check = process.argv.includes('--check');
if (check) {
  const have = await readFile(OUT, 'utf8').catch(() => null);
  if (have === text) {
    console.log(`ratelab-track: ${OUT} matches the generator`);
  } else {
    console.log(`ratelab-track: ${OUT} does NOT match the generator.`);
    console.log('Run `node scripts/ratelab-track.js` and commit the result.');
    process.exitCode = 1;
  }
} else {
  await writeFile(OUT, text);
  console.log(`ratelab-track: wrote ${OUT}`);
  console.log(`  ${elements.length} elements, ${sequence.length} in the flying order,`
    + ` field ${W} by ${D} m`);
}
