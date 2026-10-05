/*
 * ratemyrates.js: watch a flight, then propose a rate profile from it.
 *
 * WHAT THIS IS, AND WHOSE IT IS. A pilot's rates are eleven numbers they
 * are expected to guess, and the usual advice is to copy somebody else's.
 * This measures the session instead: where on the travel the thumbs
 * actually lived, how big the corrections actually were, how fast the quad
 * actually rotated, and how long the sticks sat on the stop. Then it says
 * what profile those measurements ask for, and why, in the pilot's own
 * numbers.
 *
 * IT IS CLEAN ROOM AND IT IS OURS. WILDTYPE's RateFinder does something in
 * this territory and does it well, and its licence (RATEFINDER FREEWARE
 * LICENSE 1.0) forbids derivative works and reserves its own analysis
 * framework and its calibration exercise designs by name. None of it is
 * read, ported, approximated or renamed here. Nothing in this file came
 * from that project: the measurements below are chosen for what THIS
 * program can see and a joystick reader cannot, which is the other half of
 * the loop. See PROGRESS.md 2026-10-05 for the decision and its date.
 *
 * THE ADVANTAGE, STATED PLAINLY. A tool that reads a radio sees the sticks
 * and nothing else, so it has to infer what the quad did. This runs inside
 * the quad: Betaflight's own setpoint and the plant's own gyro are both
 * right here, so "you asked for 1000 deg/s and the airframe gave you 640"
 * is a measurement rather than a guess. That one fact is the difference
 * between advice and arithmetic, and it is why `unreachable` below exists.
 *
 * NO CURVE IS WRITTEN HERE. CLAUDE.md forbids reimplementing a rates curve
 * in JavaScript and this file obeys it. Every rate in degrees per second,
 * both the anchor read off the profile being flown and the proposal read
 * back, goes through src/fc/ratescurve.js, which is a transcription of
 * fc/rc.c that scripts/fc-trace.js F15 sweeps against the compiled module
 * for all five rate systems. This file does arithmetic on the OUTPUT of
 * that function and never on a curve of its own.
 *
 * FIXED MEMORY, TIME WEIGHTED, NOT IN THE PHYSICS PATH.
 *
 *   Fixed memory, because a session is open ended. Nothing is stored per
 *   sample: every measurement is a histogram or a running total in an array
 *   allocated once, so an hour of flying costs the same as a minute and
 *   there is nothing to run out of. The flight log (src/share/flightlog.js)
 *   keeps rows because its job is to be replayed; this one's job is to be
 *   summarised, and a summary does not need the rows.
 *
 *   Time weighted, because otherwise the answer would depend on the frame
 *   rate. Every push carries its own interval and every total is seconds
 *   rather than samples, so a 60 Hz laptop and a 144 Hz desktop measure the
 *   same session and propose the same rates. This is the only place in the
 *   program where reading a frame interval is correct, and it is correct
 *   because this is an observer: nothing here reaches the integrator, and a
 *   dropped frame costs this module a little resolution and costs the
 *   trajectory nothing. See CLAUDE.md, "Physics never reads frame time".
 *
 * ALWAYS PROPOSES ACTUAL, WHATEVER IS BEING FLOWN. The three things
 * measured are a slope at centre in deg/s, a rate at the stop in deg/s, and
 * where on the travel the time went. Those are the three columns of an
 * ACTUAL rate profile and they are not the three columns of any other
 * system: a Raceflight Acro+ number cannot be measured, it can only be
 * solved for after the deg/s are known. So the anchor is read from whatever
 * the pilot flies, through that type's own curve, and the proposal comes
 * back in ACTUAL. The screen says so rather than switching types quietly.
 *
 * This file does not talk to WebGL and does not touch the DOM.
 *
 * This file is part of WebFPVSimulator.
 *
 * WebFPVSimulator is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or (at
 * your option) any later version.
 *
 * WebFPVSimulator is distributed in the hope that it will be useful, but
 * WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU
 * General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this software. If not, see <https://www.gnu.org/licenses/>.
 */

import { RATE_AXES, normaliseRates, rateAxis } from '../../configs/rates.js';
import { angleRateDeg } from './ratescurve.js';

/*
 * Below this the stick is centred, not moved, and the sample is kept out of
 * every travel measurement.
 *
 * 0.02 of travel, which on a 40 mm gimbal is 0.8 mm. A sprung gimbal does
 * not return to the same number twice and a radio's own trims sit in here,
 * so counting this as flying would put a sleeping stick in the occupancy
 * median and drag every pilot's answer toward centre. It is a quarter of
 * the narrowest band this module resolves, so the cost of excluding it is
 * below what anything downstream can read.
 */
const IDLE = 0.02;

/* Occupancy and correction amplitude, in twentieths of travel. Twenty bins
 * is 5 percent of stick, which is finer than the uint8 the proposal lands
 * in: one step of an ACTUAL centre sensitivity is 10 deg/s, and 5 percent
 * of travel is worth less than that over most of the curve. */
const BAND_N = 20;
const BAND_W = 1 / BAND_N;

/*
 * Achieved rotation, in 10 deg/s bins to 1600.
 *
 * TEN BECAUSE TEN IS WHAT THE ANSWER IS STORED IN. An ACTUAL max rate is a
 * uint8 in tens of deg/s, so a histogram finer than 10 deg/s would be
 * resolving a distinction the proposal cannot express, and one coarser would
 * be throwing away a step the proposal can. The first version of this used
 * 25 and the smoke test caught what that costs: a hover session whose peak
 * rotation was 26 deg/s read a 99th percentile of 45, because a quantile
 * interpolated inside a 25 deg/s bin can land above everything in it. The
 * bin is now a tenth of that and `reach` is capped at `peak` besides.
 *
 * 1600 covers it at the only end that matters. Nothing in this program
 * rotates faster than about 1500, the firmware clamps its own setpoint at
 * 1998, and a sample above the top lands in the top bin and is still
 * counted.
 */
const RATE_N = 160;
const RATE_W = 10;

/*
 * WHERE THE THREE BANDS ARE, and they are bin edges rather than round
 * numbers that fall inside a bin.
 *
 * A quarter of travel and seven tenths of it, which is bands 5 and 14. The
 * lower one is where a correction stops being a correction: past a quarter
 * of the stick a pilot is placing the quad, not holding it. The upper one is
 * where the travel stops being aimed and starts being committed, which on
 * every curve in fc/rc.c is also where the rate begins to run away.
 */
const MID_LO_BAND = 5;
const MID_HI_BAND = 14;

