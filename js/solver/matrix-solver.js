/**
 * @file matrix-solver.js — "Generatore a matrici" (exact row DP + coordinate descent)
 * @description Every nurse row is produced by an exact dynamic program over the
 * GRAMMAR of the nurse's matrix (M/P/N blocks W^k-N-S-R(-R), D-N-S-R-R with the
 * monthly doppio D, the weekday M/P 5+2, …). A row is therefore valid by
 * construction: no rest islands, no broken matrices, ever. The monthly hours
 * and night counts are DP resources, so the row that is returned already meets
 * the personal monte ore whenever the matrix allows it.
 *
 * The rows are coordinated through the daily coverage: each nurse is
 * re-optimised in turn against the coverage left by all the others (block
 * coordinate descent, every move is the exact best row for that nurse), with
 * ruin-and-recreate kicks to escape local optima. Coverage costs are convex, so
 * the descent spreads staff evenly between the minimum and the maximum.
 */

'use strict';

/* global isRestrictedNoDiurniNightNurse, isMPCycleLimitedNurse */

const MX_SHIFTS = ['M', 'P', 'D', 'N', 'S', 'R'];
const MX_M = 0;
const MX_P = 1;
const MX_D = 2;
const MX_N = 3;
const MX_S = 4;
const MX_R = 5;
const MX_ABS = 6;
const MX_INF = 1e15;

const MX_WEIGHTS = {
  under: 10000, // per missing nurse below the daily minimum
  under2: 1500, // convex part: spread unavoidable deficits over many days
  fill: 12, // quadratic pull toward the daily maximum (even spread)
  over: 600, // per nurse above the daily maximum (M/P/D)
  overN: 2500, // per nurse above the nightly maximum
  over2: 300,
  hoursUnderStep: 20000, // going under the personal monte ore at all
  hoursUnder: 4000, // per missing hour
  hoursOver: 12, // per hour above the monte ore
  hoursOver2: 2,
  hoursOverMax: 2500, // per hour above the monthly maximum
  nightsSq: 30, // quadratic → nights spread evenly
  nightsOverSoft: 250, // per night above "notti massime"
  nightsOverHard: 20000, // per night above "notti massime assolute"
  diurniSq: 5,
  weekNoRest: 6000, // full calendar week without any rest
  doppiaNotte: 40, // the monthly N-N-S-R-R is used only when it helps
  override: 50000, // pinned cell that the matrix cannot reach
  noise: 3,
};

// Cost of a coverage level c against [min, max] (convex in c).
function mxCovCost(c, min, max, overW) {
  if (c < min) {
    const k = min - c;
    const f = max - c;
    return MX_WEIGHTS.under * k + MX_WEIGHTS.under2 * k * k + MX_WEIGHTS.fill * f * f;
  }
  if (c <= max) {
    const f = max - c;
    return MX_WEIGHTS.fill * f * f;
  }
  const k = c - max;
  return overW * k + MX_WEIGHTS.over2 * k * k;
}

function mxDayCost(ctx, m, p, dd, nn) {
  return (
    mxCovCost(m, ctx.minCovM, ctx.maxCovM, MX_WEIGHTS.over) +
    mxCovCost(p, ctx.minCovP, ctx.maxCovP, MX_WEIGHTS.over) +
    mxCovCost(dd, ctx.minCovD, ctx.maxCovD, MX_WEIGHTS.over) +
    mxCovCost(nn, ctx.minCovN, ctx.maxCovN, MX_WEIGHTS.overN)
  );
}

// ---------------------------------------------------------------------------
// Matrix models (one finite automaton per profile)
// ---------------------------------------------------------------------------

function mxNewTables(numStates) {
  const next = new Int16Array(numStates * 6).fill(-1);
  const tcost = new Float64Array(numStates * 6);
  return { next, tcost };
}

