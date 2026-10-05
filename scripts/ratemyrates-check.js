/*
 * ratemyrates-check.js: prove the Rate my Rates fit measures what it claims.
 *
 * WHY THIS EXISTS AT ALL, AND WHY IT EXISTS BEFORE THE SCREEN DOES. A rate
 * proposal is an opinion dressed as a number. Nobody can fly a session and
 * tell you whether the median correction was really 8 percent of travel, so
 * a bug in here does not announce itself: it ships, a pilot takes the
 * proposal, the quad feels worse, and the conclusion is that the feature is
 * useless rather than broken. The only defence is synthetic pilots whose
 * answers are known in advance.
 *
 * So each pilot below is a stick program with an analytic property, flown
 * against a craft model this file owns, and the assertion is about the
 * DIRECTION and the SIZE of what comes back. A sine of amplitude A reverses
 * at plus and minus A, so every correction it makes is 2A of travel, which
 * is why the three hover pilots can be asserted against 0.5x, 1.0x and 2.0x
 * of their centre sensitivity rather than against a recorded blob.
 *
 * WHAT IS DELIBERATELY NOT ASSERTED. Whether the proposal FEELS right. That
 * is a pilot's judgement and this file cannot have an opinion about it. What
 * it can do is prove the arithmetic is the arithmetic the comments claim,
 * that it does not depend on the frame rate, that it cannot emit a number
 * the firmware would refuse, and that the same session twice gives the same
 * answer.
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

import {
  RateSession, SESSION_GOOD_S, SESSION_THIN_S, fitRates,
} from '../src/fc/ratemyrates.js';
import {
  RATE_AXES, RATE_DEFAULTS, fullStickDeg, normaliseRates, ratesDiff, ratesShort,
} from '../configs/rates.js';
import { angleRateDeg } from '../src/fc/ratescurve.js';

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

/*
 * THE CRAFT MODELS, and there are two for a reason.
 *
 * `instant` answers the setpoint exactly, up to a ceiling. It has no state,
 * so the rotation it reports is a pure function of the stick, which is what
 * the frame rate invariant needs: any difference between a 60 Hz run and a
 * 144 Hz run is then the analyser's own and not the integrator's.
 *
 * `lagged` is a first order follower, which is what a real airframe looks
 * like for this purpose, and it is what the sustained demand and shortfall
 * logic has to survive. Its state makes it slightly frame rate dependent,
 * which is exactly why it is not the model the invariant is measured on.
 */
const instant = (ceiling) => () => (demand) => Math.min(Math.abs(demand), ceiling);

const lagged = (ceiling, tau = 0.04) => () => {
  let g = 0;
  return (demand, dt) => {
    const want = Math.min(Math.abs(demand), ceiling);
    g += (want - g) * Math.min(1, dt / tau);
    return g;
  };
};

/*
 * Fly a stick program and return the session.
 *
 * The demand is computed here the same way the module computes it, through
 * the firmware's own curve for whatever type the profile is, because the
 * craft model has to follow the setpoint the pilot's profile actually asks
 * for. A harness that fed the stick straight to the craft would be testing
 * a quad with no rate profile at all.
 */
/*
 * `dtOf` is how long THIS frame took, and it may depend on what the pilot
 * is doing. That is not a contrivance: the frames where a quad is moving
 * fast through a town are the frames with the most geometry on screen, so a
 * real session's long frames and its fast stick are correlated. See the
 * variable frame interval check, which is the one the time weighting is
 * actually for.
 */
function fly({
  prog, seconds, rates, hz = 120, craft = instant(Infinity), dtOf = null,
}) {
  const sess = new RateSession(rates);
  const r = normaliseRates(rates);
  const base = 1 / hz;
  const follow = {};
  for (const axis of RATE_AXES) {
    follow[axis] = craft();
  }
  const g = { roll: 0, pitch: 0, yaw: 0 };
  let t = 0;
  while (t < seconds) {
    const stick = prog(t);
    const dt = dtOf ? dtOf(t, stick) : base;
    for (const axis of RATE_AXES) {
      const s = stick[axis] ?? 0;
      g[axis] = follow[axis](angleRateDeg(r.type, axisSpec(r, axis), s), dt);
    }
    sess.push(dt, stick, g);
    t += dt;
  }
  return sess;
}