/*
 * THE THREE TARGETS. Every one of them is a choice, so every one of them is
 * argued here rather than left as a number in a line of arithmetic.
 */

/*
 * CORRECTIONS SHOULD USE A TENTH OF THE TRAVEL.
 *
 * This is the whole of the centre sensitivity fit, so it carries the whole
 * of the argument. A correction is a stick excursion and its return, and its
 * amplitude is how much travel the pilot spent to make the quad do a small
 * thing. If the typical correction spends 3 percent of the stick, the pilot
 * is working in a thirtieth of what they have and every tremor in their hand
 * is worth a third of a correction: the rate is too high at centre and the
 * fix is to lower it so the same correction is worth more travel. If the
 * typical correction spends 30 percent, they are hauling the stick about to
 * hold a hover and the rate at centre is too low.
 *
 * A tenth is the target because it is the point at which a correction is
 * larger than any hand's noise and smaller than a deliberate placement, and
 * because it leaves the quarter-travel band below MID_LO_BAND holding two
 * and a half typical corrections, which is what a band for corrections is
 * for. It is not measured off a pilot and it is not claimed to be: it is a
 * stated target, it is the one number a pilot would want to argue with, and
 * it is here on one line so they can.
 */
const CORRECTION_TARGET = 0.10;

/*
 * A correction larger than this is not a correction. Half the travel is a
 * manoeuvre, a flip or a reversal, and its amplitude says nothing about how
 * finely the pilot wants to be able to aim. Excluded from the median so a
 * freestyle session full of full-stick flicks does not read as a pilot who
 * wants a tenth of the rate at centre.
 */
const CORRECTION_MAX = 0.5;

/*
 * CORRECTIONS GET THEIR OWN, FINER HISTOGRAM, and the reason is that a
 * median read off a histogram carries half a bin of bias.
 *
 * The occupancy histogram bins time, and time arrives in a continuous
 * spread, so interpolating inside a bin is fair. Corrections are EVENTS,
 * and a pilot's corrections cluster: a hover produces hundreds of them at
 * nearly one size. When every event lands in one bin, interpolating to the
 * middle of that bin returns the bin's centre whatever the events were, so
 * a 5 percent bin would report a pilot's 10 percent corrections as 12.5 and
 * the centre fit would be a quarter out on the one measurement it rests on.
 *
 * Half a percent of travel instead, over the half of the stick a correction
 * can occupy. A hundred bins, which is 800 bytes, and the bias is down to
 * the 2.5 percent that one uint8 step of an ACTUAL centre sensitivity
 * swallows anyway.
 */
const CORR_N = 100;
const CORR_W = CORRECTION_MAX / CORR_N;

/*
 * FULL STICK SHOULD SIT A SEVENTH ABOVE WHAT WAS REACHED.
 *
 * The proposal's rate at the stop is built from the rotation the quad
 * actually achieved, not from the rotation the old profile asked for, and
 * that is the point of measuring inside the aircraft. Headroom exists
 * because a session is not every session: a pilot who peaked at 600 should
 * not find 600 is now the ceiling the first time they commit harder than
 * they did while being measured. A seventh is enough to not feel like a wall
 * and little enough that the travel under it stays worth having.
 */
const REACH_HEADROOM = 1.15;

/*
 * Which part of the achieved rotation counts as "reached". The 99th
 * percentile of time rather than the peak, because a peak is one frame of
 * one tumble: a craft that has been thrown at the ground registers rotation
 * nobody asked for, and sizing a rate profile off a crash is how a pilot
 * ends up with a rate profile sized off a crash.
 */
const REACH_Q = 0.99;

/*
 * TIME ON THE STOP, AND WHAT IS NORMAL. Every snap ends with the stick on
 * the stop for a moment, so a couple of percent of the session there is
 * flying, not a complaint. Past that, a stick held hard against its travel
 * is a pilot waiting for a rotation to finish, which is the one unambiguous
 * sign the rate at the stop is too low, so the proposal is pushed up in
 * proportion. The gain is set so a pilot who spends a fifth of the session
 * on the stop gets about a quarter more rate, which is a step a pilot
 * notices and not a step that frightens them.
 */
const SAT_BAND = 0.95;
const SAT_FREE = 0.02;
const SAT_GAIN = 1.5;

/*
 * EXPO IS SET BY THE SHARE OF THE SESSION SPENT IN MID TRAVEL, because that
 * is the stretch of the curve expo shapes and it is the only thing expo
 * shapes. Zero expo is a straight run from the slope at centre to the rate
 * at the stop; winding it on softens the middle and leaves both ends exactly
 * where they were, which is the property ACTUAL rates exist for.
 *
 * So the question expo answers is "how much of your flying happens in the
 * part I can soften", and that is a share of time this module measures
 * directly. A pilot who spends seven tenths of the session between a quarter
 * and seven tenths of the travel is living in the middle and gets all of it.
 * Seven tenths rather than all of it because nobody spends a whole session
 * there: the stick passes through centre on the way to everything, so a
 * mid-travel share above 0.7 does not occur in a flown session and a
 * divisor that cannot be reached would put a ceiling on the answer that
 * nothing could climb to.
 */
const MID_SHARE_FULL = 0.7;

/*
 * HOW FAR ONE SESSION MAY MOVE A PROFILE. Half and double, per axis, per
 * pass.
 *
 * A short session on an unfamiliar track can measure something real and
 * unrepresentative, and the failure this prevents is a pilot flying one
 * cautious minute and being handed a third of their rates. Clamping does not
 * make a wrong answer right, it makes a wrong answer survivable: fly again
 * and the next pass moves it again, and a profile that genuinely wants to
 * move by four moves by four over two passes. The clamp is reported when it
 * bites, because a proposal that has been held back is a different claim
 * from one that has not.
 */
const STEP_MIN = 0.5;
const STEP_MAX = 2.0;

/*
 * A centre sensitivity at or above the rate at the stop is a straight line
 * with the expo column doing nothing: ACTUAL's `stickMovement` term is
 * max(0, srate*10 - rcRate*10), so the two meeting removes the only part of
 * the curve expo touches. Betaflight takes it and flies it. It is still not
 * a thing to propose, because the screen would be offering an expo row that
 * cannot change the quad. Nine tenths leaves the curve something to shape.
 */
const CS_CEILING = 0.9;

/*
 * WHEN A DEMAND COUNTS AS UNREACHABLE. The quad lags the stick by tens of
 * milliseconds at the best of times, so every reversal spends a moment with
 * the setpoint far above the gyro and none of those moments mean anything.
 * A demand has to be HELD past SUSTAIN_S before its shortfall is counted,
 * and it has to be a demand worth holding: under FAST_DPS a shortfall is
 * propwash or a nudge, not a ceiling.
 */