// M/P/N rotation (no_diurni): blocks W^k N S R (R), W = M/P with no P→M,
// 2 ≤ k ≤ K; rests ONLY after the smonto, at most `maxR` per calendar week.
// States: W(k, m) (k work days in the stretch, m of them mornings — the
// stretch is always M…MP…P because P→M is forbidden), N, S, R1, R2, FREE.
function mxModelMPN(ctx) {
  // maxSequenzaLavoro = consecutive WORKING days, night included (ward rule:
  // never 6 in a row): at most L-1 M/P before a single night, L-2 before the
  // doppia notte.
  const L = Math.max(3, Math.min(6, ctx.maxSequenzaLavoro || 5));
  const K = L - 1;
  const wId = [];
  let id = 0;
  for (let k = 1; k <= K; k++) {
    wId[k] = [];
    for (let m = 0; m <= k; m++) wId[k][m] = id++;
  }
  const N_ = id++;
  // NX: a night after the longest allowed stretch (cannot become a doppia).
  const NX = id++;
  const S_ = id++;
  const R1 = id++;
  const R2 = id++;
  const FREE = id++;
  const base = id;
  // Optional monthly doppia notte N-N-S-R-R: the states are duplicated in a
  // "doppia già usata" half (offset `base`) plus the three forced states of
  // the double block (second night, its smonto, the first of the two rests).
  const dn = !!ctx.doppiaNotteMensile;
  const N2 = dn ? base * 2 : -1;
  const SD = dn ? base * 2 + 1 : -1;
  const RD = dn ? base * 2 + 2 : -1;
  const numStates = dn ? base * 2 + 3 : base;
  const { next, tcost } = mxNewTables(numStates);
  // Preferred stretch lengths before the night (3 is the ward's classic).
  const kCost = [0, 0, 25, 0, 10, 60, 120];
  for (let used = 0; used < (dn ? 2 : 1); used++) {
    const o = used * base;
    for (let k = 1; k <= K; k++) {
      for (let m = 0; m <= k; m++) {
        const s = o + wId[k][m];
        const lastIsM = m === k;
        if (k < K) {
          if (lastIsM) next[s * 6 + MX_M] = o + wId[k + 1][m + 1];
          next[s * 6 + MX_P] = o + wId[k + 1][m];
        }
        if (k >= 2) {
          next[s * 6 + MX_N] = o + (k + 2 <= L ? N_ : NX);
          // Mild preference for mixed stretches (M-M-P, M-P-P) over pure ones.
          const pure = k >= 3 && (m === 0 || m === k) ? 6 : 0;
          tcost[s * 6 + MX_N] = kCost[k] + pure;
        }
      }
    }
    next[(o + N_) * 6 + MX_S] = o + S_;
    next[(o + NX) * 6 + MX_S] = o + S_;
    next[(o + S_) * 6 + MX_R] = o + R1;
    next[(o + R1) * 6 + MX_R] = o + R2;
    for (const s of [R1, R2, FREE]) {
      next[(o + s) * 6 + MX_M] = o + wId[1][1];
      next[(o + s) * 6 + MX_P] = o + wId[1][0];
    }
  }
  if (dn) {
    next[N_ * 6 + MX_N] = N2;
    tcost[N_ * 6 + MX_N] = MX_WEIGHTS.doppiaNotte;
    next[N2 * 6 + MX_S] = SD;
    next[SD * 6 + MX_R] = RD;
    next[RD * 6 + MX_R] = base + R2;
  }
  // N must be followed by S and S by R: an absence cannot start there.
  const absFrom = new Uint8Array(numStates).fill(1);
  for (const s of [N_, NX, S_, SD, base + N_, base + NX, base + S_]) if (s >= 0) absFrom[s] = 0;
  // A doppia notte is never cut by an absence (2 = forbidden, not overridable).
  if (dn) absFrom[N2] = 2;
  return {
    kind: 'mpn',
    restStates: dn ? [R2, base + R2] : [R2],
    numStates,
    next,
    tcost,
    absFrom,
    resetState: FREE,
    resetKeepsOffset: dn ? base : 0,
    // The doppia notte must close its S-R-R inside the month.
    n2State: N2,
    // A new month gives the doppia notte back (see mxReplayTail).
    monthOffset: dn ? base : 0,
    // Free phase without continuity: the stretch may have started in the
    // previous month, so a night on day 1-2 is reachable.
    freeStarts: [FREE, S_, R1, wId[2][0], wId[2][1], wId[2][2], ...(K >= 3 ? [wId[3][1], wId[3][2]] : [])],
    overrideState: [wId[1][1], wId[1][0], FREE, N_, S_, R2],
    countsRest: true,
    weeklyMinR: 1,
    weeklyMaxR: ctx.maxRPerWeek,
    allowed: [1, 1, 0, 1, 1, 1],
  };
}

// Rigid D/N matrix D-N-S-R-R with the monthly doppio D (N-S-R-D-D-N: the
// extra D replaces the SECOND rest, at most once per month).
function mxModelDN(ctx) {
  const base = 7;
  const FREE = 0;
  const DL = 1;
  const N_ = 2;
  const S_ = 3;
  const R1 = 4;
  const R2 = 5;
  const DX = 6;
  // NF/SF/R1F: free-phase starts inside a night block that began in an
  // unknown previous month — they cannot host the doppio D (its N-S-R would
  // not be verifiable).
  const R1F = base * 2;
  const NF = base * 2 + 1;
  const SF = base * 2 + 2;
  const numStates = base * 2 + 3;
  const { next, tcost } = mxNewTables(numStates);
  for (let used = 0; used < 2; used++) {
    const o = used * base;
    next[(o + FREE) * 6 + MX_D] = o + DL;
    next[(o + DL) * 6 + MX_N] = o + N_;
    next[(o + N_) * 6 + MX_S] = o + S_;
    next[(o + S_) * 6 + MX_R] = o + R1;
    next[(o + R1) * 6 + MX_R] = o + R2;
    if (!used && ctx.consenteDoppioDMensile) next[(o + R1) * 6 + MX_D] = base + DX;
    next[(o + R2) * 6 + MX_D] = o + DL;
    next[(o + DX) * 6 + MX_D] = o + DL;
  }
  next[NF * 6 + MX_S] = SF;
  next[SF * 6 + MX_R] = R1F;
  next[R1F * 6 + MX_R] = R2;
  const absFrom = new Uint8Array(numStates).fill(1);
  for (const o of [0, base]) {
    absFrom[o + DL] = 0;
    absFrom[o + N_] = 0;
    absFrom[o + S_] = 0;
  }
  absFrom[NF] = 0;
  absFrom[SF] = 0;
  return {
    kind: 'dn',
    restStates: [R2, base + R2],
    numStates,
    next,
    tcost,
    absFrom,
    resetState: FREE,
    resetKeepsOffset: base,
    // A doppio D in the last days of the previous month does not use up the
    // one allowed this month (see mxReplayTail).
    monthOffset: base,
    freeStarts: [FREE, DL, NF, SF, R1F, R2],
    // The extra D of the doppio D needs its paired D inside the month.
    badFinal: [DX, base + DX],
    overrideState: [FREE, FREE, DL, N_, S_, R2],
    countsRest: false,
    weeklyMinR: 0,
    weeklyMaxR: 99,
    allowed: [0, 0, 1, 1, 1, 1],
  };
}

