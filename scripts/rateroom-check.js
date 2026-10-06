/*
 * rateroom-check.js: the Rate my Rates room's rows and its two verbs.
 *
 * WHY A BROWSER CHECK, AND WHY A CHEAP ONE.
 *
 * scripts/ratemyrates-check.js covers the arithmetic and the four states'
 * wording in Node, and scripts/ratepass-check.js proves the loop actually
 * advances by flying a whole pass. Between them sits the room itself: which
 * rows it builds in each state, and what its two actions do to the pilot's
 * rate profile. Neither of the other two can see that. The row list is
 * built inside a seventeen thousand line class that needs a DOM, and the
 * actions write through the settings path.
 *
 * It is cheap because it does not fly. The probe the room reads is injected
 * through `Ui.setRateProbe`, which is the same hook src/main.js uses, so a
 * synthetic run can be handed to the room in one call and every state
 * inspected in one boot. ratepass-check pays 25 seconds of simulated stick
 * movement for one pass; this pays nothing and still covers the thing a
 * pilot actually presses.
 *
 * WHAT IT IS FOR, specifically. Two bugs in this room shipped on the
 * branch, and both were in this gap: the room rendered BLANK because the
 * screen had no DOM host, and leaving the mode STRANDED THE UNDO because the
 * only door to the room went away while the rates it had changed did not.
 * The second is asserted here directly.
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

import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

/*
 * The synthetic run, installed as the room's probe.
 *
 * `opening` is deliberately the stock profile and the passes deliberately
 * are not, so "put my old rates back" has somewhere to go and the check can
 * tell the two apart. Everything is a plain object of the shape
 * src/main.js's probe returns.
 */
const FAKE = `(() => {
  const axis = (rc, sr, ex) => ({ rcRate: rc, srate: sr, expo: ex });
  const prof = (rc, sr, ex) => ({
    type: 'ACTUAL', throttleCap: 100, thrMid: 50, thrExpo: 0,
    roll: axis(rc, sr, ex), pitch: axis(rc, sr, ex), yaw: axis(rc, sr, ex),
  });
  window.__rrOpening = prof(7, 67, 0);
  window.__rrLatest = prof(11, 50, 44);
  const pass = (n, rc, sr, ex) => ({
    pass: n, rates: prof(rc, sr, ex), moveSeconds: 25.4,
    moved: { frac: 0.12, expo: 4 }, settled: false, refused: false, wanted: null,
  });
  window.__rrInstall = (state, why, armed, passCount) => {
    window.__ui.setRateProbe(() => ({
      state, why, pass: passCount + 1, passLimit: 6, armed,
      moveSeconds: 12.3, passProgress: 0.49,
      passes: [pass(1, 10, 52, 40), pass(2, 11, 50, 44)].slice(0, passCount),
      opening: window.__rrOpening,
      rates: passCount ? window.__rrLatest : window.__rrOpening,
      drift: { frac: passCount ? 0.27 : 0, expo: 44 },
      live: null,
    }));
    window.__ui.show('ratemyrates');
    return window.__ui.items().map((i) => ({ label: i.label, action: i.action || null }));
  };
  window.__rrLabels = (s, w, a, n) => JSON.stringify(window.__rrInstall(s, w, a, n).map((i) => i.label));
  window.__rrActions = (s, w, a, n) => JSON.stringify(window.__rrInstall(s, w, a, n)
    .map((i) => i.action).filter(Boolean));
  return 'ready';
})()`;