const SUSTAIN_S = 0.12;
const FAST_DPS = 300;
const SHORTFALL = 0.6;

/*
 * ROTATION NOBODY ASKED FOR IS NOT A MEASUREMENT OF THE PILOT.
 *
 * This was found by flying it. A synthetic pilot flown through the town for
 * twelve seconds, which included hitting a building and tumbling, came back
 * with a proposal of double the rate on all three axes, yaw included, on a
 * session whose yaw stick never left six tenths of travel. The tumble was
 * the whole of it: a crashed quad rotates faster than any stick commands,
 * and `reach` is a 99th percentile of TIME, so a second and a half of
 * cartwheel in a twelve second session is far above the one percent tail
 * that percentile was chosen to discard.
 *
 * So the rotation histogram takes a sample only when the rotation is
 * plausibly the one that was commanded. Half again over the demand, plus a
 * floor, which between them pass the three things that are not a crash:
 *
 *   the lag at the start of an input, where the gyro is BELOW the demand
 *     and has never been the problem;
 *   the overshoot at the end of one, where a well tuned quad crosses its
 *     setpoint by a few percent and a soft one by rather more;
 *   propwash, a clipped branch, a scrape along a wall, which are real
 *     flying and produce real rotation near centre stick.
 *
 * The floor is what makes the near centre case work at all: at a centred
 * stick the demand is nearly zero, so a pure ratio would discard every
 * disturbance a pilot ever corrects for and the measurement would only ever
 * see deliberate inputs. 150 deg/s is about what a five inch picks up off
 * its own wake and off a knock; a cartwheel is several times it.
 *
 * NOT A CRASH FLAG, and that is deliberate. The shell knows when it has
 * declared a crash and could pass a flag down, and that would miss the
 * cases that matter most: clipping a gate strut, catching a prop on a wall,
 * the half second after a hard knock while the quad is still spinning.
 * Those are not crashes and they are not the pilot either. A rule about
 * what the quad is doing against what it was told covers all of it and is
 * testable without a browser.
 */
const UNCOMMANDED_RATIO = 1.5;
const UNCOMMANDED_FLOOR = 150;

/*
 * AGAINST THE DEMAND OF A MOMENT AGO, NOT THE DEMAND OF THIS INSTANT, and
 * this correction is the second thing testing found.
 *
 * Compared instant against instant, the rule above throws away every
 * REVERSAL. Halfway through a roll reversal the stick is passing through
 * centre, so the demand is nothing, while the quad is still turning at 600
 * deg/s because it cannot stop instantly. By an instantaneous reading that
 * is uncommanded rotation. It is the exact opposite: it is the rotation the
 * pilot asked for, still arriving.
 *
 * Measured, a committed pilot lost 2.4 percent of the session to this, and
 * a pilot whose stick crossed in a realistic 80 ms lost 3.4, which is worse
 * because a slower crossing spends longer near centre. Both numbers are the
 * same defect and neither is a threshold to widen.
 *
 * So the comparison is against a HELD PEAK of the demand, decaying. What
 * the pilot asked for in the last fraction of a second is what the quad is
 * allowed to still be doing. The decay is in deg/s per second and is set so
 * a full stick demand's licence is spent in a little over a quarter of a
 * second, which is long enough for any airframe here to finish a reversal
 * and far short of a tumble: a crashed quad spins for whole seconds with
 * nothing behind it, and a quarter of a second into that the licence is
 * gone and the rest of the cartwheel is discarded.
 */
const DEMAND_DECAY = 2500;

/* Where the anchor's slope at centre is read. Small enough that every
 * curve in fc/rc.c is still straight at it, large enough that the division
 * below is nowhere near the floating point floor. */
const CENTRE_EPS = 0.02;

/* How long a session has to run before its answer is worth printing, and
 * where it stops being thin. Both are seconds of stick movement rather
 * than seconds of wall clock, so a pilot who spent two minutes parked on the
 * ground has not accidentally earned a confident answer. */
export const SESSION_THIN_S = 20;
export const SESSION_GOOD_S = 60;

function clamp(v, lo, hi) {
  if (v < lo) {
    return lo;
  }
  return v > hi ? hi : v;
}

/* Which band a value in 0..1 lands in. The top edge belongs to the top
 * band rather than to a band that does not exist. */
function bandOf(v, n, w) {
  const i = Math.floor(v / w);
  return i >= n ? n - 1 : (i < 0 ? 0 : i);
}

/*
 * A quantile read off a histogram of time, interpolated inside the bin it
 * lands in.
 *
 * Interpolated rather than snapped to the bin edge because the bins are
 * coarse on purpose: 25 deg/s of rotation is a bin, and an un-interpolated
 * 99th percentile would move in 25 deg/s jumps as a session grew, so two
 * sessions that measured the same pilot could differ by a bin for no reason
 * the pilot could see.
 */
function quantile(hist, total, q, w) {
  if (!(total > 0)) {
    return 0;
  }
  const want = total * q;
  let seen = 0;
  for (let i = 0; i < hist.length; i += 1) {
    const h = hist[i];
    if (seen + h >= want) {
      /* Where in this bin the wanted time falls. An empty bin cannot be the
       * one we stopped in, so the division is safe. */
      const within = h > 0 ? (want - seen) / h : 0;
      return (i + within) * w;
    }
    seen += h;
  }
  return hist.length * w;
}

/* Time in a span of bands, as a share of the whole. */
function shareOf(hist, total, lo, hi) {
  if (!(total > 0)) {
    return 0;
  }
  let sum = 0;
  for (let i = lo; i < hi && i < hist.length; i += 1) {
    sum += hist[i];
  }
  return sum / total;
}

/*
 * One axis of the session, accumulating.
 *
 * Every field is a number or a preallocated array and nothing is ever
 * pushed, so this object's size is settled in its constructor. See the
 * header on fixed memory.
 */
class AxisTally {
  constructor() {
    this.travel = new Float64Array(BAND_N);
    this.rate = new Float64Array(RATE_N);
    this.corr = new Float64Array(CORR_N);
    this.reset();
  }