// Weekday M/P matrix (mattine_e_pomeriggi): Saturday+Sunday are pinned R by
// buildContext; each week is M^a P^b (a ∈ 2..4) as in MP_CYCLE_PATTERNS.
// States: FREE, REST, (m, p) with m ≤ 4 mornings and p ≤ 3 afternoons.
function mxModelMP() {
  const FREE = 0;
  const REST = 1;
  const mp = [];
  let id = 2;
  for (let m = 0; m <= 4; m++) {
    mp[m] = [];
    for (let p = 0; p <= 3; p++) mp[m][p] = id++;
  }
  const numStates = id;
  const { next, tcost } = mxNewTables(numStates);
  next[REST * 6 + MX_M] = mp[1][0];
  // Free phase (month start / after an absence): any suffix of a pattern.
  next[FREE * 6 + MX_M] = mp[2][0];
  next[FREE * 6 + MX_P] = mp[2][1];
  for (let m = 0; m <= 4; m++) {
    for (let p = 0; p <= 3; p++) {
      const s = mp[m][p];
      if (p === 0 && m < 4) next[s * 6 + MX_M] = mp[m + 1][0];
      if (m >= 2 && p < 3) next[s * 6 + MX_P] = mp[m][p + 1];
    }
  }
  const absFrom = new Uint8Array(numStates).fill(1);
  return {
    kind: 'mp',
    numStates,
    next,
    tcost,
    absFrom,
    resetState: FREE,
    freeStarts: [FREE],
    overrideState: [mp[1][0], mp[2][1], FREE, FREE, FREE, REST],
    // Every week of the matrix closes on P before the weekend rest
    // (M-M-M-P-P, M-M-P-P-P, M-M-M-M-P): reaching the rest after a morning
    // breaks the cycle.
    restOverrideCost: (() => {
      const c = new Float64Array(numStates);
      for (let m = 1; m <= 4; m++) c[mp[m][0]] = MX_WEIGHTS.override / 10;
      return c;
    })(),
    countsRest: false,
    weeklyMinR: 0,
    weeklyMaxR: 99,
    allowed: [1, 1, 0, 0, 0, 0],
  };
}

// Any other profile: transitions from the ward's forbidden table and the
// 11-hour gap, N→S→R mandatory, at most 2 consecutive rests, rests not
// attached to a night discouraged. States: FREE + last shift (+ second R).
function mxModelGeneric(ctx, props) {
  const FREE = 0;
  const lastState = { M: 1, P: 2, D: 3, N: 4, S: 5, R: 6 };
  const R2 = 7;
  const numStates = 8;
  const { next, tcost } = mxNewTables(numStates);
  const allowed = MX_SHIFTS.map(s => {
    if (s === 'S' || s === 'R') return 1;
    if (s === 'N')
      return props.noNotti || props.diurniNoNotti || props.mattineEPomeriggi || props.soloMattine || props.soloDiurni
        ? 0
        : 1;
    return isRepairShiftAllowed(props, s) ? 1 : 0;
  });
  const okAfter = (prev, nextShift) => {
    if (prev === 'N') return nextShift === 'S';
    if (prev === 'S') return nextShift === 'R';
    if (nextShift === 'S') return false;
    const fb = ctx.forbidden[prev];
    if (fb && fb.includes(nextShift)) return false;
    if (ctx.rules.minGap11h && SHIFT_END[prev] !== undefined && SHIFT_START[nextShift] !== undefined)
      return gapHours(prev, nextShift) >= 11;
    return true;
  };
  for (const [prev, s] of Object.entries(lastState)) {
    for (let sh = 0; sh < 6; sh++) {
      const code = MX_SHIFTS[sh];
      if (!okAfter(prev, code)) continue;
      next[s * 6 + sh] = code === 'R' && prev === 'R' ? R2 : lastState[code];
      if (code === 'R' && (prev === 'M' || prev === 'P' || prev === 'D')) tcost[s * 6 + sh] = 120;
    }
  }
  for (let sh = 0; sh < 6; sh++) {
    const code = MX_SHIFTS[sh];
    if (code !== 'S') next[FREE * 6 + sh] = lastState[code];
    if (code !== 'S' && code !== 'R' && okAfter('R', code)) next[R2 * 6 + sh] = lastState[code];
  }
  const absFrom = new Uint8Array(numStates).fill(1);
  absFrom[lastState.N] = 0;
  absFrom[lastState.S] = 0;
  return {
    kind: 'generic',
    restStates: [R2],
    numStates,
    next,
    tcost,
    absFrom,
    resetState: FREE,
    freeStarts: [FREE],
    overrideState: [lastState.M, lastState.P, lastState.D, lastState.N, lastState.S, R2],
    countsRest: true,
    weeklyMinR: ctx.minRPerWeek || 0,
    weeklyMaxR: 99,
    allowed,
  };
}