const clampUnit = (v) => (v < 0 ? 0 : (v > 1 ? 1 : v));

function axisSpec(r, axis) {
  const a = r[axis];
  return {
    rcRate: a.rcRate, srate: a.srate, expo: a.expo, quickRcExpo: false,
  };
}

function fit(sess, rates) {
  return fitRates(sess.stats(), rates);
}

/* A pure hover: one sine per axis, so every correction is 2A of travel. */
const hover = (A) => (t) => ({
  roll: A * Math.sin(t * 6),
  pitch: A * Math.sin(t * 5),
  yaw: A * Math.sin(t * 4),
});

/* Centre, then the stop, and nothing in between. Nothing for expo to shape. */
const snapper = (t) => {
  const phase = t % 2;
  const s = phase < 1 ? 0 : 0.98 * (Math.floor(t / 2) % 2 === 0 ? 1 : -1);
  return { roll: s, pitch: 0, yaw: 0 };
};

/* Lives in mid travel, which is the part expo shapes. */
const flowing = (t) => ({
  roll: 0.45 * Math.sin(t * 2),
  pitch: 0.4 * Math.sin(t * 1.7),
  yaw: 0.3 * Math.sin(t * 1.3),
});

/*
 * A PILOT WHOSE ANSWER LANDS NOWHERE NEAR A CLAMP, and it exists because
 * the first version of the frame rate check did not have one.
 *
 * That check compared a 60 Hz run against a 144 Hz run on two pilots whose
 * proposals both pinned against the half-rate step limit, so it was
 * comparing 335 deg/s against 335 deg/s and would have passed with the time
 * weighting torn out. A clamp hides whatever it is clamping.
 *
 * This one works the stick out to nine tenths against a capable airframe, so
 * its rate at the stop lands near the middle of the legal move, its
 * corrections are a mix of sizes rather than one size, and its mid travel
 * share is partway up. Every field it produces is free to differ, which is
 * what makes agreement between two frame rates worth asserting.
 */
const wideOpen = (t) => ({
  roll: 0.9 * Math.sin(t * 1.9) * (0.6 + 0.4 * Math.sin(t * 0.31)),
  pitch: 0.88 * Math.sin(t * 2.3) * (0.65 + 0.35 * Math.sin(t * 0.23)),
  yaw: 0.86 * Math.sin(t * 1.1) * (0.7 + 0.3 * Math.sin(t * 0.19)),
});

console.log('ratemyrates-check');

const STOCK = normaliseRates(RATE_DEFAULTS);

/*
 * THE ANCHOR, AGAINST TWO PUBLISHED NUMBERS.
 *
 * Everything the fit does is relative to the anchor, so if the anchor is
 * read wrong every proposal is wrong by the same factor and nothing else in
 * this file would notice. These two figures are stated in configs/rates.js
 * and in Betaflight's own Configurator: the ACTUAL default stops at 670
 * deg/s and the Betaflight default stops at 667, and the only reason they
 * differ is that one is 67 tens and the other is 200 times ten thirds.
 */
console.log('\n the anchor');
const bfDefault = normaliseRates({
  type: 'BETAFLIGHT',
  roll: { rcRate: 100, srate: 70, expo: 0 },
  pitch: { rcRate: 100, srate: 70, expo: 0 },
  yaw: { rcRate: 100, srate: 70, expo: 0 },
});
check('the ACTUAL default stops at 670 deg/s', fullStickDeg(STOCK, 'roll') === 670,
  `${fullStickDeg(STOCK, 'roll')}`);
check('the Betaflight default stops at 667 deg/s', fullStickDeg(bfDefault, 'roll') === 667,
  `${fullStickDeg(bfDefault, 'roll')}`);