  reset() {
    this.travel.fill(0);
    this.rate.fill(0);
    this.corr.fill(0);
    this.time = 0;
    this.moveTime = 0;
    this.satTime = 0;
    this.peak = 0;
    /* Time whose rotation was plausibly the commanded one, which is what
     * the rotation histogram is a distribution over, and time whose was
     * not. See UNCOMMANDED_RATIO. */
    this.rateTime = 0;
    this.wildTime = 0;
    /* The decaying held peak of the demand: see DEMAND_DECAY. */
    this.demandHold = 0;
    this.corrCount = 0;
    this.corrTime = 0;
    /* The half cycle in progress: which way the stick is going, the most
     * extreme place it has reached going that way, and where it turned to
     * start this one. Signed, because a reversal is a change of sign of
     * travel and not of position. */
    this.dir = 0;
    this.extreme = 0;
    this.lastTurn = 0;
    /* How long the demand has been held above FAST_DPS, and the shortfall
     * seen once it has been held long enough. */
    this.heldS = 0;
    this.fastTime = 0;
    this.shortTime = 0;
  }

  /*
   * One sample. `stick` is signed travel in -1..1, `demand` is what the
   * profile being flown asks for at that stick in deg/s, and `achieved` is
   * what the craft did, as a MAGNITUDE.
   *
   * MAGNITUDES, AND THAT IS DELIBERATE. The ABI's pitch channel and its
   * pitch gyro have opposite signs by convention (bf_glue.c builds
   * rcData[PITCH] as 1500 minus the channel, which is why
   * src/share/flightlog.js negates the same column on its way out). A
   * module that compared them signed would be one convention change away
   * from reporting every pitch input as a total failure to rotate. Nothing
   * here needs the sign of the rotation: the reversal detector takes its
   * sign from the stick alone, and the shortfall is a comparison of sizes.
   */
  push(dtS, stick, demandDps, achievedDps) {
    this.time += dtS;
    const mag = stick < 0 ? -stick : stick;
    const demand = demandDps < 0 ? -demandDps : demandDps;
    /*
     * THE ROTATION, IF IT WAS THE ROTATION THAT WAS ASKED FOR. A tumble, a
     * wall or a prop strike produces more than any stick commanded, and
     * sizing a rate profile off it sizes it off a crash. See
     * UNCOMMANDED_RATIO. The peak is filtered too: the airframe's veto
     * reads it, and a veto measured against a cartwheel is no veto.
     */
    this.demandHold = Math.max(demand, this.demandHold - DEMAND_DECAY * dtS);
    if (achievedDps <= this.demandHold * UNCOMMANDED_RATIO + UNCOMMANDED_FLOOR) {
      this.rateTime += dtS;
      if (achievedDps > this.peak) {
        this.peak = achievedDps;
      }
      this.rate[bandOf(achievedDps / RATE_W, RATE_N, 1)] += dtS;
    } else {
      this.wildTime += dtS;
    }
    /*
     * SUSTAINED DEMAND, THEN SHORTFALL. The hold has to survive the whole
     * of SUSTAIN_S before any of its time is counted, so the lag at the
     * start of every input is excluded rather than averaged in.
     */
    if (demand >= FAST_DPS) {
      this.heldS += dtS;
      if (this.heldS >= SUSTAIN_S) {
        this.fastTime += dtS;
        if (achievedDps < demand * SHORTFALL) {
          this.shortTime += dtS;
        }
      }
    } else {
      this.heldS = 0;
    }
    if (mag <= IDLE) {
      return;
    }
    this.moveTime += dtS;
    this.travel[bandOf(mag, BAND_N, BAND_W)] += dtS;
    if (mag >= SAT_BAND) {
      this.satTime += dtS;
    }
    this.corrTime += dtS;
    this.turn(stick);
  }

  /*
   * The reversal detector, and the only stateful thing in this module.
   *
   * A half cycle runs from one turning point to the next. While the stick
   * keeps going the same way, `extreme` follows it. When it retraces from
   * `extreme` by more than the hysteresis, the half cycle has ended: its
   * amplitude is the peak to peak travel it covered, and a new one starts at
   * the turning point.
   *
   * THE HYSTERESIS IS NOT OPTIONAL. A gimbal at rest wanders by a few
   * thousandths and a frame boundary is not a filter, so a detector without
   * one would register hundreds of reversals a second on a stick nobody is
   * touching and report a median correction of nothing. Half of IDLE is the
   * smallest retrace that cannot be a stick sitting still.
   */
  turn(stick) {
    const hyst = IDLE / 2;
    if (this.dir === 0) {
      this.dir = stick >= this.lastTurn ? 1 : -1;
      this.extreme = stick;
      return;
    }
    if (this.dir > 0) {
      if (stick > this.extreme) {
        this.extreme = stick;
        return;
      }
      if (this.extreme - stick > hyst) {
        this.closeHalfCycle();
        this.dir = -1;
      }
      return;
    }
    if (stick < this.extreme) {
      this.extreme = stick;
      return;
    }
    if (stick - this.extreme > hyst) {
      this.closeHalfCycle();
      this.dir = 1;
    }
  }

  closeHalfCycle() {
    const amp = Math.abs(this.extreme - this.lastTurn);
    this.lastTurn = this.extreme;
    if (amp < CORR_W) {
      /* Under one band. Counted as a reversal, because it is one, but it
       * has no amplitude this module can resolve. */
      this.corrCount += 1;
      return;
    }
    this.corrCount += 1;
    if (amp <= CORRECTION_MAX) {
      this.corr[bandOf(amp, CORR_N, CORR_W)] += 1;
    }
  }

  /* What was measured, as plain numbers. No histograms escape: a caller
   * that wanted one would be a caller doing this module's job. */
  read() {
    const corrTotal = this.corr.reduce((a, b) => a + b, 0);
    return {
      seconds: this.time,
      moveSeconds: this.moveTime,
      /* Where the travel went. */
      medianTravel: quantile(this.travel, this.moveTime, 0.5, BAND_W),
      centreShare: shareOf(this.travel, this.moveTime, 0, MID_LO_BAND),
      midShare: shareOf(this.travel, this.moveTime, MID_LO_BAND, MID_HI_BAND),
      outerShare: shareOf(this.travel, this.moveTime, MID_HI_BAND, BAND_N),
      satShare: this.moveTime > 0 ? this.satTime / this.moveTime : 0,
      /*
       * What the craft did.
       *
       * REACH CANNOT EXCEED PEAK, and the cap is here rather than left to
       * arithmetic because the two are printed side by side. A quantile
       * interpolated inside a bin can land above every sample in that bin,
       * so a session that peaked at 26 deg/s read "reached 45, peak 26" on
       * the first smoke test: two numbers on one line contradicting each
       * other, which is worse than either being slightly wrong.
       */
      reach: Math.min(quantile(this.rate, this.rateTime, REACH_Q, RATE_W), this.peak),
      peak: this.peak,
      /* How much of the session the quad was doing something it was not
       * told to. Reported rather than silently dropped: a pilot who spent a
       * third of their flight tumbling has measured a third of a flight,
       * and the room says so. */
      wildShare: this.time > 0 ? this.wildTime / this.time : 0,
      /* How the corrections were shaped. */
      correction: corrTotal > 0 ? quantile(this.corr, corrTotal, 0.5, CORR_W) : 0,
      corrections: corrTotal,
      reversals: this.corrCount,
      corrPerSecond: this.corrTime > 0 ? this.corrCount / this.corrTime : 0,
      /* How much of the held demand the airframe could not deliver. */
      unreachable: this.fastTime > 0 ? this.shortTime / this.fastTime : 0,
      fastSeconds: this.fastTime,
    };
  }
}