function mxBuildModel(ctx, n) {
  const props = ctx.nurseProps[n];
  let model;
  if (ctx.pinned[n].every(c => c !== null)) model = { kind: 'fixed' };
  else if (props.diurniENotturni) model = mxModelDN(ctx);
  else if (isRestrictedNoDiurniNightNurse(props)) model = mxModelMPN(ctx);
  else if (isMPCycleLimitedNurse(props)) model = mxModelMP();
  else model = mxModelGeneric(ctx, props);
  if (model.kind === 'fixed') return model;

  // Resource dimensions: M/P count (A), nights (NN), diurni (DD), weekly rests (RW).
  const { numDays } = ctx;
  model.A = model.allowed[MX_M] || model.allowed[MX_P] ? numDays + 1 : 1;
  model.NN = model.allowed[MX_N] ? Math.ceil(numDays / 3) + 2 : 1;
  model.DD = model.allowed[MX_D] ? Math.ceil(numDays / 2) + 2 : 1;
  const rwNeed = Math.max(model.weeklyMinR, model.weeklyMaxR < 99 ? model.weeklyMaxR : 0);
  model.RW = model.countsRest && rwNeed > 0 ? rwNeed + 1 : 1;
  model.size = model.numStates * model.A * model.NN * model.DD * model.RW;
  return model;
}

// ---------------------------------------------------------------------------
// Per-nurse setup: pins, start states, weekly bookkeeping, terminal cost
// ---------------------------------------------------------------------------

function mxIsShiftCode(c) {
  return c === 'M' || c === 'P' || c === 'D' || c === 'N' || c === 'S' || c === 'R';
}

// Replay the previous-month tail through the automaton to find the state the
// nurse is in on day 1 (lenient: an unexpected shift restarts the matrix).
function mxReplayTail(model, tail) {
  let st = model.resetState;
  for (const code of tail) {
    if (!code) continue;
    if (!mxIsShiftCode(code)) {
      st = model.resetState;
      continue;
    }
    const sh = MX_SHIFTS.indexOf(code);
    const nx = model.next[st * 6 + sh];
    st = nx >= 0 ? nx : model.overrideState[sh];
  }
  if (model.monthOffset && st >= model.monthOffset && st < model.monthOffset * 2) st -= model.monthOffset;
  return st;
}

function mxPrepareNurse(ctx, n, model) {
  const { numDays, dows, pinned } = ctx;
  const tail = ctx.prevTail && ctx.prevTail[n] && ctx.prevTail[n].length ? ctx.prevTail[n] : null;
  const starts = tail ? [mxReplayTail(model, tail)] : model.freeStarts;
  // Rests of the previous month inside the first calendar week.
  let rwStart = 0;
  if (tail && model.RW > 1) {
    const daysBefore = (dows[0] + 6) % 7; // Monday → 0
    for (let k = 1; k <= daysBefore && k <= tail.length; k++) if (tail[tail.length - k] === 'R') rwStart++;
    rwStart = Math.min(rwStart, model.RW - 1);
  }
  let absHours = 0;
  const pin = new Array(numDays);
  for (let d = 0; d < numDays; d++) {
    const c = pinned[n][d];
    if (c === null || c === undefined) pin[d] = -1;
    else if (mxIsShiftCode(c)) pin[d] = MX_SHIFTS.indexOf(c);
    else {
      pin[d] = MX_ABS;
      absHours += SHIFT_HOURS[c] || 0;
    }
  }
  // Sunday checks for the weekly minimum rest: only complete calendar weeks
  // without absence days (an absent week needs no extra rest).
  const weekCheck = new Uint8Array(numDays);
  if (model.weeklyMinR > 0) {
    for (let d = 6; d < numDays; d++) {
      if (dows[d] !== 0) continue;
      let ok = true;
      for (let k = d - 6; k <= d; k++) if (pin[k] === MX_ABS) ok = false;
      weekCheck[d] = ok ? 1 : 0;
    }
  }
  const props = ctx.nurseProps[n];
  // Never below the personal monte ore nor below the monthly minimum of the
  // "ore minime settimanali" slider.
  const target = Math.max(
    ctx.monthlyTargetHours + (ctx.hourDeltas ? ctx.hourDeltas[n] || 0 : 0),
    ctx.minMonthlyHours || 0
  );
  const carry = ctx.nightCarryover ? ctx.nightCarryover[n] || 0 : 0;
  // Absences in the first days of NEXT month (e.g. ferie starting on the 1st):
  // the row must not end in a state that forces N/S onto them (N→F, S→F).
  let badEnd = null;
  const nm = ctx.month === 11 ? 0 : ctx.month + 1;
  const ny = ctx.month === 11 ? ctx.year + 1 : ctx.year;
  let firstAbs = 0;
  for (let k = 1; k <= 3 && !firstAbs; k++) if (getAbsenceShift(ctx.nurses[n], k, ny, nm)) firstAbs = k;
  if (firstAbs && model.absFrom) {
    badEnd = new Uint8Array(model.numStates);
    for (let st = 0; st < model.numStates; st++) {
      let reach = new Set([st]);
      for (let step = 1; step < firstAbs; step++) {
        const nxt = new Set();
        for (const s0 of reach)
          for (let sh = 0; sh < 6; sh++) {
            const ns = model.next[s0 * 6 + sh];
            if (ns >= 0 && model.allowed[sh]) nxt.add(ns);
          }
        reach = nxt;
      }
      badEnd[st] = [...reach].some(s0 => model.absFrom[s0] === 1) ? 0 : 1;
    }
  }
  return { starts, rwStart, pin, absHours, weekCheck, target, carry, props, badEnd };
}