/*
 * THE ANCHOR READ DIRECTLY, because every clamp downstream can hide it.
 *
 * The end to end test below flies one curve under two rate systems and
 * asserts the proposals match, which is the behaviour a pilot sees. It is
 * not a sharp test of the anchor: reading the slope straight off the
 * `rcRate` column instead of off the curve was caught two sections further
 * down and not here, because the centre sensitivity ceiling flattened both
 * wrong answers onto the same number. So the anchor is asserted as itself.
 *
 * 203 deg/s is the figure that makes the point. A Betaflight profile at RC
 * rate 1.00 has a slope at centre of about 200 deg/s, and the stored uint8
 * is 100. Ten times the uint8, which is what the ACTUAL column means, would
 * be 1000. A module that read the row would be five times out on this
 * profile and exactly right on an ACTUAL one, which is the sort of bug that
 * ships.
 */
const anchorOf = (r, axis) => new RateSession(r).stats()[axis].anchor;
check('the ACTUAL default anchors at 82 deg/s of slope at centre',
  Math.abs(anchorOf(STOCK, 'roll').centreDps - 82) < 1,
  `${anchorOf(STOCK, 'roll').centreDps.toFixed(1)}`);
check('the Betaflight default anchors at 203, not at its stored 100 times ten',
  Math.abs(anchorOf(bfDefault, 'roll').centreDps - 203) < 1,
  `${anchorOf(bfDefault, 'roll').centreDps.toFixed(1)}`);
check('and both anchors agree with the curve at the stop',
  Math.abs(anchorOf(STOCK, 'roll').fullDps - 670) < 1
  && Math.abs(anchorOf(bfDefault, 'roll').fullDps - 667) < 1,
  `${anchorOf(STOCK, 'roll').fullDps.toFixed(0)} and ${anchorOf(bfDefault, 'roll').fullDps.toFixed(0)}`);

/*
 * A BETAFLIGHT PROFILE AND AN ACTUAL ONE THAT FLY THE SAME CURVE MUST GET
 * THE SAME PROPOSAL.
 *
 * This is the test that the anchor is read off the CURVE and not off the
 * row, and it is the one that would have caught the obvious implementation.
 * Betaflight RC rate 1.00 with no super rate is exactly 200 times the
 * stick, and so is an ACTUAL profile whose centre sensitivity and max rate
 * are both 200. Same quad, same flight, two different sets of stored
 * uint8s. Read naively, the Betaflight row's 100 would be taken for 1000
 * deg/s of centre sensitivity and the two answers would differ by five.
 */
console.log('\n one curve, two rate systems');
const linBf = normaliseRates({
  type: 'BETAFLIGHT',
  roll: { rcRate: 100, srate: 0, expo: 0 },
  pitch: { rcRate: 100, srate: 0, expo: 0 },
  yaw: { rcRate: 100, srate: 0, expo: 0 },
});
const linActual = normaliseRates({
  type: 'ACTUAL',
  roll: { rcRate: 20, srate: 20, expo: 0 },
  pitch: { rcRate: 20, srate: 20, expo: 0 },
  yaw: { rcRate: 20, srate: 20, expo: 0 },
});
let sameCurve = true;
for (let i = 0; i <= 40; i += 1) {
  const s = -1 + i / 20;
  const d = Math.abs(angleRateDeg('BETAFLIGHT', axisSpec(linBf, 'roll'), s)
    - angleRateDeg('ACTUAL', axisSpec(linActual, 'roll'), s));
  if (d > 1e-9) {
    sameCurve = false;
  }
}
check('the two profiles are the same curve to begin with', sameCurve);
const fitBf = fit(fly({ prog: hover(0.06), seconds: 90, rates: linBf }), linBf);
const fitAc = fit(fly({ prog: hover(0.06), seconds: 90, rates: linActual }), linActual);
check('and they get the same proposal', ratesDiff(fitBf.rates) === ratesDiff(fitAc.rates),
  `${ratesShort(fitBf.rates)} against ${ratesShort(fitAc.rates)}`);
check('which is in ACTUAL whatever was flown', fitBf.rates.type === 'ACTUAL');

/*
 * CENTRE SENSITIVITY, THE THREE DIRECTIONS.
 *
 * A sine of amplitude A reverses at plus and minus A, so its corrections are
 * 2A of travel and the fit's ratio is 2A over the 0.10 target. Half the
 * target, exactly the target, and twice it.
 */