const steps = [
  'until:window.__shellReady === true && !!window.__ui',
  `eval:${FAKE}`,

  /*
   * COLD. No run, so the room offers to start one and nothing else. The
   * important part is that it is not blank: the room shipped blank once,
   * because the screen had rows and actions and no DOM host, and every
   * assertion below would have passed while the pilot saw an empty page.
   * `items()` is the row list and the renderer is what draws it, so the
   * length is checked here and the DRAWING is checked by lint:shell, which
   * walks this screen.
   */
  "eval:window.__rrLabels('measuring', '', false, 0)",
  "expect:window.__ui.items().length >= 2",
  "expect:window.__ui.items().some((i) => i.action === 'ratemyrates-start')",
  "expect:window.__ui.items().some((i) => i.action === 'back')",

  /*
   * MEASURING, with passes behind it. Every pass gets a row, there is a way
   * out, and the undo is offered.
   */
  "eval:window.__rrLabels('measuring', '', true, 2)",
  /*
   * The two completed passes each get their own row, and the pass IN
   * PROGRESS does not get one in that table.
   *
   * Asserted on exact labels rather than on a pattern, twice over. A regex
   * does not survive being a string through a shell and then through
   * Runtime.evaluate, so `/^Pass \d+$/` arrived as the literal characters
   * backslash and d. And `startsWith('Pass ')` counted THREE, because the
   * head row of a run in progress reads "Pass 3 of up to 6" and starts the
   * same way. Both were the check being loose, not the room being wrong.
   */
  "expect:['Pass 1', 'Pass 2'].every((l) => window.__ui.items().some((i) => i.label === l))",
  "expect:!window.__ui.items().some((i) => i.label === 'Pass 3')",
  "expect:window.__ui.items()[0].label === 'Pass 3 of up to 6'",
  "expect:window.__ui.items().some((i) => i.action === 'ratemyrates-restore')",

  /*
   * DONE AND SETTLED. The head row says so, and the room offers another run
   * rather than pretending there is one in progress.
   */
  "eval:window.__rrLabels('done', 'settled', true, 2)",
  "expect:window.__ui.items()[0].label === 'Settled'",
  "expect:window.__ui.items().some((i) => i.action === 'ratemyrates-start')",

  /*
   * LEFT. The pilot pressed another card. Nothing is being measured, the
   * rates the passes applied are still on the quad, and the undo is still
   * reachable. This is the trap that shipped: the row that opens this room
   * used to vanish with the mode and take the undo with it.
   */
  "eval:window.__rrLabels('measuring', '', false, 2)",
  "expect:window.__ui.items()[0].label === 'Run left unfinished'",
  "expect:window.__ui.items().some((i) => i.action === 'ratemyrates-restore')",
  "expect:window.__ui.items().some((i) => i.action === 'ratemyrates-start')",

  /*
   * AND THE UNDO ACTUALLY UNDOES. The settings are moved to the profile the
   * last pass applied, the row is pressed, and the rate profile has to come
   * back to the one the run OPENED on, not to the pass before it: halfway
   * back is not a place anybody asked to be.
   */
  "eval:(window.__ui.settings.rates = JSON.parse(JSON.stringify(window.__rrLatest)), 'moved')",
  'expect:JSON.stringify(window.__ui.settings.rates) !== JSON.stringify(window.__rrOpening)',
  "eval:(window.__ui.act('ratemyrates-restore'), 'restored')",
  'expect:window.__ui.settings.rates.roll.rcRate === window.__rrOpening.roll.rcRate',
  'expect:window.__ui.settings.rates.roll.srate === window.__rrOpening.roll.srate',
  'expect:window.__ui.settings.rates.roll.expo === window.__rrOpening.roll.expo',

  /*
   * AND IT IS REFUSED WHEN THERE IS NOTHING TO UNDO, rather than being a
   * row that looks pressable and does nothing.
   */
  "eval:window.__rrLabels('measuring', '', false, 2)",
  "expect:window.__ui.items().find((i) => i.action === 'ratemyrates-restore').disabled === true",

  /*
   * STARTING A RUN ARMS THE MODE. The card and this row go through one
   * piece of code on purpose, so that what a session IS cannot drift apart
   * between the two.
   */
  "eval:(window.__ui.act('ratemyrates-start'), 'started')",
  'expect:window.__ui.measuring === true',
];

const out = await mkdtemp(join(tmpdir(), 'webfpv-rateroom-'));
try {
  console.log('rateroom-check: the room\'s rows and its two verbs, in the real shell');
  const run = spawnSync('node', [
    join(root, 'scripts/shots.js'),
    `--out=${out}`,
    '--w=900',
    '--h=560',
    ...steps,
  ], { cwd: root, encoding: 'utf8' });
  const log = `${run.stdout || ''}${run.stderr || ''}`;
  process.stdout.write(log);

  /* The verdict is read off the log for the reason scripts/ratepass-check.js
   * explains at length: shots.js puts expectation failures and browser
   * console errors in one bucket, and a headless check has no board to talk
   * to, so refused fetches would sink a green run. */
  const lines = log.split('\n').map((l) => l.trim());
  const faults = lines.filter((l) => l.startsWith('FAULT '));
  const stepFails = lines.filter((l) => l.startsWith('FAIL '));
  const refused = (l) => l.includes('ERR_CONNECTION_REFUSED') || l.includes('ERR_NAME_NOT_RESOLVED');
  const stepEcho = (l) => l.startsWith('ERR until failed:') || l.startsWith('ERR expect failed:');
  const realErrors = lines.filter((l) => l.startsWith('ERR ') && !refused(l) && !stepEcho(l));
  const ignored = lines.filter((l) => l.startsWith('ERR ') && refused(l)).length;
  if (ignored) {
    console.log(`note: ${ignored} network fetch(es) refused, the board is not running here`);
  }
  if (run.status === 2) {
    console.log('\nFAIL, the harness itself did not run.');
    process.exitCode = 1;
  } else if (faults.length || stepFails.length || realErrors.length) {
    console.log(`\nFAIL, ${stepFails.length} step(s), ${faults.length} fault(s),`
      + ` ${realErrors.length} console error(s). The lines above say which.`);
    process.exitCode = 1;
  } else {
    console.log('\nPASS, the room builds the right rows in all four states, the undo returns the'
      + ' profile the run opened on, and it is refused when there is nothing to undo');
  }
} finally {
  await rm(out, { recursive: true, force: true });
}
