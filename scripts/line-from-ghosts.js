/*
 * line-from-ghosts.js: read the best posted lap on a board track and say
 * what line that pilot actually flew.
 *
 * A ghost is a position, not a stick. The board stores the craft's scene
 * pose at 30 Hz and a split at every gate, so the fastest lap on a track
 * is a racing line somebody flew, and the splits say which gate it was at.
 * This prints that line against the gates so a later pass can copy the
 * shape instead of inventing one.
 *
 * Usage: node scripts/line-from-ghosts.js trk-id [trk-id...]
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

import { courseFromDocument } from '../src/game/trackdoc.js';
import { decodeGhost, ghostFromBase64 } from '../src/share/ghostdata.js';

const BOARD = 'https://webfpv.org/board';

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`${res.status} ${url}`);
  }
  return res.json();
}

function hypot2(ax, az, bx, bz) {
  const dx = ax - bx;
  const dz = az - bz;
  return Math.hypot(dx, dz);
}

/* Signed area of the path against the chord from the first sample to the
 * last, in metres. Positive means the path bulged to the left of travel
 * in the scene's x-right, z-into-screen frame: left of (dx, dz) is
 * (-dz, dx). */
function bulge(samples) {
  if (samples.length < 3) {
    return { left: 0, right: 0, len: 0 };
  }
  const a = samples[0];
  const b = samples[samples.length - 1];
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const chord = Math.hypot(dx, dz) || 1;
  const lx = -dz / chord;
  const lz = dx / chord;
  let left = 0;
  let right = 0;
  let len = 0;
  let prev = a;
  let maxH = a.y;
  let minH = a.y;
  for (const p of samples) {
    const side = (p.x - a.x) * lx + (p.z - a.z) * lz;
    if (side > left) {
      left = side;
    }
    if (-side > right) {
      right = -side;
    }
    len += Math.hypot(p.x - prev.x, p.z - prev.z, p.y - prev.y);
    if (p.y > maxH) {
      maxH = p.y;
    }
    if (p.y < minH) {
      minH = p.y;
    }
    prev = p;
  }
  return { left, right, len, chord, minH, maxH };
}

async function one(id) {
  const detail = await getJson(`${BOARD}/api/tracks/${id}`);
  const docEnv = await getJson(`${BOARD}/api/tracks/${id}/document`);
  const doc = docEnv.document || docEnv;
  const times = (detail.times || []).filter((t) => t.hasGhost);
  times.sort((a, b) => a.lapMs - b.lapMs);
  const best = times[0];
  if (!best) {
    console.log(`\n${id} ${detail.name}: no ghost`);
    return;
  }
  const ghostEnv = await getJson(`${BOARD}/api/tracks/${id}/times/${best.id}/ghost`);
  const ghost = decodeGhost(ghostFromBase64(ghostEnv.ghost));
  const course = courseFromDocument(doc);
  const byId = new Map(doc.elements.map((e) => [e.id, e]));
  const stations = course.stations || [];
  console.log(`\n${detail.name} (${id})`);
  console.log(`  best ${best.name} ${(best.lapMs / 1000).toFixed(2)} s, `
    + `${times.length} ghosts, ${stations.length} stations, lap ${course.lapLength.toFixed(0)} m`);
  console.log(`  ghost ${ghost.count} samples at ${ghost.rateHz} Hz, ${ghost.splits.length} splits`);

  /* Group consecutive sequence entries that are the same stack, so a
   * triple flown three times reads as one figure. */
  const seq = doc.sequence;
  const groups = [];
  for (const s of seq) {
    const prev = groups[groups.length - 1];
    if (prev && prev.elementId === s.elementId && s.apertureIndex != null) {
      prev.entries.push(s);
    } else {
      groups.push({ elementId: s.elementId, entries: [s] });
    }
  }

  const samples = [];
  for (let i = 0; i < ghost.count; i += 1) {
    samples.push({
      x: ghost.pos[i * 3],
      y: ghost.pos[i * 3 + 1],
      z: ghost.pos[i * 3 + 2],
      t: (i * 1000) / ghost.rateHz,
    });
  }
  const atTime = (ms) => {
    let bestI = 0;
    let bestD = Infinity;
    for (let i = 0; i < samples.length; i += 1) {
      const d = Math.abs(samples[i].t - ms);
      if (d < bestD) {
        bestD = d;
        bestI = i;
      }
    }
    return bestI;
  };

  /* Splits line up with stations in flying order. A lap's last split is
   * the finish, which is the first station again, so there is one more
   * split than there are stations when the lap closes. */
  const n = Math.min(stations.length, ghost.splits.length);
  let cursor = 0;
  for (const g of groups) {
    const el = byId.get(g.elementId);
    const count = g.entries.length;
    const from = cursor === 0 ? 0 : atTime(ghost.splits[Math.max(0, cursor - 1)]);
    const toSplit = Math.min(ghost.splits.length - 1, cursor + count - 1);
    const to = atTime(ghost.splits[toSplit]);
    const slice = samples.slice(from, Math.max(from + 2, to + 1));
    const b = bulge(slice);
    const holes = g.entries.map((e) => {
      if (e.apertureIndex == null) {
        return e.passSide || 'round';
      }
      const face = e.entry > 0 ? '+' : '-';
      return `${e.apertureIndex}${face}${e.wrap ? e.wrap[0] : ''}`;
    }).join(' ');
    const near = slice.reduce((m, p) => {
      const st = stations[Math.min(cursor, stations.length - 1)];
      if (!st) {
        return m;
      }
      return Math.min(m, hypot2(p.x, p.z, st.x, st.z));
    }, Infinity);
    console.log(`  ${el?.type || '?'} ${el?.name || g.elementId}`
      + `  [${holes}]`
      + `  path ${b.len.toFixed(1)} m over ${b.chord.toFixed(1)} m chord`
      + `  bulge L ${b.left.toFixed(1)} R ${b.right.toFixed(1)}`
      + `  height ${b.minH.toFixed(1)}..${b.maxH.toFixed(1)}`
      + `  nearest gate ${near.toFixed(1)} m`);
    cursor += count;
    if (cursor >= n) {
      break;
    }
  }
}

const ids = process.argv.slice(2);
if (!ids.length) {
  console.error('usage: node scripts/line-from-ghosts.js trk-id ...');
  process.exitCode = 1;
} else {
  for (const id of ids) {
    try {
      await one(id);
    } catch (err) {
      console.log(`\n${id} FAILED ${err.message}`);
    }
  }
}