console.log('\n centre sensitivity follows the size of the corrections');
const centreOf = (r, axis) => angleRateDeg(r.type, axisSpec(r, axis), 0.02) / 0.02;
const stockCentre = centreOf(STOCK, 'roll');
for (const [name, A, want] of [['tiny', 0.025, 0.5], ['matched', 0.05, 1.0], ['coarse', 0.10, 2.0]]) {
  const f = fit(fly({ prog: hover(A), seconds: 90, rates: STOCK }), STOCK);
  const got = centreOf(f.rates, 'roll') / stockCentre;
  /* One uint8 step of an ACTUAL centre sensitivity is 10 deg/s on a stock
   * 82 deg/s anchor, which is 12 percent, so the band is one step wide
   * plus the half bin the correction histogram carries. */
  check(`${name} corrections give about ${want.toFixed(1)}x centre`,
    Math.abs(got - want) <= 0.16,
    `${got.toFixed(2)}x, median correction ${(fly({ prog: hover(A), seconds: 90, rates: STOCK }).stats().roll.correction).toFixed(3)}`);
}

/*
 * THE RATE AT THE STOP, AND THE AIRFRAME'S VETO.
 *
 * The same pilot, pinned on the stop, against two airframes. One can turn as
 * fast as the profile asks and gets offered more rate. The other cannot get
 * near it, and must NOT be offered more, because the travel it would buy
 * commands a rotation the craft cannot make. That second assertion is the
 * one a tool reading a joystick cannot make at all, and it is the reason
 * this module lives inside the simulator.
 */
console.log('\n the rate at the stop, and the airframe');
const able = fit(fly({
  prog: snapper, seconds: 90, rates: STOCK, craft: lagged(2000),
}), STOCK);
const unable = fit(fly({
  prog: snapper, seconds: 90, rates: STOCK, craft: lagged(250),
}), STOCK);
const stockFull = fullStickDeg(STOCK, 'roll');
check('a pilot on the stop whose quad keeps up is offered more rate',
  fullStickDeg(able.rates, 'roll') > stockFull,
  `${fullStickDeg(able.rates, 'roll')} against ${stockFull}`);
check('a pilot on the stop whose quad cannot is not',
  fullStickDeg(unable.rates, 'roll') < stockFull,
  `${fullStickDeg(unable.rates, 'roll')} against ${stockFull}`);
const unableStats = fly({
  prog: snapper, seconds: 90, rates: STOCK, craft: lagged(250),
}).stats();
check('and the shortfall was actually seen', unableStats.roll.unreachable > 0.5,
  `${(unableStats.roll.unreachable * 100).toFixed(0)} percent of held demand unanswered`);
check('while the able airframe saw none', fly({
  prog: snapper, seconds: 90, rates: STOCK, craft: lagged(2000),
}).stats().roll.unreachable < 0.5);

/*
 * A CRASH MUST NOT SIZE A RATE PROFILE, and this check exists because the
 * first build of this feature let one.
 *
 * Flown through the town for twelve seconds, including a building and the
 * tumble after it, it proposed double the rate on all three axes. Yaw
 * included, on a session whose yaw stick never passed six tenths of travel.
 * A cartwheeling quad rotates faster than any stick asks for, and `reach` is
 * a percentile of TIME, so a second of tumble in a short session sits well
 * inside the top one percent that percentile was meant to discard.
 *
 * Here the same gentle pilot is flown twice: once against an airframe that
 * does as it is told, and once against one that spends a fifth of the
 * session spinning at 900 deg/s regardless of the stick. The proposal must
 * not move, and the discarded share must be reported rather than hidden.
 */