/*
 * A session, open until it is read.
 *
 * Constructed with the profile being flown, because every measurement is
 * relative to it: the anchor's slope at centre and rate at the stop are what
 * the proposal is a change FROM, and a session whose rates changed under it
 * is measuring two different quads. Changing the rates restarts it, and the
 * caller is told so rather than left to notice.
 */
export class RateSession {
  constructor(rates) {
    this.axes = { roll: new AxisTally(), pitch: new AxisTally(), yaw: new AxisTally() };
    this.reset(rates);
  }

  reset(rates) {
    for (const axis of RATE_AXES) {
      this.axes[axis].reset();
    }
    this.rates = normaliseRates(rates);
    /* The anchor, evaluated once per reset rather than per sample: it is a
     * property of the profile, and the profile cannot change without this
     * being called. */
    this.anchor = anchorOf(this.rates);
  }

  /*
   * True when the profile handed in is not the one being measured. The
   * caller resets on it; this module does not reset itself, because a
   * silent restart is a session a pilot thinks they flew.
   */
  staleFor(rates) {
    const want = normaliseRates(rates);
    if (want.type !== this.rates.type) {
      return true;
    }
    return RATE_AXES.some((axis) => {
      const a = want[axis];
      const b = this.rates[axis];
      return a.rcRate !== b.rcRate || a.srate !== b.srate || a.expo !== b.expo;
    });
  }

  /* Longest axis, which is the session's length: a pilot who flew a minute
   * without touching the yaw still flew a minute. */
  get seconds() {
    return Math.max(...RATE_AXES.map((axis) => this.axes[axis].time));
  }

  get moveSeconds() {
    return Math.max(...RATE_AXES.map((axis) => this.axes[axis].moveTime));
  }

  /*
   * One frame.
   *
   * `stick` carries signed travel in -1..1 per axis, the same numbers the
   * module was handed. `gyroDps` carries the magnitude of the body rate per
   * axis in deg/s. The demand is computed here, from the stick and the
   * profile, through the firmware's own curve.
   */
  push(dtS, stick, gyroDps) {
    if (!(dtS > 0) || dtS > 1) {
      /* A tab that was in the background for a minute arrives as one
       * enormous interval, and weighting a single sample by sixty seconds
       * would let one frame outvote a whole session. Dropped rather than
       * clamped, because the samples it stands for were never taken. */
      return;
    }
    for (let i = 0; i < RATE_AXES.length; i += 1) {
      const axis = RATE_AXES[i];
      const s = clamp(Number(stick[axis]) || 0, -1, 1);
      const g = Math.abs(Number(gyroDps[axis]) || 0);
      const demand = angleRateDeg(this.rates.type, this.anchor[axis].spec, s);
      this.axes[axis].push(dtS, s, demand, g);
    }
  }


  stats() {
    const out = {
      seconds: this.seconds,
      moveSeconds: this.moveSeconds,
      type: this.rates.type,
    };
    for (const axis of RATE_AXES) {
      out[axis] = { ...this.axes[axis].read(), anchor: this.anchor[axis] };
    }
    return out;
  }
}

/*
 * The profile being flown, read as deg/s, through its own curve.
 *
 * WHY A SLOPE AND NOT A NUMBER OFF THE ROW. The pilot may be on any of the
 * five systems, and only ACTUAL has a column that IS the slope at centre: a
 * Betaflight RC rate of 1.00 and an ACTUAL centre sensitivity of 70 are the
 * same stored uint8 and not the same quantity. So the slope is measured off
 * the curve the same way a pilot would measure it, by asking what the quad
 * does at a stick position near centre and dividing. That works for all five
 * systems without this module knowing which one it is looking at.
 */
function anchorOf(rates) {
  const out = {};
  for (const axis of RATE_AXES) {
    const spec = rateAxis(rates, axis);
    const near = angleRateDeg(rates.type, spec, CENTRE_EPS);
    out[axis] = {
      spec,
      centreDps: near / CENTRE_EPS,
      fullDps: angleRateDeg(rates.type, spec, 1),
    };
  }
  return out;
}

/* CLI uint8 from deg/s, at the resolution the firmware actually holds:
 * ACTUAL's two deg/s columns are stored in tens, so 675 is not a rate a
 * quad can be given. configs/rates.js makes the same rounding when a pilot
 * types one. */
function tensOf(dps, lo, hi) {
  return clamp(Math.round(dps / 10), lo, hi);
}

/*
 * The fit.
 *
 * Three independent decisions per axis, each from one measurement, each
 * reported with the number it came from. Independent on purpose: a fit that
 * solved all three together would be a fit nobody could argue with one third
 * of, and the whole value of this screen is that a pilot can read a line,
 * disagree with it, and move one row.
 *
 * Returns the proposal, the per axis notes, and what is known about how
 * much to trust it. The proposal is a rate profile in the shape
 * configs/rates.js owns, normalised, so it can be flown, saved as a preset
 * or compared against what is flying with no further handling.
 */
