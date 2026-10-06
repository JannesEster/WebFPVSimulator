/*
 * ratelab-track.js: generate the Rate Lab, the track Rate my Rates flies.
 *
 * WHY A TRACK AT ALL. The first version of Rate my Rates measured a
 * freestyle session, on the reasoning that natural flying is what the fit
 * wants. The owner flew it and reported the hole in that: "trying to tune
 * rates in freestyle gives most people no structure". They are right, and
 * the reason is worse than comfort. The fit compares each pass against the
 * last, so two passes are only comparable if they measured the same KIND of
 * flying. A pilot who hovered through pass one and chased rooftops through
 * pass two has handed the loop two different pilots, and the loop cannot
 * tell that from a pilot whose hands changed.
 *
 * A track fixes it by construction. Every lap asks for the same inputs in
 * the same order, so pass two differs from pass one because the RATES
 * changed and for no other reason.
 *
 * WHY IT IS GENERATED AND NOT DRAWN. The track is a measuring instrument,
 * so its properties have to be exact rather than approximately what somebody
 * dragged into place, and they are produced by functions rather than by
 * arithmetic done twice: `mirrorX` and `mirrorYaw` below. A pilot who is
 * smoother one way round than the other is then reading their own hands
 * rather than the track's bias, and that claim is worth something only if
 * nobody can typo it.
 *
 * WHAT IS AND IS NOT SYMMETRIC, stated carefully because the first version
 * of this comment overclaimed and scripts/ratelab-check.js caught it.
 *
 *   The HAIRPINS are exact reflections about the centre line. This is the
 *   one that was asked for and the one that matters: an unequal pair would
 *   bias every profile this track ever produced toward one hand.
 *
 *   The LADDERS are exact reflections in position and heading, one flown
 *   upward and one flown downward.
 *
 *   The SPIRALS ARE NOT REFLECTIONS AND CANNOT BE. A helix that climbs as it
 *   sweeps across the field has a low end and a high end, so its reflection
 *   has them the other way round and is a different helix. What they are
 *   instead is the SAME helix twice: gate i of the descent stands at the
 *   same x and the same sill as gate N-1-i of the climb, offset down the
 *   field, flown in the opposite sense. So the pilot climbs and descends
 *   through identical geometry, which is the property that was actually
 *   wanted, and the check pins that rather than a symmetry that is not
 *   there.
 *
 * WHAT IS ON IT, and all three were asked for by name.
 *
 *   SHARP TURNS, EQUAL BOTH WAYS. A hairpin round a flag on each side, at
 *   mirrored positions, entered and left through mirrored gates. Roll and
 *   yaw at full commitment, the same amount in each direction.
 *
 *   A THREE GATE LADDER, UP AND DOWN. The `ladder` element is three 5x5s
 *   stacked, and the schema lets each opening appear once in the flying
 *   order. So the left ladder is flown bottom, middle, top, alternating the
 *   entry direction, which is a vertical zigzag: pitch and throttle
 *   reversals at a fixed amplitude, which is the cleanest thing a rate fit
 *   can be given. The right ladder is the same flown top, middle, bottom.
 *
 *   A SPIRAL UP AND A SPIRAL DOWN. Four gates round an arc with the sill
 *   climbing by a level each time, then its mirror descending. Sustained
 *   co-ordinated roll, pitch and yaw, which is the part of the stick range
 *   nothing else on the track visits.
 *
 * NOTHING FLOATS. Every gate stands on the ground with `position.z` of zero
 * and its opening lifted on its own legs by `sillH`, which is the schema's
 * rule and the reason a spiral is built out of sills rather than out of
 * heights. Only the waypoints are in the air, and the schema leaves those
 * alone because a waypoint is a point and not a thing.
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

/* The field. Wider than the shipped 60 by 40 because two hairpins and two
 * spirals need the room, and the spirals need depth behind the hairpins so
 * the line is not doubling back on itself. */
const W = 70;
const D = 50;
const MID = W / 2;

/* MultiGP's 5 inch gate, which is what every other full track here uses:
 * five feet of clear width and height, in metres. */
const CLEAR = 1.524;
/* The vertical pitch between a stack's openings, from the demo document. */
const PITCH = 1.557401;

/*
 * THE MIRROR. Every element on the right half is this applied to its partner
 * on the left, so the two halves cannot drift apart. A yaw mirrored about a
 * vertical plane is pi minus itself, because yaw is measured from +x and the
 * reflection sends +x to -x and leaves +y alone.
 */
const mirrorX = (x) => W - x;
const mirrorYaw = (yaw) => Math.PI - yaw;

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

