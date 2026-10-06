/*
 * ratepass-check.js: prove the Rate my Rates loop actually advances.
 *
 * WHY THIS IS A BROWSER CHECK WHEN THERE IS ALREADY A NODE ONE.
 *
 * scripts/ratemyrates-check.js covers the module: 74 checks over the
 * accumulator, the fit and the coach, including the whole convergence loop
 * driven by a pilot whose hands respond to the rates. Every one of them
 * passed while the feature, in a browser, did nothing whatever.
 *
 * The bug was not in the module. It was in the two lines of src/main.js
 * that join the coach to the shell. Applying a pass is a rates change, so
 * it arrives at the settings path's staleness check one call later, and
 * that check has to be able to tell the coach's own output from the pilot
 * moving a row. It was told by a flag that the apply block cleared one line
 * BEFORE calling the settings path rather than after it. So every pass
 * reset the run: the pass counter never reached two, the history stayed
 * empty, and `opening`, which is the undo target, silently moved to
 * whatever the last pass had just applied.
 *
 * Nothing in Node could see it. The module was right, the integration was
 * wrong, and the only thing that can tell the difference is the real shell
 * with a real frame loop. So this flies one, and the assertion that matters
 * most is the one that was false: after a pass lands, `opening` is still
 * the profile the pilot arrived on.
 *
 * WHY IT DOES NOT WAIT FOR A PASS. A pass ends when a lap does. This stick
 * program never finishes a lap, on purpose: it only has to prove that stick
 * time alone does not move the rates, which is the rule the owner set after
 * a pass landed halfway round the track. The minute it used to spend waiting
 * for 25 seconds of stick movement was that old rule.
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
 * THE STICK PROGRAM, and both halves of it are about staying measurable.
 *
 * It alternates a small roll offset rather than holding one, because a held
 * offset is a roll command: five deg/s for twenty five seconds is a hundred
 * and twenty degrees of bank, and the craft would be inverted and falling
 * long before the pass filled. Alternating keeps it near level while never
 * letting the stick sit inside the dead band, so stick movement accrues at
 * very nearly one second per second and the pass fills in the time it
 * should.
 *
 * The throttle climbs. A quad that holds altitude in a town eventually
 * meets the town, and a crash stops the measurement by design, so the one
 * thing this program must not do is let that happen before the assertions
 * are read. Up is empty.
 */
const DRIVE = `(() => {
  window.__rpT0 = performance.now();
  window.__rpDrive = setInterval(() => {
    const t = (performance.now() - window.__rpT0) / 1000;
    const side = Math.sin(t * 7) > 0 ? 1 : -1;
    window.__stick(0.06 * side, 0.03 * side, 0.03 * side, 0.52);
  }, 16);
  return 'driving';
})()`;

/* Read once, into a global, so every assertion below reads ONE snapshot of
 * the coach rather than a fresh one each: the craft is still flying while
 * these run, and two assertions disagreeing because a pass landed between
 * them would be a flake nobody could reproduce. */
const SNAP = "(window.__rp = window.__rateMyRates().read, window.__rpSettings = window.__ui.settings.rates, 'snap')";

