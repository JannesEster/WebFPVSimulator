/*
 * longflight-check.js: a session past twenty minutes in the air keeps flying.
 *
 * WHY THIS EXISTS. On 2026-10-05 three tickets in ten minutes, bug-03ae2f2a,
 * bug-551a5c32 and bug-7f783182, carried one fault: "ReferenceError: settings
 * is not defined" in frameBody. The support prompts added that morning count
 * a session's time in the air, and past twenty minutes the frame read a bare
 * `settings`, which is not a name in the shell. So every frame in the air
 * after twenty minutes of a session threw, the shell stopped and said press
 * R, and R put the craft back in the air and into the same line. No check
 * flew long enough to reach it: every flight here is seconds long.
 *
 * So this sets the session clock half a second short of the line
 * (window.__sessionFlight), flies across it, and asks:
 *
 *   - no frame faulted (window.__frameFault);
 *   - the shell kept drawing frames past the line, because a frame that
 *     throws never reaches the count at the end of frameBody;
 *   - the clock crossed the line, so the frames did run the code;
 *   - and the prompt's trigger fired, once.
 *
 * THEN THE PROMPT ITSELF, which nothing had ever shown on purpose. With the
 * fault gone it still never appeared: it looked for a pause once, 100 ms
 * after the line, while the pilot was flying. The best lap prompt, live
 * from the same fix, sat inside the results screen, which is pointer-events
 * none, so its close button and links were holes to the page behind, and
 * it came back on every results screen after. Its Patreon link had two
 * question marks. And Off in Settings did not survive a reload. So, after
 * the line: nothing over the flight; Escape pauses and the prompt is up,
 * on the body, its close button the thing under a click, its link's tier
 * id whole; Escape resumes and it is gone; in a second session its
 * Settings button opens the Advanced room; and a stored Off is read back
 * as Off by the shell and by the prompt module, which the builder uses.
 *
 * Not deterministic to the bit, because the sticks are written on the frame
 * clock of a headless browser, so every assertion is an inequality.
 *
 * Usage: node scripts/longflight-check.js. Exit code is the number of failures.
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

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { openPage } from '../tests/lib/page.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* How far short of the line the clock is set, and how long to fly after. */
const SHORT_MS = 500;
const FLY_S = 2.5;

/* In the page: take off, set the clock short of the line, fly across it.
 * The frames are counted from the first one that sees the clock past the
 * line, because the frames before it were never in question. */
const FLY = `
  let atLine = null;
  const air = (s, line) => new Promise((done) => {
    const t0 = performance.now();
    function f() {
      const t = (performance.now() - t0) / 1000;
      window.__stick(0, 0, 0, t < 0.8 ? 0.65 : 0.5);
      if (line != null && atLine == null && window.__sessionFlight().ms >= line) {
        atLine = window.__boot().frames;
      }
      if (t < s && !window.__frameFault) {
        requestAnimationFrame(f);
      } else {
        done();
      }
    }
    requestAnimationFrame(f);
  });
  window.__stick(0, 0, 0, 0);
  await new Promise((r) => setTimeout(r, 1000));
  await air(1.5, null);
  const up = window.__ground();
  const clock = window.__sessionFlight();
  window.__sessionFlight(clock.thresholdMs - ${SHORT_MS});
  await air(${FLY_S}, clock.thresholdMs);
  const after = window.__boot().frames;
  const end = window.__sessionFlight();
  window.__stick(0, 0, 0, 0);
  const fault = window.__frameFault || null;
  return {
    airborne: !up.landed, above: up.above, thresholdMs: clock.thresholdMs,
    framesPast: atLine == null ? 0 : after - atLine, clockMs: end.ms, shown: end.shown,
    due: end.due, inFlight: document.querySelectorAll('.support-prompt').length,
    fault: fault ? fault.message : null, stack: fault ? fault.stack.split('\\n').slice(0, 3).join(' | ') : '',
  };`;

/* In the page: the prompt as a pilot would meet it. */
const PROMPT = `
  const all = document.querySelectorAll('.support-prompt');
  const p = all[0] || null;
  const hits = (n) => {
    if (!n) { return false; }
    const r = n.getBoundingClientRect();
    const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return Boolean(at) && (at === n || n.contains(at));
  };
  const link = p ? p.querySelector('.support-prompt-btn-primary') : null;
  const href = link ? link.href : '';
  return {
    screen: window.__ui.screen, count: all.length, held: window.__sessionFlight().prompt,
    onBody: Boolean(p) && p.parentNode === document.body,
    closeHits: hits(p && p.querySelector('.support-prompt-close')), linkHits: hits(link),
    href, marks: (href.match(/[?]/g) || []).length, rid: href ? new URL(href).searchParams.get('rid') : null,
    settings: Boolean(p) && [...p.querySelectorAll('button')].some((b) => b.textContent === 'Settings'),
  };`;

/* In the page: Off, stored, then read back the two ways it is read. */
const OFF = `
  const key = 'webfpv.settings.v3';
  const stored = JSON.parse(localStorage.getItem(key) || '{}');
  localStorage.setItem(key, JSON.stringify({ ...stored, supportPrompts: false }));
  const { loadSettings } = await import('/src/ui/ui.js');
  const { isPromptDisabled } = await import('/src/share/supportprompt.js');
  return { kept: loadSettings().supportPrompts, disabled: isPromptDisabled() };`;