console.log('\n a tumble is not a measurement of the pilot');
const tumbler = (ceiling) => () => {
  let t = 0;
  return (demand, dt) => {
    t += dt;
    /* A fifth of the session, in one second bursts, spinning hard. */
    if ((t % 5) > 4) {
      return 900;
    }
    return Math.min(Math.abs(demand), ceiling);
  };
};
const calm = fit(fly({ prog: hover(0.06), seconds: 90, rates: STOCK }), STOCK);
const thrown = fit(fly({
  prog: hover(0.06), seconds: 90, rates: STOCK, craft: tumbler(Infinity),
}), STOCK);
check('a pilot who tumbled gets the same proposal as one who did not',
  ratesDiff(calm.rates) === ratesDiff(thrown.rates),
  `${ratesShort(calm.rates)} against ${ratesShort(thrown.rates)}`);
const thrownStats = fly({
  prog: hover(0.06), seconds: 90, rates: STOCK, craft: tumbler(Infinity),
}).stats();
check('and the uncommanded rotation is reported, not hidden',
  thrownStats.roll.wildShare > 0.1 && thrownStats.roll.wildShare < 0.3,
  `${(thrownStats.roll.wildShare * 100).toFixed(0)} percent of the session`);
check('while the calm pilot reports none',
  fly({ prog: hover(0.06), seconds: 90, rates: STOCK }).stats().roll.wildShare === 0);
/*
 * AND THE FILTER MUST NOT EAT REAL FLYING, which took two goes to state
 * correctly and the first wrong version is worth keeping written down.
 *
 * It was asserted on `snapper`, and `snapper` discarded 2.4 percent of its
 * session against a band of 2. The filter was not the problem: `snapper` is
 * a SQUARE WAVE, its stick crosses from the stop to centre inside one
 * frame, and for the few tens of milliseconds afterwards the quad is still
 * turning at 600 deg/s with a demand of nothing behind it. By this rule's
 * definition that rotation is uncommanded, and by any honest reading of
 * what a human hand can do, a stick that teleports is the fixture's fault
 * and not the pilot's.
 *
 * The temptation was to widen the band to 3 percent. That is the one thing
 * CLAUDE.md forbids outright, and it would have been hiding a real question
 * behind a number. So the question is split in two instead, and each half
 * is asserted on the fixture that can actually answer it:
 *
 *   a REALISTIC stick, which takes 80 ms to cross its travel the way a
 *     thumb does, must lose almost nothing;
 *   the square wave, which is allowed to lose its decay tails, must still
 *     come back with the right rate at the stop, because preserving the
 *     fast end of the session is what the assertion was ever about.
 */
const rampedSnaps = (t) => {
  /* A 2 s cycle: cross in 80 ms, hold, cross back, rest. */
  const u = t % 2;
  const cross = (a, b, at, dur) => a + (b - a) * clampUnit((u - at) / dur);
  const s = u < 0.9 ? cross(0, 0.98, 0, 0.08) : cross(0.98, -0.98, 0.9, 0.08);
  return { roll: s, pitch: 0, yaw: 0 };
};
const ramped = fly({
  prog: rampedSnaps, seconds: 90, rates: STOCK, craft: lagged(2000),
}).stats().roll;
check('a realistic stick loses almost nothing to the filter',
  ramped.wildShare < 0.005,
  `${(ramped.wildShare * 100).toFixed(2)} percent discarded, reach ${Math.round(ramped.reach)}`);
const squared = fly({
  prog: snapper, seconds: 90, rates: STOCK, craft: lagged(2000),
}).stats().roll;
check('and the square wave still measures the rate it reached',
  squared.reach > 550, `reach ${Math.round(squared.reach)}, peak ${Math.round(squared.peak)}`);

/*
 * EXPO FOLLOWS THE TIME SPENT IN THE PART EXPO SHAPES.
 */
console.log('\n expo follows mid travel');
const flowFit = fit(fly({ prog: flowing, seconds: 90, rates: STOCK }), STOCK);
const snapFit = fit(fly({ prog: snapper, seconds: 90, rates: STOCK }), STOCK);
check('a pilot who lives in mid travel is offered expo',
  flowFit.rates.roll.expo >= 60, `${flowFit.rates.roll.expo}`);
check('a pilot who only uses centre and the stop is not',
  snapFit.rates.roll.expo <= 5, `${snapFit.rates.roll.expo}`);