/* An aperture element's opening, in the flying order. `entry` is which way
 * through it: +1 along its own facing, -1 against. */
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

/* A marker flown round on one side, or a waypoint flown through. */
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

function gateDims(levels, sillH) {
  return {
    levels, sillH: r6(sillH), clearW: CLEAR, clearH: CLEAR, levelPitch: PITCH,
  };
}

/* A waypoint is a point in the air and is the one thing the schema does not
 * set down, which is what makes it the right tool for shaping a line over
 * the top of a stack. `height` is how far up it sits. */
function waypointAt(name, x, y, height) {
  const id = `el-${elements.length + 1}`;
  elements.push({
    id,
    type: 'waypoint',
    name,
    position: { x: r6(x), y: r6(y), z: r6(height) },
    yaw: 0,
    pitch: 0,
    yawOverridden: false,
    dims: { height: 0.1, poleRadius: 0.02, clearance: 0 },
  });
  return id;
}

/* ------------------------------------------------------------------ */
/* The grid, on the centre line, facing up the field.                  */
/* ------------------------------------------------------------------ */
el('startPads', 'Grid', MID, 4, { pads: 4, spacing: 1.5, padSize: 0.6 }, Math.PI / 2);

/* ------------------------------------------------------------------ */
/* Out of the grid, straight, so every lap starts the same way.        */
/* ------------------------------------------------------------------ */
const out = el('gate', 'Out', MID, 11, gateDims(1, 0), Math.PI / 2);
fly(out, 0, 1);

/* ------------------------------------------------------------------ */
/* THE LEFT HAIRPIN. Entered on a gate angled across the field, round a
 * flag, and out through a gate angled the other way. The flag is what
 * makes it sharp: a marker has no opening, so the line is free to come
 * as tight round it as the pilot dares.
 * ------------------------------------------------------------------ */
const HAIRPIN_Y = 20;
const HAIRPIN_IN_X = 21;
const HAIRPIN_FLAG_X = 9;
const HAIRPIN_OUT_Y = 27;
/* Angled 30 degrees off straight up the field, so the turn in is a real
 * direction change rather than a gate you can square up to. */
const HAIRPIN_IN_YAW = Math.PI / 2 + Math.PI / 6;
const HAIRPIN_OUT_YAW = Math.PI / 2 - Math.PI / 6;

const lIn = el('gate', 'Left in', HAIRPIN_IN_X, HAIRPIN_Y, gateDims(1, 0), HAIRPIN_IN_YAW);
fly(lIn, 0, 1);
const lFlag = el('flag', 'Left apex', HAIRPIN_FLAG_X, (HAIRPIN_Y + HAIRPIN_OUT_Y) / 2,
  { height: 2.4, poleRadius: 0.03, clearance: 1.5 });
round(lFlag, 'left', 1.5);
const lOut = el('gate', 'Left out', HAIRPIN_IN_X, HAIRPIN_OUT_Y, gateDims(1, 0), HAIRPIN_OUT_YAW);
fly(lOut, 0, 1);

/* ------------------------------------------------------------------ */
/* THE LADDER UP. Three openings, flown bottom, middle, top, with the
 * entry direction alternating, so the pilot zigzags up the stack. The
 * waypoints are what take them over the top of it between passes: they
 * sit a clear metre above the stack so the line goes over rather than
 * through, and they are in the air, which only a waypoint may be.
 * ------------------------------------------------------------------ */
const LADDER_X = 24;
const LADDER_Y = 35;
const LADDER_TOP = CLEAR / 2 + 2 * PITCH;
const ladderUp = el('ladder', 'Ladder up', LADDER_X, LADDER_Y, gateDims(3, 0), Math.PI / 2);
fly(ladderUp, 0, 1);
round(waypointAt('Over the ladder, first', LADDER_X, LADDER_Y + 6, LADDER_TOP + 2), null, 0);
fly(ladderUp, 1, -1);
round(waypointAt('Over the ladder, second', LADDER_X, LADDER_Y - 6, LADDER_TOP + 2), null, 0);
fly(ladderUp, 2, 1);

/* ------------------------------------------------------------------ */
/* THE SPIRAL UP. Four gates round a quarter arc at the top of the
 * field, the sill climbing one stack pitch each time, so the line is a
 * helix. Co-ordinated roll, pitch and yaw held for several seconds,
 * which nothing else on this track asks for.
 *
 * Each gate faces along the arc's tangent at its own station, computed
 * rather than typed, so the helix cannot be built facing the wrong way.
 * ------------------------------------------------------------------ */