async function main() {
  let fails = 0;
  const check = (ok, what, got) => {
    fails += ok ? 0 : 1;
    console.log(`     ${ok ? 'pass' : 'FAIL'}  ${what}${got ? `: ${got}` : ''}`);
  };
  const page = await openPage({ root: ROOT, width: 400, height: 260, url: '/index.html' });
  const { cdp, sessionId } = page;
  const ev = async (expr) => {
    const r = await cdp.send('Runtime.evaluate', {
      expression: `(async()=>{${expr}})()`, awaitPromise: true, returnByValue: true,
    }, sessionId);
    if (r.exceptionDetails) {
      throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 900));
    }
    return r.result.value;
  };
  /* Boot the shell, put the five inch on the field and fly it across the line. */
  const toTheLine = async () => {
    for (let i = 0; i < 240 && !(await ev('return !!window.__shellReady').catch(() => false)); i += 1) {
      await sleep(500);
    }
    await ev(`const ui = window.__ui; ui.settings.map = 'field'; ui.settings.airframe = '5inch';
      ui.settings.graphics = 'low'; ui.onAction('fly', ui.settings); return 1;`);
    let ready = false;
    for (let i = 0; i < 260 && !ready; i += 1) {
      const m = await ev('return window.__map ? window.__map() : null');
      ready = Boolean(m && m.ready);
      if (!ready) {
        await sleep(500);
      }
    }
    if (!ready) {
      throw new Error('the field never became ready');
    }
    await sleep(2000);
    if (!(await ev('return typeof window.__sessionFlight === "function"'))) {
      throw new Error('the shell has no window.__sessionFlight, so the clock cannot be set');
    }
    return ev(FLY);
  };
  try {
    const r = await toTheLine();
    const min = (r.thresholdMs / 60000).toFixed(0);
    console.log(`  five inch on the field, clock set ${SHORT_MS} ms short of ${min} minutes, then ${FLY_S} s in the air`);
    check(r.airborne, 'the craft was in the air when the clock was set', `${r.above.toFixed(2)} m up`);
    check(r.fault === null, 'no frame faulted', r.fault ? `${r.fault} (${r.stack})` : '');
    check(r.framesPast > 30, 'the shell kept drawing frames past the line', `${r.framesPast} frames`);
    check(r.clockMs >= r.thresholdMs, `the session clock crossed ${min} minutes`, `${(r.clockMs / 1000).toFixed(1)} s`);
    check(r.shown === true, 'the time prompt\'s trigger fired', String(r.shown));
    check(r.due === true && r.inFlight === 0, 'and it waits: nothing over the flight', `due ${r.due}, ${r.inFlight} up`);

    await page.tap('Escape');
    await page.until("window.__ui.screen === 'paused' && document.querySelectorAll('.support-prompt').length > 0", 5000)
      .catch(() => {});
    const p = await ev(PROMPT);
    check(p.screen === 'paused' && p.count === 1 && p.held === 'paused', 'Escape pauses, and the prompt is up, once',
      `${p.screen}, ${p.count} up, held on ${p.held}`);
    check(p.onBody, 'on the body, not inside a screen', '');
    check(p.closeHits && p.linkHits, 'its close button and its link are what a click lands on',
      `close ${p.closeHits}, link ${p.linkHits}`);
    check(p.marks === 1 && p.rid === '29740590', 'its Patreon link has one question mark and the tier id whole', p.href);
    check(p.settings, 'it has a Settings button', '');

    await page.tap('Escape');
    await page.until("window.__ui.screen === 'flight' && document.querySelectorAll('.support-prompt').length === 0", 5000)
      .catch(() => {});
    const q = await ev(PROMPT);
    check(q.screen === 'flight' && q.count === 0 && q.held === null, 'Escape resumes, and the prompt is gone',
      `${q.screen}, ${q.count} up`);

    /* Settings on it, which is what threw on a click in 1415c94 (a method Ui never had). The time prompt is
     * once a session, so a second session: the page again, its once a week mark cleared. */
    await ev('localStorage.removeItem("webfpv.support.prompt.v1"); return 1;');
    await cdp.send('Page.reload', {}, sessionId);
    await sleep(1500);
    await toTheLine();
    await page.tap('Escape');
    await page.until("window.__ui.screen === 'paused' && document.querySelectorAll('.support-prompt').length > 0", 5000)
      .catch(() => {});
    const opened = await ev(`const b = [...document.querySelectorAll('.support-prompt button')].find((x) => x.textContent === 'Settings');
      if (!b) { return { clicked: false }; }
      b.click();
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      return { clicked: true, screen: window.__ui.screen, count: document.querySelectorAll('.support-prompt').length };`);
    check(opened.clicked && opened.screen === 'advanced' && opened.count === 0,
      'in a second session, its Settings button opens the Advanced room and the prompt goes', JSON.stringify(opened));

    const off = await ev(OFF);
    check(off.kept === false, 'a stored Off is still Off when the settings are loaded again', String(off.kept));
    check(off.disabled === true, 'and the prompt module, which the builder uses, reads it as Off', String(off.disabled));
    const late = await ev('return window.__frameFault ? window.__frameFault.message : null');
    const uncaught = page.errors.filter((e) => e.startsWith('uncaught:'));
    check(late === null && uncaught.length === 0, 'no frame faulted and nothing threw, start to end',
      [late, ...uncaught.slice(0, 2)].filter(Boolean).join(' | '));
  } catch (e) {
    fails += 1;
    console.log(`  FAIL  the run did not complete: ${e.message}`);
  } finally {
    await page.close?.();
  }
  console.log(`\nlongflight-check: ${fails === 0 ? 'all pass' : `${fails} failed`}`);
  process.exit(fails);
}

main().catch((e) => {
  console.error(e);
  process.exit(99);
});
