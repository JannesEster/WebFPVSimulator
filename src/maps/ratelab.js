/*
 * ratelab.js: the Rate Lab, as a map.
 *
 * A measuring instrument, not a place a pilot builds. The document is
 * tracks/json/ratelab.json, written by scripts/ratelab-track.js, and this
 * file fetches it and hands it to the same field the custom map builds.
 * It does not write the builder's autosave. Edit the track opens a copy
 * in the builder, and a later flight reads that copy back. A different
 * track sitting in the autosave is not touched.
 *
 * THE ID IS OURS, NOT 'custom'. buildFieldScene names every designed course
 * 'custom', which is right for the pilot's track and wrong here. syncWorld
 * rebuilds forever when the loaded view's id does not match the setting,
 * which is how the first wiring of this map hung the shell: the world
 * built, the id said custom, and the next frame tore it down and built it
 * again. The id is set after the build, on the object the shell compares.
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

import { buildFieldScene } from '../render/scene.js';
import { yieldToPaint } from '../ui/loading.js';
import { attachComposer } from './field.js';
import { courseFromDocument } from '../game/trackdoc.js';
import { qualityFor } from '../render/quality.js';
import { readAutosave } from '../trackbuilder/storage.js';
import { readBind } from '../share/session.js';

/* The shipped document. A copy the pilot made in the builder is bound back
 * to this id, and that copy is what gets flown. */
const RATE_LAB_ID = 'trk-ra7e1ab0';

/* Resolved against this module, so a shell mounted under /sim/ still asks
 * for the file the page was served. */
const TRACK_URL = new URL('../../tracks/json/ratelab.json', import.meta.url);

/* One fetch for the life of the page. A failure clears it, so the next
 * attempt asks again instead of replaying a rejection the network has
 * since recovered from. */
let documentPromise = null;
/* The builder's working track, when it is this course or a copy of it.
 * Anyone else's track is left where it is. Read on each build, so an edit
 * saved in the builder is what the next flight uses. */
function pilotCopy() {
  let saved = null;
  try {
    saved = readAutosave('full', 'race');
  } catch (e) {
    return null;
  }
  const doc = saved && saved.doc ? saved.doc : null;
  if (!doc || !Array.isArray(doc.elements) || !doc.sequence) {
    return null;
  }
  if (doc.id === RATE_LAB_ID) {
    return doc;
  }
  const bind = readBind(doc.id);
  if (bind && bind.sourceId === RATE_LAB_ID) {
    return doc;
  }
  return null;
}

function rateLabDocument() {
  const own = pilotCopy();
  if (own) {
    return Promise.resolve(own);
  }
  if (!documentPromise) {
    documentPromise = fetch(TRACK_URL).then((res) => {
      if (!res.ok) {
        throw new Error(`Rate Lab track could not be loaded (${res.status})`);
      }
      return res.json();
    }).catch((err) => {
      documentPromise = null;
      throw err;
    });
  }
  return documentPromise;
}

function reporter(progress) {
  return async (f) => {
    progress(f);
    await yieldToPaint();
  };
}

export async function buildMap(shell, onProgress, options) {
  const progress = onProgress ?? (() => {});
  const opts = options || {};
  const q = qualityFor(opts.quality);
  const doc = await rateLabDocument();
  const course = courseFromDocument(doc);
  if (opts.hideSponsors) {
    course.hideSponsors = true;
  }
  const map = await buildFieldScene(shell, reporter(progress), course, q);
  map.id = 'ratelab';
  map.name = doc.name || 'Rate Lab';
  map.share = null;
  map.courseKey = '';
  map.racingLine = course.line || null;
  return attachComposer(shell, map, q);
}