const SPIRAL_CX = MID;
const SPIRAL_CY = D - 8;
const SPIRAL_R = 9;
const SPIRAL_N = 4;
/* Starts on the left of the arc and sweeps across the top to the right,
 * which is the direction the ladder leaves the pilot travelling. */
const SPIRAL_FROM = Math.PI;
const SPIRAL_TO = 0;

for (let i = 0; i < SPIRAL_N; i += 1) {
  const u = i / (SPIRAL_N - 1);
  const a = SPIRAL_FROM + (SPIRAL_TO - SPIRAL_FROM) * u;
  const x = SPIRAL_CX + SPIRAL_R * Math.cos(a);
  const y = SPIRAL_CY + SPIRAL_R * Math.sin(a);
  /* The tangent of a circle swept from pi to 0 points at the angle minus
   * a quarter turn, which is the heading of travel there. */
  const yaw = a - Math.PI / 2;
  const sill = i * PITCH;
  const id = el('gate', `Spiral up ${i + 1}`, x, y, gateDims(1, sill), yaw);
  fly(id, 0, 1);
}

/* ------------------------------------------------------------------ */
/* THE SPIRAL DOWN, the same arc mirrored and descending, so the climb
 * and the descent are the same manoeuvre in opposite directions. Nearer
 * the grid, so the lap closes.
 * ------------------------------------------------------------------ */
const DOWN_CY = SPIRAL_CY - 2 * SPIRAL_R - 2;
for (let i = 0; i < SPIRAL_N; i += 1) {
  const u = i / (SPIRAL_N - 1);
  /* Swept the other way round, from 0 to pi, so this is the mirror of the
   * climb and not a repeat of it. */
  const a = SPIRAL_TO + (SPIRAL_FROM - SPIRAL_TO) * u;
  const x = SPIRAL_CX + SPIRAL_R * Math.cos(a);
  const y = DOWN_CY + SPIRAL_R * Math.sin(a);
  const yaw = a + Math.PI / 2;
  const sill = (SPIRAL_N - 1 - i) * PITCH;
  const id = el('gate', `Spiral down ${i + 1}`, x, y, gateDims(1, sill), yaw);
  fly(id, 0, 1);
}

/* ------------------------------------------------------------------ */
/* THE LADDER DOWN, the left ladder mirrored, flown top to bottom.      */
/* ------------------------------------------------------------------ */
const ladderDown = el('ladder', 'Ladder down', mirrorX(LADDER_X), LADDER_Y,
  gateDims(3, 0), mirrorYaw(Math.PI / 2));
fly(ladderDown, 2, 1);
round(waypointAt('Down the ladder, first', mirrorX(LADDER_X), LADDER_Y - 6, LADDER_TOP + 2), null, 0);
fly(ladderDown, 1, -1);
round(waypointAt('Down the ladder, second', mirrorX(LADDER_X), LADDER_Y + 6, LADDER_TOP + 2), null, 0);
fly(ladderDown, 0, 1);

/* ------------------------------------------------------------------ */
/* THE RIGHT HAIRPIN, the left one mirrored exactly.                    */
/* ------------------------------------------------------------------ */
const rIn = el('gate', 'Right in', mirrorX(HAIRPIN_IN_X), HAIRPIN_OUT_Y,
  gateDims(1, 0), mirrorYaw(HAIRPIN_OUT_YAW));
fly(rIn, 0, -1);
const rFlag = el('flag', 'Right apex', mirrorX(HAIRPIN_FLAG_X), (HAIRPIN_Y + HAIRPIN_OUT_Y) / 2,
  { height: 2.4, poleRadius: 0.03, clearance: 1.5 });
round(rFlag, 'right', 1.5);
const rOut = el('gate', 'Right out', mirrorX(HAIRPIN_IN_X), HAIRPIN_Y,
  gateDims(1, 0), mirrorYaw(HAIRPIN_IN_YAW));
fly(rOut, 0, -1);

/* ------------------------------------------------------------------ */
/* Home, through the finish gate on the centre line, facing back down
 * the field so the lap closes onto the grid.
 * ------------------------------------------------------------------ */
const home = el('gate', 'Home', MID, 14, gateDims(1, 0), Math.PI / 2);
fly(home, 0, -1);

const doc = {
  schemaVersion: 3,
  /* A fixed id, because this track ships and is seated by name rather than
   * being one of a pilot's own. Eight hex digits, as the schema requires. */
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
    note: 'Generated by scripts/ratelab-track.js. The two hairpins are exact reflections '
      + 'about the centre line, so a left hand turn and a right hand turn are the same '
      + 'manoeuvre; the two ladders likewise, one flown up and one down; and the two '
      + 'spirals are the same helix flown climbing and descending. Edit the script, not '
      + 'this file.',
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