export function fitRates(stats, rates) {
  const now = normaliseRates(rates);
  const proposal = {
    type: 'ACTUAL',
    throttleCap: now.throttleCap,
    thrMid: now.thrMid,
    thrExpo: now.thrExpo,
  };
  const notes = {};
  for (const axis of RATE_AXES) {
    const fit = fitAxis(stats[axis], now[axis]);
    proposal[axis] = fit.axis;
    notes[axis] = fit.note;
  }
  return {
    rates: normaliseRates(proposal),
    notes,
    confidence: confidenceOf(stats),
    /*
     * THE THROTTLE IS NOT PROPOSED, and the reason belongs here rather than
     * in a list of things left for later.
     *
     * The obvious measurement is where the throttle actually sat, and this
     * module could take it in four lines. The number it would feed is
     * Betaflight's thr_mid, and thr_mid is where the throttle curve PIVOTS.
     * With thr_expo at zero, which is the factory value and what almost
     * everybody flies, the curve is a straight line and the pivot does
     * nothing whatever: the proposal would be a row that moves and a quad
     * that does not change. Proposing an expo to go with it would not be a
     * measurement, it would be this module deciding how soft a pilot likes
     * their hover, which is a taste and not a fact about the session.
     *
     * configs/rates.js already states where hover lands on the stick at
     * every throttle cap, measured off the plant by scripts/flightcheck.js,
     * and the Rates screen already prints it. That is the honest throttle
     * answer and it is already on the screen.
     */
    throttle: null,
  };
}

/*
 * THE THREE FITS ARE GATED SEPARATELY, and the first smoke test is why.
 *
 * It ran a committed pilot, a stick thrown between the stops, through a
 * single combined gate of "moved and made corrections". That pilot makes no
 * corrections at all, because every excursion is larger than CORRECTION_MAX,
 * so the gate read false and the proposal came back with every number moved
 * beside a sentence saying the axis had not been moved enough to measure.
 * Two gates:
 *
 *   `moved`  there was stick time, so the travel and the rotation were
 *            measured, so the rate at the stop and the expo have something
 *            behind them.
 *   `aimed`  there were corrections small enough to be corrections, so the
 *            slope at centre has something behind it.
 *
 * A pilot can have the first without the second, and the note says which.
 */
function fitAxis(m, nowAxis) {
  const a = m.anchor;
  const moved = m.moveSeconds > 0;
  const aimed = m.corrections > 0 && m.correction > 0;

  /*
   * THE RATE AT THE STOP, from the rotation that was reached.
   */
  let maxDps = m.reach * REACH_HEADROOM;
  const satPush = Math.max(0, m.satShare - SAT_FREE) * SAT_GAIN;
  maxDps *= 1 + satPush;
  /*
   * AND THE AIRFRAME HAS A VETO. When a held demand went unanswered for
   * most of the time it was held, the limit is the quad and not the curve,
   * and raising the number would buy travel that commands a rotation the
   * craft cannot produce. So the proposal is not allowed above what was
   * actually achieved, headroom included. This is the measurement a tool
   * outside the simulator cannot make; see the file header.
   */
  const airframeCapped = m.unreachable > 0.5 && maxDps > m.peak * REACH_HEADROOM;
  if (airframeCapped) {
    maxDps = m.peak * REACH_HEADROOM;
  }
  /* Nothing measured, nothing proposed: the axis keeps what it had. */
  if (!(m.reach > 0)) {
    maxDps = a.fullDps;
  }
  const maxRatio = clamp(maxDps / Math.max(1, a.fullDps), STEP_MIN, STEP_MAX);
  const maxHeld = maxRatio !== maxDps / Math.max(1, a.fullDps);
  maxDps = a.fullDps * maxRatio;

  /*
   * THE SLOPE AT CENTRE, from the size of the corrections.
   */
  let centreDps = a.centreDps;
  let centreHeld = false;
  if (aimed) {
    const want = a.centreDps * (m.correction / CORRECTION_TARGET);
    const ratio = clamp(want / Math.max(1, a.centreDps), STEP_MIN, STEP_MAX);
    centreHeld = ratio !== want / Math.max(1, a.centreDps);
    centreDps = a.centreDps * ratio;
  }
  centreDps = Math.min(centreDps, maxDps * CS_CEILING);

  /*
   * EXPO, from the share of the session spent in the part expo shapes.
   *
   * An axis with no stick time carries the pilot's own expo uint8 through
   * untouched rather than being proposed a zero. Nothing was measured, so
   * nothing should move, and a yaw column quietly reset to linear because
   * the pilot never used the pedals is a change they did not ask for.
   */
  const expoCli = moved
    ? clamp(Math.round(100 * (m.midShare / MID_SHARE_FULL)), 0, 100)
    : nowAxis.expo;

  const axis = {
    rcRate: tensOf(centreDps, 1, 200),
    srate: tensOf(maxDps, 1, 200),
    expo: expoCli,
  };
  return {
    axis,
    note: axisNote(m, a, {
      maxDps, centreDps, expoCli, moved, aimed, airframeCapped, maxHeld, centreHeld,
    }),
  };
}

const pct = (v) => `${Math.round(v * 100)}`;

/*
 * WHY EACH NUMBER MOVED, in the measurement it came from.
 *
 * This is not decoration. A proposal a pilot cannot interrogate is a
 * proposal they either take on faith or ignore, and both are worse than a
 * sentence with their own session's numbers in it. Every clause below
 * names a quantity that was measured and the row it decided.
 */
function axisNote(m, a, fit) {
  if (!fit.moved) {
    return 'This stick was never moved, so nothing was measured and this axis keeps what it had.';
  }
  const bits = [];
  if (fit.aimed) {
    bits.push(`Half your corrections used more than ${pct(m.correction)} percent of the travel`
      + ` and half used less, against a target of ${pct(CORRECTION_TARGET)}, so centre goes`
      + ` ${Math.round(a.centreDps)} to ${Math.round(fit.centreDps)} deg/s.`);
  } else if (m.reversals === 0) {
    bits.push('You held this stick without ever reversing it, so there is no correction to'
      + ` measure and the slope at centre stays at ${Math.round(fit.centreDps)} deg/s.`
      + ' Hover and hold a line to measure it.');
  } else {
    bits.push(`Every move you made on this axis was bigger than ${pct(CORRECTION_MAX)} percent of`
      + ' the travel, which is a manoeuvre rather than a correction, so there is nothing to set'
      + ` the slope at centre from and it stays at ${Math.round(fit.centreDps)} deg/s.`
      + ' Hover and hold a line to measure it.');
  }
  bits.push(`You reached ${Math.round(m.reach)} deg/s, peak ${Math.round(m.peak)},`
    + ` and spent ${pct(m.satShare)} percent of your stick time on the stop, so full stick goes`
    + ` ${Math.round(a.fullDps)} to ${Math.round(fit.maxDps)} deg/s.`);
  bits.push(`${pct(m.midShare)} percent of it was in mid travel, which is the stretch expo`
    + ` shapes, so expo is ${(fit.expoCli / 100).toFixed(2)}.`);
  if (fit.airframeCapped) {
    bits.push(`The airframe is your limit on this axis, not the curve: ${pct(m.unreachable)} percent`
      + ' of the time you held a fast demand, the quad was giving you under two thirds of it.'
      + ' Asking for more would be travel that commands a rotation it cannot make.');
  }
  if (fit.maxHeld || fit.centreHeld) {
    bits.push('One session may halve or double an axis and no more, and this one asked to move it'
      + ' further, so the proposal is held at that limit. Fly it and run this again to go further.');
  }
  return bits.join(' ');
}