const steps = [
  'until:window.__shellReady === true && !!window.__ui',
  /* The card seats the five inch and the Rate Lab. The check starts later, from the button. */
  "eval:(window.__ui.act('way-ratemyrates'), window.__ui.screen)",
  'until:window.__boot().frames > 20',
  /* The card seats the track and does not start the check. The button does. */
  'expect:window.__ui.measuring === false',
  'expect:window.__rateMyRates().armed === false',
  /* The profile the run opens on, kept to compare the undo target against
   * at the end. This is the assertion the bug broke. */
  "eval:(window.__rpOpening = JSON.stringify(window.__rateMyRates().read.opening), 'kept')",
  "eval:(window.__ui.act('fly'), window.__ui.screen)",
  /*
   * DRIVING STARTS BEFORE THE WAIT, so the throttle is already up whenever
   * the world finishes building and the craft is never asked to hold
   * altitude at zero throttle.
   */
  'until:window.__ui.screen === "flight"',
  'eval:(document.querySelector(".rate-check").click(), "checking")',
  'expect:window.__ui.measuring === true',
  'expect:window.__rateMyRates().armed === true',
  `eval:${DRIVE}`,
  /*
   * WAIT FOR THE INTEGRATOR, NOT FOR FRAMES. The first version of this
   * waited on `window.__boot().frames` passing 80 and then on a ladder of
   * stick-movement seconds, and both failed on a town: frameBody returns
   * early for the whole of a world build, so the frame counter sits still
   * and the first rung of the ladder expires before anything has flown. The
   * check then reported FAIL while every product expectation under it was
   * green, which is the worst way for a check to be wrong.
   *
   * `seconds` only moves when the coach is actually being pushed from the
   * physics loop, so it is the one condition that means "flying and being
   * measured" rather than "the browser painted something".
   */
  'until:window.__rateMyRates().seconds > 2',
  'until:window.__rateMyRates().moveSeconds > 2',
  `eval:${SNAP}`,

  /* NO LAP, SO NOTHING MOVED. A pass that landed here would be the old
   * timer, which changed the rates halfway round. */
  'expect:window.__rp.passes.length === 0',
  'expect:window.__rp.pass === 1',
  'expect:window.__rp.state === "measuring"',
  'expect:JSON.stringify(window.__rp.opening) === window.__rpOpening',
  'expect:JSON.stringify(window.__rpSettings) === window.__rpOpening',
  'expect:JSON.stringify(window.__rp.rates) === window.__rpOpening',
  'expect:window.__rateMyRates().armed === true',

  /* And the room draws it rather than throwing. */
  "eval:(window.__ui.act('ratemyrates'), window.__ui.screen)",
  'until:window.__boot().frames > 10',
  'expect:window.__ui.screen === "ratemyrates"',
  'expect:window.__ui.items().length > 3',
  'expect:window.__ui.items().some((i) => i.action === "ratemyrates-restore")',
  "eval:(clearInterval(window.__rpDrive), window.__stick(), 'released')",
  'shot:ratepass',
];

const out = await mkdtemp(join(tmpdir(), 'webfpv-ratepass-'));
try {
  console.log('ratepass-check: one pass of the Rate my Rates loop, in the real shell');
  const run = spawnSync('node', [
    join(root, 'scripts/shots.js'),
    `--out=${out}`,
    '--w=900',
    '--h=560',
    /* The Rate Lab, which is the world the card seats. Booting it directly
     * is the load the card is about to ask for anyway. */
    '--url=/index.html?map=ratelab',
    '--graphics=high',
    ...steps,
  ], { cwd: root, encoding: 'utf8' });
  const log = `${run.stdout || ''}${run.stderr || ''}`;
  process.stdout.write(log);

  /*
   * THE VERDICT IS READ OFF THE LOG, NOT OFF THE EXIT CODE, and the reason
   * is that shots.js puts expectation failures and browser console errors
   * in one bucket and exits 1 for either.
   *
   * A refused fetch is not this check's business. The board is a server, it
   * is not running on a machine doing a headless check, and every other
   * check in this repo already says so in as many words: lint:memory prints
   * "2 network fetch(es) refused, the board is not running here" and
   * lint:shell prints the same with thirteen. Taking shots.js's exit code
   * at face value made this check report FAIL with every single one of its
   * product expectations green, which is worse than no check at all.
   *
   * Everything else still fails it: any harness fault, any failed step, and
   * any console error that is not a refused fetch. shots.js itself is left
   * alone, because its contract is shared with a dozen other checks and
   * loosening it for this one would loosen it for all of them.
   */
  const lines = log.split('\n').map((l) => l.trim());
  const faults = lines.filter((l) => l.startsWith('FAULT '));
  const stepFails = lines.filter((l) => l.startsWith('FAIL '));
  const refused = (l) => l.includes('ERR_CONNECTION_REFUSED') || l.includes('ERR_NAME_NOT_RESOLVED');
  /* shots.js puts a failed step in `errors` as well as printing it inline,
   * so the same failure arrives here twice: once as `FAIL until ...` and
   * once as `ERR until failed: ...`. Counted once, or the verdict line
   * reports five console errors for five failed expectations and sends the
   * reader looking for a browser problem that is not there. */
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
    console.log('\nPASS, stick time without a lap left the rates and the undo target where the run opened');
  }
} finally {
  await rm(out, { recursive: true, force: true });
}