/*
 * THE FRAME RATE MUST NOT REACH THE ANSWER.
 *
 * This is the invariant the time weighting exists for, and the one most
 * likely to rot: a single sample counted rather than its interval would
 * pass every other check in this file and quietly give a 144 Hz desktop a
 * different rate profile from a 60 Hz laptop. Flown on the stateless craft
 * so the only thing differing between the runs is the sampling.
 */
console.log('\n the frame rate does not reach the answer');
/*
 * THE SUBJECT MUST BE FREE TO DIFFER FIRST. A proposal sitting on the step
 * clamp agrees with itself at any frame rate, so the run is checked for
 * clamping before it is checked for agreement. See wideOpen.
 */
const fr60 = fit(fly({
  prog: wideOpen, seconds: 90, rates: STOCK, hz: 60, craft: lagged(2000),
}), STOCK);
const fr144 = fit(fly({
  prog: wideOpen, seconds: 90, rates: STOCK, hz: 144, craft: lagged(2000),
}), STOCK);
const unclamped = RATE_AXES.every((axis) => {
  const ratio = fullStickDeg(fr60.rates, axis) / fullStickDeg(STOCK, axis);
  return ratio > 0.55 && ratio < 1.9;
});
check('the pilot used for this is nowhere near the step clamp', unclamped,
  RATE_AXES.map((axis) => (fullStickDeg(fr60.rates, axis) / fullStickDeg(STOCK, axis)).toFixed(2)).join('x, ') + 'x');
check('and its expo is off both ends of its range',
  RATE_AXES.every((axis) => fr60.rates[axis].expo > 5 && fr60.rates[axis].expo < 95),
  RATE_AXES.map((axis) => fr60.rates[axis].expo).join(', '));
for (const [a, b, what] of [[fr60, fr144, 'wide open']]) {
  const worst = Math.max(...RATE_AXES.map((axis) => Math.max(
    Math.abs(a.rates[axis].rcRate - b.rates[axis].rcRate),
    Math.abs(a.rates[axis].srate - b.rates[axis].srate),
    Math.abs(a.rates[axis].expo - b.rates[axis].expo) / 10,
  )));
  check(`60 Hz and 144 Hz agree to within a uint8 step on the ${what} pilot`, worst <= 1,
    `worst field differs by ${worst.toFixed(1)}, ${ratesShort(a.rates)} against ${ratesShort(b.rates)}`);
}
/* And on the two that do clamp, because agreeing there is still required,
 * it is just not sufficient. */
for (const prog of [hover(0.06), flowing]) {
  const a = fit(fly({ prog, seconds: 90, rates: STOCK, hz: 60 }), STOCK);
  const b = fit(fly({ prog, seconds: 90, rates: STOCK, hz: 144 }), STOCK);
  check('60 Hz and 144 Hz agree on a clamped pilot too',
    ratesDiff(a.rates) === ratesDiff(b.rates), ratesShort(a.rates));
}

/*
 * A VARIABLE FRAME INTERVAL, WHICH IS THE CHECK THE TIME WEIGHTING IS FOR.
 *
 * Two constant frame rates are not enough and finding that out is worth
 * writing down. Replacing every interval with a constant 1 inside the
 * accumulator, so that samples are counted rather than weighted, left both
 * the 60 Hz and the 144 Hz proposals completely unchanged: a uniform
 * sampling of the same program has the same shape at any density, so a
 * scale factor on every bin cancels in every share and every quantile. The
 * only thing that mutation broke was the seconds on the confidence row.
 *
 * What sample counting actually breaks is a frame interval that MOVES WITH
 * THE FLYING, and that is the normal case rather than the pathological one:
 * the fast parts of a session are the parts with the most on screen. Here
 * the frames are three times longer wherever the roll stick is past half
 * travel, so counting samples would under weight exactly the travel that
 * sets the rate at the stop.
 */