/*
 * HOW MUCH TO TRUST IT, from how much flying there was.
 *
 * Reported as a word and the seconds behind it, never as a bare word: "Low"
 * on its own is a verdict a pilot cannot act on, and "Low, 12 s of stick
 * movement" tells them exactly what to do about it.
 */
function confidenceOf(stats) {
  const s = stats.moveSeconds;
  const level = s >= SESSION_GOOD_S ? 'high' : (s >= SESSION_THIN_S ? 'medium' : 'low');
  const quiet = RATE_AXES.filter((axis) => stats[axis].corrections === 0);
  return { level, moveSeconds: s, quietAxes: quiet };
}

/*
 * ============================================================
 * THE COACH: run the fit over and over until it stops moving.
 * ============================================================
 *
 * WHY ONE PASS IS NOT THE ANSWER. A fit is measured against the profile that
 * was flown, so it can only ever say "given what you were flying, this is
 * nearer". Fly the nearer one and it says "nearer still", because a pilot's
 * hands change when the quad does: give them twice the rate at centre and
 * their corrections halve, which is the whole mechanism this converges on.
 * The owner asked for the loop to run itself and hand over the answer, which
 * is right, because the manual version is the pilot being a for loop.
 *
 * WHY THE ANCHOR STILL CANNOT MOVE UNDER A PASS. The obvious reading of
 * "self improving" is to nudge the rates continuously while flying. That
 * would measure a flight against a profile that no longer exists and the
 * arithmetic would mean nothing: `staleFor` exists precisely to refuse it.
 * So the loop is a SEQUENCE OF PASSES. Each pass measures one fixed
 * profile. When a pass has enough stick movement the fit is taken, the
 * shell applies it, and the next pass measures THAT. Each step is as sound
 * as a single pass because each step IS a single pass.
 *
 * THE COACH NEVER WRITES THE QUAD. It says "this pass is done, here are the
 * next rates" and waits to be told they were applied. Rate application
 * stays where it already is, in the settings path, in one place, and this
 * module stays a pure function of what it was fed. It also means the shell
 * can refuse: a pilot who parks it halfway has a coach sitting patiently at
 * a pass boundary rather than a quad being retuned underneath them.
 *
 * DOES IT ACTUALLY CONVERGE. The centre fit does, in one step, and the
 * algebra is worth having here. Model a pilot as wanting some fixed
 * rotation for a correction: they push the stick until the quad turns that
 * fast, so the travel they use is a = k/c for a pilot constant k and a
 * slope at centre c. The fit sets c' = c * (a / T) = c * (k/c) / T = k/T,
 * which does not contain c at all. One pass lands on the fixed point and
 * the next pass measures a = T and proposes no change. The rate at the stop
 * converges geometrically rather than in one step, with a ratio of about
 * 0.93 for a pilot who commits to nine tenths of travel.
 *
 * AND WHERE IT DOES NOT. A pilot who pins the stop every single time has
 * reach equal to the rate at the stop by definition, so the headroom and
 * the saturation push both fire on every pass and the number climbs
 * forever, a seventh at a time. There is no fixed point to find: that pilot
 * genuinely wants more rate than any profile offers them. So the loop stops
 * on three conditions and says which one it was, rather than only knowing
 * how to notice that it has settled.
 */

/*
 * Stick movement per pass. Longer than SESSION_THIN_S so a pass is never
 * built on a reading this module itself calls thin, and short enough that a
 * pilot sees the first change inside a minute of real flying rather than
 * wondering whether anything is happening.
 */
export const PASS_MOVE_S = 25;

/*
 * Passes before it stops regardless. Six, because the centre fit lands in
 * one and the rate at the stop closes about 7 percent of its remaining gap
 * per pass: from double the right answer, six passes is a 1.5 percent error,
 * which is under one uint8 step. A pilot who is still moving after six is
 * the runaway case above, not a pilot who needs a seventh.
 */
export const PASS_LIMIT = 6;

/*
 * What counts as having stopped moving: six percent on an endpoint and six
 * points of expo. Six percent because one uint8 step of an ACTUAL max rate
 * is 10 deg/s, which on a 450 deg/s profile is 2.2 percent, so this is
 * about three steps: tight enough that a pilot cannot feel what is left and
 * loose enough that the measurement noise of one pass does not keep the
 * loop running forever.
 */
const CONVERGE_FRAC = 0.06;
const CONVERGE_EXPO = 6;

/*
 * How far the whole loop may ever drag a profile from the one it started
 * on. Two and a half times, or the same fraction down.
 *
 * The per pass clamp in fitAxis stops one bad session; this stops a
 * compounding run of them. Six passes of the per pass limit would be 64
 * times, and a pilot who pins the stop would get there: not because the
 * arithmetic is wrong but because they are asking a question the arithmetic
 * cannot answer. Hitting this says so in words instead.
 */
const DRIFT_LIMIT = 2.5;

/* The endpoints of a profile, per axis, as the fit sees them. */
function endpointsOf(rates) {
  const a = anchorOf(normaliseRates(rates));
  const out = {};
  for (const axis of RATE_AXES) {
    out[axis] = { centreDps: a[axis].centreDps, fullDps: a[axis].fullDps };
  }
  return out;
}

/* The largest relative move between two profiles' endpoints, and the
 * largest change of expo. Expo is compared in uint8 points rather than
 * relatively because it is legitimately zero, and a relative change from
 * zero is not a number. */
function moveBetween(before, after) {
  const a = endpointsOf(before);
  const b = endpointsOf(after);
  let frac = 0;
  let expo = 0;
  for (const axis of RATE_AXES) {
    for (const key of ['centreDps', 'fullDps']) {
      const from = a[axis][key];
      if (from > 0) {
        const d = Math.abs(b[axis][key] / from - 1);
        if (d > frac) {
          frac = d;
        }
      }
    }
    const de = Math.abs(normaliseRates(after)[axis].expo - normaliseRates(before)[axis].expo);
    if (de > expo) {
      expo = de;
    }
  }
  return { frac, expo };
}

export class RateCoach {
  constructor(rates) {
    this.session = new RateSession(rates);
    this.reset(rates);
  }