function mxTerminalCost(ctx, info, a, nn, dd) {
  const hours = info.absHours + a * (SHIFT_HOURS.M || 0) + nn * (SHIFT_HOURS.N || 0) + dd * (SHIFT_HOURS.D || 0);
  const worked = hours - info.absHours;
  let cost = 0;
  const gap = info.target - hours;
  if (gap > 0.05) cost += MX_WEIGHTS.hoursUnderStep + MX_WEIGHTS.hoursUnder * gap;
  else {
    const over = -gap;
    cost += MX_WEIGHTS.hoursOver * over + MX_WEIGHTS.hoursOver2 * over * over;
  }
  if (worked > ctx.maxMonthlyHours) cost += MX_WEIGHTS.hoursOverMax * (worked - ctx.maxMonthlyHours);
  if (nn > 0 || info.props.diurniENotturni || isRestrictedNoDiurniNightNurse(info.props)) {
    cost += MX_WEIGHTS.nightsSq * (nn * nn + 2 * info.carry * nn);
    if (nn > ctx.maxNights) cost += MX_WEIGHTS.nightsOverSoft * (nn - ctx.maxNights);
    if (nn > ctx.hardMaxNights) cost += MX_WEIGHTS.nightsOverHard * (nn - ctx.hardMaxNights);
  }
  cost += MX_WEIGHTS.diurniSq * dd * dd;
  return cost;
}

// ---------------------------------------------------------------------------
// Exact row DP
// ---------------------------------------------------------------------------

/**
 * Best row for one nurse given the per-day marginal coverage costs `mc`
 * (Float64Array numDays*4: M, P, D, N). Returns { row, total, own } where
 * `own` is the nurse's private cost (matrix preferences + terminal) and
 * `total` adds the coverage marginals.
 */