const heavyWhenFast = (t, stick) => (Math.abs(stick.roll) > 0.5 ? 3 / 120 : 1 / 120);
const steady = fit(fly({
  prog: wideOpen, seconds: 90, rates: STOCK, craft: lagged(2000),
}), STOCK);
const jittery = fit(fly({
  prog: wideOpen, seconds: 90, rates: STOCK, craft: lagged(2000), dtOf: heavyWhenFast,
}), STOCK);
const varWorst = Math.max(...RATE_AXES.map((axis) => Math.max(
  Math.abs(steady.rates[axis].rcRate - jittery.rates[axis].rcRate),
  Math.abs(steady.rates[axis].srate - jittery.rates[axis].srate),
  Math.abs(steady.rates[axis].expo - jittery.rates[axis].expo) / 10,
)));
check('a frame interval that moves with the flying does not move the answer',
  varWorst <= 1,
  `worst field differs by ${varWorst.toFixed(1)}, ${ratesShort(steady.rates)} against ${ratesShort(jittery.rates)}`);

/*
 * THE SAME SESSION TWICE IS THE SAME ANSWER. Not the project's bit exact
 * determinism rule, which is about the integrator, but the same principle:
 * a pilot who runs this twice on one flight and gets two answers has no
 * reason to believe either.
 */
console.log('\n the same session gives the same answer');
const d1 = fit(fly({ prog: flowing, seconds: 60, rates: STOCK }), STOCK);
const d2 = fit(fly({ prog: flowing, seconds: 60, rates: STOCK }), STOCK);
check('two identical runs propose identical rates', ratesDiff(d1.rates) === ratesDiff(d2.rates));
check('and identical notes', JSON.stringify(d1.notes) === JSON.stringify(d2.notes));

/*
 * NOTHING THE FIRMWARE WOULD REFUSE, EVER.
 *
 * The proposal goes into a uint8 the module writes with `set`, and an out of
 * range value is a config line Betaflight rejects. normaliseRates clamps,
 * so the test is that the clamp never has to: a proposal that survives a
 * round trip through it unchanged is one the fit got right on its own.
 */
console.log('\n the proposal is always flyable');
const wild = [
  { prog: hover(0.004), seconds: 120, rates: STOCK },
  { prog: hover(0.49), seconds: 120, rates: STOCK },
  { prog: snapper, seconds: 120, rates: STOCK, craft: instant(5) },
  { prog: snapper, seconds: 120, rates: STOCK, craft: instant(4000) },
  { prog: flowing, seconds: 1, rates: STOCK },
  { prog: () => ({ roll: 0, pitch: 0, yaw: 0 }), seconds: 60, rates: STOCK },
];
let allClean = true;
let allInRange = true;
for (const w of wild) {
  const f = fit(fly(w), STOCK);
  if (ratesDiff(f.rates) !== ratesDiff(normaliseRates(f.rates))) {
    allClean = false;
  }
  for (const axis of RATE_AXES) {
    const a = f.rates[axis];
    if (!(a.rcRate >= 1 && a.rcRate <= 200 && a.srate >= 1 && a.srate <= 200
      && a.expo >= 0 && a.expo <= 100)) {
      allInRange = false;
    }
  }
}
check('every proposal round trips through normaliseRates unchanged', allClean);
check('and every field is inside the ACTUAL system\'s range', allInRange);

/*
 * AN AXIS THAT WAS NEVER TOUCHED KEEPS WHAT IT HAD.
 *
 * A pilot who flies a session without the pedals must not come back to a
 * yaw column that has been reset. The endpoints come across from the anchor
 * and the expo uint8 comes across untouched.
 */
console.log('\n an untouched axis is left alone');
const withExpo = normaliseRates({
  type: 'ACTUAL',
  roll: { rcRate: 7, srate: 67, expo: 30 },
  pitch: { rcRate: 7, srate: 67, expo: 30 },
  yaw: { rcRate: 7, srate: 67, expo: 45 },
});
const rollOnly = fit(fly({
  prog: (t) => ({ roll: 0.06 * Math.sin(t * 6), pitch: 0, yaw: 0 }),
  seconds: 90,
  rates: withExpo,
}), withExpo);
check('the untouched yaw keeps its expo', rollOnly.rates.yaw.expo === 45,
  `${rollOnly.rates.yaw.expo}`);