  reset(rates) {
    /* The profile the pilot arrived on, kept for the whole run: the drift
     * ceiling is measured against it, and the room offers to put it back. */
    this.opening = normaliseRates(rates);
    this.flying = this.opening;
    this.session.reset(rates);
    this.pass = 1;
    this.state = 'measuring';
    this.waiting = null;
    this.history = [];
    this.why = '';
  }

  get moveSeconds() {
    return this.session.moveSeconds;
  }

  /* Of the pass in progress, as a fraction, for a progress readout. */
  get passProgress() {
    return Math.min(1, this.session.moveSeconds / PASS_MOVE_S);
  }

  staleFor(rates) {
    return this.session.staleFor(rates);
  }

  /*
   * One frame, and the only place a pass can end.
   *
   * It ends on stick movement rather than on wall clock, so a pilot who
   * parks on the ground halfway through does not get a pass taken off the
   * half they flew.
   */
  push(dtS, stick, gyroDps) {
    if (this.state !== 'measuring') {
      return;
    }
    this.session.push(dtS, stick, gyroDps);
    if (this.session.moveSeconds >= PASS_MOVE_S) {
      this.closePass();
    }
  }

  closePass() {
    const stats = this.session.stats();
    const fit = fitRates(stats, this.flying);
    const moved = moveBetween(this.flying, fit.rates);
    /* Never on the first pass. One measurement cannot be a trend, and a
     * first pass that happens to propose nothing is a pilot who was already
     * close rather than a loop that has converged on anything. */
    const settled = this.pass > 1
      && moved.frac <= CONVERGE_FRAC && moved.expo <= CONVERGE_EXPO;
    const drifted = overDrift(this.opening, fit.rates);
    /*
     * A PASS THAT WOULD CROSS THE CEILING IS REFUSED, NOT CLAMPED.
     *
     * The first version only USED the ceiling to decide that this was the
     * last pass, and then handed the over-ceiling profile over anyway. A
     * greedy pilot started on a slow profile walked straight through it: the
     * check measured 2.69 times the opening against a stated limit of 2.5,
     * which is a limit in name only.
     *
     * Refused rather than clamped because a clamped profile is one nobody
     * measured: it would be the fit's answer bent to fit a rule, offered
     * with the fit's own explanation attached, and the explanation would no
     * longer describe it. What the pilot gets instead is the last profile
     * that WAS inside the ceiling, which is a profile a pass actually
     * proposed, plus the advice to fly it and run again. That advice is also
     * the correct one: the next run's ceiling is measured from the new
     * opening, so flying it and starting again really does go further.
     */
    const rates = drifted ? this.flying : fit.rates;
    const drift = moveBetween(this.opening, rates);
    this.waiting = {
      pass: this.pass,
      rates,
      /* True when this pass found something and the ceiling took it away,
       * so the room can say that rather than showing a pass that changed
       * nothing and leaving the pilot to wonder. */
      refused: drifted,
      wanted: drifted ? fit.rates : null,
      notes: fit.notes,
      confidence: fit.confidence,
      stats,
      moved,
      drift,
      settled,
      /* The last pass this run will take, so the room can say so BEFORE the
       * pilot accepts it rather than after. */
      last: settled || drifted || this.pass >= PASS_LIMIT,
      why: settled ? 'settled' : (drifted ? 'drift' : (this.pass >= PASS_LIMIT ? 'limit' : '')),
    };
    this.state = 'ready';
  }

  /* The pass that has finished and is waiting to be applied, or null. */
  pending() {
    return this.state === 'ready' ? this.waiting : null;
  }

  /*
   * The fit over the pass IN PROGRESS, without ending it.
   *
   * So the room can show a pilot where the current pass is heading rather
   * than only ever showing them a finished one. It is a reading of an
   * incomplete pass and the room labels it as such, but a screen that said
   * nothing until the pass filled would leave a pilot who flew for twenty
   * seconds looking at the last pass's numbers with no sign that anything
   * was happening.
   *
   * Called from a render, never per frame: fitting is arithmetic over a
   * dozen histograms, which is free once a screen opens and is work nobody
   * can see sixty times a second.
   */
  peek() {
    const stats = this.session.stats();
    const fit = fitRates(stats, this.flying);
    return {
      stats,
      rates: fit.rates,
      notes: fit.notes,
      confidence: fit.confidence,
      moved: moveBetween(this.flying, fit.rates),
    };
  }

  /*
   * The shell has applied the pending rates. Record the pass and either
   * start the next one or finish.
   *
   * `applied` is what the shell ACTUALLY put on the quad, not what was
   * proposed, because the two can differ: the settings path normalises, and
   * a pilot may yet edit a row. The next pass is anchored on what is
   * flying, which is the only profile a measurement of it would mean
   * anything against.
   */
  accept(applied) {
    const done = this.waiting;
    if (!done) {
      return null;
    }
    const flying = normaliseRates(applied || done.rates);
    this.history.push({
      pass: done.pass,
      rates: flying,
      moveSeconds: done.stats.moveSeconds,
      moved: done.moved,
      settled: done.settled,
      refused: Boolean(done.refused),
      wanted: done.wanted || null,
    });
    this.flying = flying;
    this.waiting = null;
    if (done.last) {
      this.state = 'done';
      this.why = done.why || 'limit';
      return this.report();
    }
    this.pass = done.pass + 1;
    this.session.reset(flying);
    this.state = 'measuring';
    return null;
  }

  /*
   * Where the run got to.
   *
   * `why` is a word a pilot can act on, which is the whole reason the loop
   * distinguishes three endings rather than just stopping:
   *
   *   settled   it stopped moving. These are your rates.
   *   limit     six passes and still moving. Usually a pilot who is on the
   *             stop constantly and wants more than the fit will give in one
   *             run; flying these and starting again goes further.
   *   drift     it wanted to move further from where you started than one
   *             run is allowed to. Same advice, more emphatically.
   */
  report() {
    return {
      state: this.state,
      why: this.why,
      pass: this.pass,
      passes: this.history,
      opening: this.opening,
      rates: this.flying,
      drift: moveBetween(this.opening, this.flying),
    };
  }
}

function overDrift(opening, after) {
  const a = endpointsOf(opening);
  const b = endpointsOf(after);
  for (const axis of RATE_AXES) {
    for (const key of ['centreDps', 'fullDps']) {
      const from = a[axis][key];
      if (!(from > 0)) {
        continue;
      }
      const ratio = b[axis][key] / from;
      if (ratio > DRIFT_LIMIT || ratio < 1 / DRIFT_LIMIT) {
        return true;
      }
    }
  }
  return false;
}