function mxSolveRow(ctx, model, info, mc, termMult) {
  const { numDays, dows } = ctx;
  const { A, NN, DD, RW, size, next, tcost, absFrom } = model;
  if (!model.buf || model.buf.size !== size) {
    model.buf = {
      size,
      cur: new Float64Array(size),
      nxt: new Float64Array(size),
      back: new Int32Array(numDays * size),
    };
  }
  const { back } = model.buf;
  let cur = model.buf.cur;
  let nxt = model.buf.nxt;
  cur.fill(MX_INF);
  const strideRW = 1;
  const strideDD = RW;
  const strideNN = DD * RW;
  const strideA = NN * DD * RW;
  const strideS = A * NN * DD * RW;
  for (const st of info.starts) cur[st * strideS + Math.min(info.rwStart, RW - 1) * strideRW] = 0;
  const incA = [1, 1, 0, 0, 0, 0];
  const incN = [0, 0, 0, 1, 0, 0];
  const incD = [0, 0, 1, 0, 0, 0];
  const maxR = model.weeklyMaxR;

  for (let d = 0; d < numDays; d++) {
    nxt.fill(MX_INF);
    const pin = info.pin[d];
    const reset = d > 0 && dows[d] === 1 && RW > 1;
    const check = info.weekCheck[d] === 1 && RW > 1;
    const mcBase = d * 4;
    const bOff = d * size;
    for (let idx = 0; idx < size; idx++) {
      const c0 = cur[idx];
      if (c0 >= MX_INF) continue;
      let r = idx;
      const rw0 = r % RW;
      r = (r - rw0) / RW;
      const dd = r % DD;
      r = (r - dd) / DD;
      const nn = r % NN;
      r = (r - nn) / NN;
      const a = r % A;
      const st = (r - a) / A;
      const rw = reset ? 0 : rw0;

      if (pin === MX_ABS) {
        // (On day 1 the state comes from last month: never leave the row empty.)
        if (absFrom[st] === 2 && d > 0) continue;
        let ns = absFrom[st] ? model.resetState : -1;
        let extra = 0;
        if (ns < 0) {
          ns = model.resetState;
          extra = MX_WEIGHTS.override;
        }
        // The D/N reset keeps the "doppio D already used" half of the states.
        if (model.resetKeepsOffset && st >= model.resetKeepsOffset) ns += model.resetKeepsOffset;
        let cost = c0 + extra;
        if (check && rw < model.weeklyMinR) cost += MX_WEIGHTS.weekNoRest * (model.weeklyMinR - rw);
        const ni = ns * strideS + a * strideA + nn * strideNN + dd * strideDD + rw;
        if (cost < nxt[ni]) {
          nxt[ni] = cost;
          back[bOff + ni] = idx * 8 + MX_ABS;
        }
        continue;
      }

      for (let sh = 0; sh < 6; sh++) {
        if (pin >= 0 && sh !== pin) continue;
        let ns = next[st * 6 + sh];
        if (ns >= 0 && ns === model.n2State && pin < 0 && d > numDays - 4) continue;
        let cost = c0;
        if (ns < 0 || (pin < 0 && !model.allowed[sh])) {
          if (pin < 0 || !absFrom[st] || (absFrom[st] === 2 && d > 0)) continue;
          // Pinned cell the matrix cannot reach: requested rests (desiderate)
          // restart the matrix for free, anything else is a heavy override.
          ns = model.overrideState[sh];
          if (model.resetKeepsOffset && st >= model.resetKeepsOffset && ns < model.resetKeepsOffset)
            ns += model.resetKeepsOffset;
          if (sh !== MX_R) cost += MX_WEIGHTS.override;
          // A requested rest right after a double rest makes three in a row.
          else if (model.restStates && model.restStates.includes(st)) cost += MX_WEIGHTS.override / 10;
          else if (model.restOverrideCost) cost += model.restOverrideCost[st];
        } else cost += tcost[st * 6 + sh];
        const a2 = a + incA[sh];
        const nn2 = nn + incN[sh];
        const dd2 = dd + incD[sh];
        if (a2 >= A || nn2 >= NN || dd2 >= DD) continue;
        let rw2 = rw;
        if (sh === MX_R && model.countsRest && pin !== MX_R) {
          rw2 = rw + 1;
          if (rw2 > maxR) continue;
          if (rw2 > RW - 1) rw2 = RW - 1;
        }
        if (sh <= MX_N) cost += mc[mcBase + sh];
        if (check && rw2 < model.weeklyMinR) cost += MX_WEIGHTS.weekNoRest * (model.weeklyMinR - rw2);
        const ni = ns * strideS + a2 * strideA + nn2 * strideNN + dd2 * strideDD + rw2;
        if (cost < nxt[ni]) {
          nxt[ni] = cost;
          back[bOff + ni] = idx * 8 + sh;
        }
      }
    }
    const t = cur;
    cur = nxt;
    nxt = t;
  }

  // Terminal cost (hours + nights) and best final state.
  let best = MX_INF;
  let bestIdx = -1;
  for (let idx = 0; idx < size; idx++) {
    const c0 = cur[idx];
    if (c0 >= MX_INF) continue;
    if (model.badFinal && model.badFinal.includes(Math.floor(idx / strideS))) continue;
    const endPenalty = info.badEnd && info.badEnd[Math.floor(idx / strideS)] ? MX_WEIGHTS.override : 0;
    let r = (idx - (idx % RW)) / RW;
    const dd = r % DD;
    r = (r - dd) / DD;
    const nn = r % NN;
    r = (r - nn) / NN;
    const a = r % A;
    const total = c0 + endPenalty + termMult * mxTerminalCost(ctx, info, a, nn, dd);
    if (total < best) {
      best = total;
      bestIdx = idx;
    }
  }
  model.buf.cur = cur;
  model.buf.nxt = nxt;
  if (bestIdx < 0) return null;

  const row = new Array(numDays);
  let idx = bestIdx;
  let mcSum = 0;
  for (let d = numDays - 1; d >= 0; d--) {
    const b = back[d * size + idx];
    const sh = b & 7;
    row[d] = sh === MX_ABS ? ctx.pinned[info.n][d] : MX_SHIFTS[sh];
    if (sh <= MX_N) mcSum += mc[d * 4 + sh];
    idx = b >> 3;
  }
  return { row, total: best, own: best - mcSum };
}

// ---------------------------------------------------------------------------
// Coordinate descent over rows
// ---------------------------------------------------------------------------

function mxCovArrays(numDays) {
  return {
    M: new Int16Array(numDays),
    P: new Int16Array(numDays),
    D: new Int16Array(numDays),
    N: new Int16Array(numDays),
  };
}

function mxApplyRow(cov, row, sign, mult) {
  for (let d = 0; d < row.length; d++) {
    const s = row[d];
    const w = sign * (mult ? mult[d] : 1);
    if (s === 'M') cov.M[d] += w;
    else if (s === 'P') cov.P[d] += w;
    else if (s === 'N') cov.N[d] += w;
    else if (s === 'D') {
      cov.D[d] += w;
      cov.M[d] += w;
      cov.P[d] += w;
    }
  }
}