check('and its rate at the stop', Math.abs(fullStickDeg(rollOnly.rates, 'yaw') - 670) <= 10,
  `${fullStickDeg(rollOnly.rates, 'yaw')}`);
check('and it is reported as quiet', rollOnly.confidence.quietAxes.includes('yaw')
  && rollOnly.confidence.quietAxes.includes('pitch'),
  rollOnly.confidence.quietAxes.join(', ') || 'none');
check('while the axis that was flown did move',
  fullStickDeg(rollOnly.rates, 'roll') !== 670,
  `${fullStickDeg(rollOnly.rates, 'roll')}`);

/*
 * ONE SESSION CANNOT RUN AWAY WITH THE PROFILE.
 */
console.log('\n one session moves an axis by half or double at most');
let withinStep = true;
for (const w of wild) {
  const f = fit(fly(w), STOCK);
  for (const axis of RATE_AXES) {
    const ratio = fullStickDeg(f.rates, axis) / fullStickDeg(STOCK, axis);
    if (ratio > 2.0001 || ratio < 0.4999) {
      withinStep = false;
    }
  }
}
check('no proposal is outside half to double of what was flown', withinStep);

/*
 * HOW MUCH TO TRUST IT, AND THE SECONDS BEHIND THE WORD.
 */
console.log('\n confidence');
const thin = fit(fly({ prog: hover(0.06), seconds: 10, rates: STOCK }), STOCK);
const mid = fit(fly({ prog: hover(0.06), seconds: 40, rates: STOCK }), STOCK);
const full = fit(fly({ prog: hover(0.06), seconds: 120, rates: STOCK }), STOCK);
check(`under ${SESSION_THIN_S} s of stick movement is low`, thin.confidence.level === 'low',
  `${thin.confidence.level}, ${thin.confidence.moveSeconds.toFixed(1)} s`);
check('between the two is medium', mid.confidence.level === 'medium',
  `${mid.confidence.level}, ${mid.confidence.moveSeconds.toFixed(1)} s`);
check(`over ${SESSION_GOOD_S} s is high`, full.confidence.level === 'high',
  `${full.confidence.level}, ${full.confidence.moveSeconds.toFixed(1)} s`);

/*
 * A BACKGROUNDED TAB MUST NOT OUTVOTE A SESSION.
 *
 * requestAnimationFrame stops in a hidden tab and the next interval arrives
 * as however long the pilot was away. Weighted by that interval, one sample
 * would carry more than the flight did.
 */
console.log('\n a backgrounded tab is dropped, not weighted');
const held = new RateSession(STOCK);
for (let i = 0; i < 600; i += 1) {
  const s = { roll: 0.06 * Math.sin(i * 0.05), pitch: 0, yaw: 0 };
  held.push(1 / 120, s, { roll: 40, pitch: 0, yaw: 0 });
}
const before = ratesDiff(fit(held, STOCK).rates);
const secondsBefore = held.seconds;
held.push(45, { roll: 1, pitch: 0, yaw: 0 }, { roll: 1200, pitch: 0, yaw: 0 });
check('a 45 second interval is not counted', held.seconds === secondsBefore,
  `${held.seconds.toFixed(2)} s`);
check('and the proposal did not move', ratesDiff(fit(held, STOCK).rates) === before);

/*
 * THE SESSION KNOWS WHEN THE RATES CHANGED UNDER IT.
 */
console.log('\n a changed profile makes the session stale');
const sess = new RateSession(STOCK);
check('the profile it was built on is not stale', !sess.staleFor(STOCK));
check('an equal profile from another object is not either',
  !sess.staleFor(normaliseRates(RATE_DEFAULTS)));
check('one step on one axis is', sess.staleFor(normaliseRates({
  ...STOCK, roll: { ...STOCK.roll, srate: 66 },
})));
check('and a different rates system is', sess.staleFor(bfDefault));

console.log(failed ? `\n${failed} failed, ${passed} passed` : `\nall ${passed} passed`);
for (const f of fails) {
  console.log(`  FAIL ${f}`);
}
process.exitCode = failed ? 1 : 0;