function mxCoverageTotal(ctx, cov) {
  let total = 0;
  for (let d = 0; d < ctx.numDays; d++) total += mxDayCost(ctx, cov.M[d], cov.P[d], cov.D[d], cov.N[d]);
  return total;
}

// Marginal coverage cost of adding the nurse (with multiplicity mult[d]) on
// each day/shift, plus a little noise so restarts explore different optima.
function mxMarginals(ctx, cov, mult, noise) {
  const { numDays } = ctx;
  const mc = new Float64Array(numDays * 4);
  for (let d = 0; d < numDays; d++) {
    const w = mult ? mult[d] : 1;
    const m = cov.M[d];
    const p = cov.P[d];
    const dd = cov.D[d];
    const nn = cov.N[d];
    const cM = mxCovCost(m, ctx.minCovM, ctx.maxCovM, MX_WEIGHTS.over);
    const cP = mxCovCost(p, ctx.minCovP, ctx.maxCovP, MX_WEIGHTS.over);
    const cD = mxCovCost(dd, ctx.minCovD, ctx.maxCovD, MX_WEIGHTS.over);
    const cN = mxCovCost(nn, ctx.minCovN, ctx.maxCovN, MX_WEIGHTS.overN);
    const dM = mxCovCost(m + w, ctx.minCovM, ctx.maxCovM, MX_WEIGHTS.over) - cM;
    const dP = mxCovCost(p + w, ctx.minCovP, ctx.maxCovP, MX_WEIGHTS.over) - cP;
    mc[d * 4 + MX_M] = dM;
    mc[d * 4 + MX_P] = dP;
    mc[d * 4 + MX_D] = dM + dP + mxCovCost(dd + w, ctx.minCovD, ctx.maxCovD, MX_WEIGHTS.over) - cD;
    mc[d * 4 + MX_N] = mxCovCost(nn + w, ctx.minCovN, ctx.maxCovN, MX_WEIGHTS.overN) - cN;
    if (noise > 0) for (let s = 0; s < 4; s++) mc[d * 4 + s] += Math.random() * noise;
  }
  return mc;
}

/**
 * Build the "units" the descent optimises: one per free nurse, with the shift
 * pair (coppiaTurni) merged into a single unit whose row is copied to the
 * follower (outside the follower's own pinned days).
 */
function mxBuildUnits(ctx) {
  const { numNurses, numDays, pinned } = ctx;
  const models = [];
  const infos = [];
  for (let n = 0; n < numNurses; n++) {
    models[n] = mxBuildModel(ctx, n);
    infos[n] = models[n].kind === 'fixed' ? null : { ...mxPrepareNurse(ctx, n, models[n]), n };
  }
  let follower = -1;
  let leader = -1;
  if (Array.isArray(ctx.coppiaTurni) && ctx.coppiaTurni.length === 2) {
    const [a, b] = ctx.coppiaTurni;
    if (
      a !== b &&
      a >= 0 &&
      b >= 0 &&
      a < numNurses &&
      b < numNurses &&
      models[a].kind !== 'fixed' &&
      models[a].kind === models[b].kind
    ) {
      leader = a;
      follower = b;
    }
  }
  const units = [];
  for (let n = 0; n < numNurses; n++) {
    if (models[n].kind === 'fixed' || n === follower) continue;
    const unit = { n, model: models[n], info: infos[n], mult: null, follower: -1, termMult: 1 };
    if (n === leader) {
      unit.follower = follower;
      unit.mult = new Int16Array(numDays);
      for (let d = 0; d < numDays; d++) unit.mult[d] = pinned[follower][d] ? 1 : 2;
      unit.termMult = pinned[follower].some(c => c) ? 1 : 2;
    }
    units.push(unit);
  }
  return { models, units, follower };
}

function mxFollowerRow(ctx, leaderRow, follower) {
  return leaderRow.map((s, d) => ctx.pinned[follower][d] || s);
}

/**
 * Run the matrix generator for one solution within `timeBudgetSec`.
 * Returns { schedule, violations, stats, score, matrixCost }.
 */
function solveMatrix(config, timeBudgetSec, progressCb) {
  const ctx = buildContext(config);
  const { numNurses, numDays } = ctx;
  const start = Date.now();
  const deadline = start + Math.max(0.5, timeBudgetSec || 5) * 1000;
  const { models, units, follower } = mxBuildUnits(ctx);

  // Fixed rows (fully pinned profiles) are placed once.
  const rows = new Array(numNurses);
  const cov = mxCovArrays(numDays);
  for (let n = 0; n < numNurses; n++) {
    if (models[n].kind === 'fixed') {
      rows[n] = ctx.pinned[n].slice();
      mxApplyRow(cov, rows[n], 1, null);
    }
  }

  const own = new Float64Array(units.length);
  const place = (u, noise) => {
    const unit = units[u];
    const mc = mxMarginals(ctx, cov, unit.mult, noise);
    const res = mxSolveRow(ctx, unit.model, unit.info, mc, unit.termMult);
    return res;
  };
  const setUnitRow = (u, row, ownCost) => {
    const unit = units[u];
    rows[unit.n] = row;
    mxApplyRow(cov, row, 1, unit.mult);
    if (unit.follower >= 0) rows[unit.follower] = mxFollowerRow(ctx, row, unit.follower);
    own[u] = ownCost;
  };
  const removeUnitRow = u => {
    const unit = units[u];
    mxApplyRow(cov, rows[unit.n], -1, unit.mult);
  };
  const totalCost = () => {
    let t = mxCoverageTotal(ctx, cov);
    for (let u = 0; u < units.length; u++) t += own[u];
    return t;
  };

  // Construction: nurses placed one at a time, night-capable first.
  const order = shuffle(units.map((_, u) => u));
  for (const u of order) {
    const res = place(u, MX_WEIGHTS.noise);
    if (!res) throw new Error(`Generatore a matrici: nessuna riga valida per ${ctx.nurses[units[u].n].name}`);
    setUnitRow(u, res.row, res.own);
  }

  // One descent sweep: re-optimise every unit against the others; a new row
  // is kept only when the TRUE objective (no noise) does not get worse.
  const sweep = noise => {
    let improved = false;
    for (const u of shuffle(units.map((_, i) => i))) {
      const before = totalCost();
      const oldRow = rows[units[u].n];
      const oldOwn = own[u];
      removeUnitRow(u);
      const res = place(u, noise);
      if (!res) {
        setUnitRow(u, oldRow, oldOwn);
        continue;
      }
      setUnitRow(u, res.row, res.own);
      const after = totalCost();
      if (after < before - 1e-6) improved = true;
      else if (after > before + 1e-6) {
        removeUnitRow(u);
        setUnitRow(u, oldRow, oldOwn);
      }
    }
    return improved;
  };

  for (let i = 0; i < 30 && Date.now() < deadline; i++) if (!sweep(MX_WEIGHTS.noise) && i > 2) break;

  let bestCost = totalCost();
  let bestRows = rows.map(r => r.slice());
  let bestOwn = Float64Array.from(own);
  let kicks = 0;
  // Ruin & recreate: drop a handful of rows (biased toward the nurses working
  // the worst days) and rebuild them, then descend again; keep the best.
  while (Date.now() < deadline && units.length > 1) {
    kicks++;
    if (progressCb && kicks % 5 === 0) progressCb(Math.min(0.99, (Date.now() - start) / (deadline - start)), bestCost);
    const k = Math.min(units.length, 2 + Math.floor(Math.random() * Math.min(8, units.length / 3)));
    let ruined = shuffle(units.map((_, i) => i)).slice(0, k);
    // Every other kick: rebuild together the nurse with the most nights and
    // the one with the fewest (rebuilt first), so nights can move between
    // them — a single-row move can never fix that imbalance.
    if (kicks % 2 === 0) {
      const nightCap = units.map((u, i) => i).filter(i => units[i].model.allowed[MX_N]);
      if (nightCap.length >= 2) {
        const nights = i => rows[units[i].n].filter(c => c === 'N').length;
        const sorted = shuffle(nightCap).sort((a, b) => nights(a) - nights(b));
        const lo = sorted[0];
        const hi = sorted[sorted.length - 1];
        if (nights(hi) - nights(lo) >= 2) {
          const extra = ruined.filter(i => i !== lo && i !== hi).slice(0, Math.max(0, k - 2));
          ruined = [lo, hi, ...extra];
        }
      }
    }
    for (const u of ruined) removeUnitRow(u);
    let ok = true;
    for (const u of ruined) {
      const res = place(u, MX_WEIGHTS.noise * 4);
      if (!res) {
        ok = false;
        break;
      }
      setUnitRow(u, res.row, res.own);
    }
    if (ok) for (let i = 0; i < 6 && Date.now() < deadline; i++) if (!sweep(MX_WEIGHTS.noise)) break;
    const cost = ok ? totalCost() : MX_INF;
    if (cost < bestCost - 1e-6) {
      bestCost = cost;
      bestRows = rows.map(r => r.slice());
      bestOwn = Float64Array.from(own);
    } else {
      // Restore the best solution (the cov arrays are rebuilt from scratch).
      for (let n = 0; n < numNurses; n++) rows[n] = bestRows[n].slice();
      for (const key of ['M', 'P', 'D', 'N']) cov[key].fill(0);
      for (let n = 0; n < numNurses; n++) if (models[n].kind === 'fixed') mxApplyRow(cov, rows[n], 1, null);
      for (const unit of units) mxApplyRow(cov, rows[unit.n], 1, unit.mult);
      own.set(bestOwn);
    }
  }

  const schedule = bestRows;
  if (follower >= 0 && !schedule[follower]) schedule[follower] = ctx.pinned[follower].slice();
  const violations = collectViolations(schedule, ctx);
  const stats = computeStats(schedule, ctx);
  const score = computeScore(schedule, ctx);
  console.log(
    `[Matrix] ${units.length} righe ottimizzate, ${kicks} perturbazioni, costo ${Math.round(bestCost)}, ` +
      `violazioni ${violations.length}, ${((Date.now() - start) / 1000).toFixed(1)}s`
  );
  return { schedule, violations, stats, score: score.total, matrixCost: bestCost };
}
