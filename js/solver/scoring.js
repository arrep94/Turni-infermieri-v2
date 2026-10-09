/**
 * @file scoring.js — Constraint helpers, scoring, violations, and stats
 * @description Functions for evaluating schedule quality and collecting violations.
 */

'use strict';

// ---------------------------------------------------------------------------
// Constraint helpers
// ---------------------------------------------------------------------------

function transitionOk(prev, next, ctx, schedule, nurseIdx, dayIdx) {
  if (!prev) {
    // At day 0, use previous month tail shift if available
    if (dayIdx === 0 && nurseIdx !== undefined && ctx.prevTail) {
      const tail = ctx.prevTail[nurseIdx];
      prev = tail && tail.length > 0 ? tail[tail.length - 1] : null;
    }
    if (!prev) return true;
  }
  // "Doppio D mensile" (recupero ore): the ONLY allowed D→D is the extra D
  // that replaces the SECOND rest of a D-N-S-R-R block — the first D of the
  // pair must be preceded by N-S-R (never after the smonto, never in place of
  // the first rest). The once-per-month cap is enforced in scoring.
  if (prev === 'D' && next === 'D') {
    return isDoppioDPair(schedule, ctx, nurseIdx, dayIdx === undefined ? undefined : dayIdx - 1);
  }
  const fb = ctx.forbidden[prev];
  if (fb && fb.includes(next)) return false;
  if (ctx.rules.minGap11h && SHIFT_END[prev] !== undefined && SHIFT_START[next] !== undefined) {
    if (gapHours(prev, next) < 11) return false;
  }
  return true;
}

/**
 * True when the D at (nurseIdx, extraDayIdx) is a VALID "extra D" of the
 * monthly doppio D: rule enabled, diurni_e_notturni nurse, and the cell sits
 * exactly where the second rest of a D-N-S-R-R block was (N, S, R right
 * before it — previous-month tail included via getShiftAt).
 */
function isDoppioDPair(schedule, ctx, nurseIdx, extraDayIdx) {
  if (!ctx.consenteDoppioDMensile || nurseIdx === undefined || extraDayIdx === undefined) return false;
  const props = ctx.nurseProps && ctx.nurseProps[nurseIdx];
  if (!props || !props.diurniENotturni) return false;
  return (
    getShiftAt(schedule, ctx, nurseIdx, extraDayIdx - 1) === 'R' &&
    getShiftAt(schedule, ctx, nurseIdx, extraDayIdx - 2) === 'S' &&
    getShiftAt(schedule, ctx, nurseIdx, extraDayIdx - 3) === 'N'
  );
}

// True when (n, d) actually IS the extra D of a valid doppio D in the current
// schedule (cells verified, not just the structural precondition).
function isDoppioDExtraDay(schedule, ctx, n, d) {
  return (
    schedule[n][d] === 'D' &&
    d + 1 < schedule[n].length &&
    schedule[n][d + 1] === 'D' &&
    isDoppioDPair(schedule, ctx, n, d)
  );
}

// Count the D-D pairs of a nurse inside the month (the doppio D of the
// monthly hour-recovery rule — capped at one per month in scoring).
function countDoppioD(schedule, n, numDays) {
  let count = 0;
  for (let d = 0; d + 1 < numDays; d++) {
    if (schedule[n][d] === 'D' && schedule[n][d + 1] === 'D') count++;
  }
  return count;
}

// Monthly doppia notte (rule "doppiaNotteMensile", M/P/N rotation only): the
// block N-N-S-R-R. True when the nights of day d and d+1 form that pair (d may
// be -1: first night on the last day of the previous month). A third night in
// a row is never part of a pair.
function isDoppiaNottePair(schedule, ctx, n, d) {
  if (!ctx.doppiaNotteMensile || !isRestrictedNoDiurniNightNurse(ctx.nurseProps[n])) return false;
  return (
    getShiftAt(schedule, ctx, n, d) === 'N' &&
    getShiftAt(schedule, ctx, n, d + 1) === 'N' &&
    getShiftAt(schedule, ctx, n, d - 1) !== 'N' &&
    getShiftAt(schedule, ctx, n, d + 2) !== 'N'
  );
}

// Doppie notti starting inside the month (capped at one per month).
function countDoppiaNotte(schedule, n, numDays) {
  let count = 0;
  for (let d = 0; d + 1 < numDays; d++) if (schedule[n][d] === 'N' && schedule[n][d + 1] === 'N') count++;
  return count;
}

// The doppia notte is followed by S-R-R: false when the second rest (day d+4
// for a pair starting on day d) falls inside the month and is not a rest or
// an absence.
function hasDoppiaNotteRests(schedule, n, d) {
  const row = schedule[n];
  if (d + 4 >= row.length) return true;
  const c = row[d + 4];
  return !(c === 'M' || c === 'P' || c === 'D' || c === 'N' || c === 'S');
}

const WEEKLY_REST_ABSENCE_SHIFTS = new Set(['F', 'MA', 'L104', 'PR', 'MT', 'CP', 'F0', 'MA0', 'MT0', 'CP0']);

/**
 * Weekly minimum-rest requirement for one nurse in one calendar week, aware of:
 * (a) rigid/pinned weekly structures (M/P 5+2, D-N-S-R-R, solo_mattine,
 *     4 mattine + notte ven.): their rests are matrix-determined, so partial
 *     boundary weeks are calendar artifacts, not violations;
 * (b) absence days (ferie/malattia/104/permessi/maternità), which already
 *     satisfy the recovery requirement — a fully absent week needs no extra R;
 * (c) the monthly doppio D, which gives up exactly one sanctioned rest.
 * Used by scoring, violations, the pattern planner and the weekly-rest repair
 * so they all agree on what counts as a real deficit.
 */
function weeklyRestNeed(schedule, ctx, n, wDays) {
  const props = ctx.nurseProps[n];
  // M/P/N matrix (W-N-S-R blocks, and the fixed M-M-M-M-N-S-R of the
  // quattro mattine + venerdì notte profile): rests come only from the night blocks, at
  // most maxRPerWeek a week — the minimum is one rest per complete week
  // without absences (partial boundary weeks are calendar artifacts).
  if (isRestrictedNoDiurniNightNurse(props) || props.quattroMattineVenerdiNotte) {
    if (wDays.length < 7) return 0;
    for (const d of wDays) if (WEEKLY_REST_ABSENCE_SHIFTS.has(schedule[n][d])) return 0;
    return Math.min(1, ctx.minRPerWeek);
  }
  if (
    wDays.length < 7 &&
    (isMPCycleLimitedNurse(props) || props.diurniENotturni || props.soloMattine || props.quattroMattineVenerdiNotte)
  )
    return 0;
  let absent = 0;
  for (const d of wDays) {
    if (WEEKLY_REST_ABSENCE_SHIFTS.has(schedule[n][d])) absent++;
  }
  let need = requiredRest(wDays.length - absent, ctx.minRPerWeek);
  if (ctx.consenteDoppioDMensile && wDays.some(d => isDoppioDExtraDay(schedule, ctx, n, d))) need--;
  return Math.max(0, need);
}

// Read a shift from the current month schedule, or from previousMonthTail when
// dayIdx is negative. Negative indices are translated from the tail end so
// dayIdx === -1 means "last shift of previous month", dayIdx === -2 the one before, etc.
function getShiftAt(schedule, ctx, nurseIdx, dayIdx) {
  if (nurseIdx === undefined || nurseIdx === null) return null;
  if (dayIdx >= 0) {
    if (dayIdx >= schedule[nurseIdx].length) return null;
    return schedule[nurseIdx][dayIdx];
  }
  if (!ctx.prevTail) return null;
  const tail = ctx.prevTail[nurseIdx];
  if (!tail) return null;
  const tailIdx = tail.length + dayIdx;
  return tailIdx >= 0 ? tail[tailIdx] : null;
}

const DIURNI_NOTTURNI_EXTRA_REST_OFFSET = 4;

function isRestrictedNoDiurniNightNurse(props) {
  if (!props || !props.noDiurni) return false;
  const excludedFlags = [
    'noNotti',
    'diurniNoNotti',
    'mattineEPomeriggi',
    'quattroMattineVenerdiNotte',
    'soloMattine',
    'soloDiurni',
    'soloNotti',
    'diurniENotturni',
  ];
  return !excludedFlags.some(flag => props[flag]);
}

function getForbiddenExtraRecoveryOffset(props) {
  if (!props || props.soloNotti || props.noDiurni) return null;
  return DIURNI_NOTTURNI_EXTRA_REST_OFFSET;
}

function isForbiddenExtraNightRestDay(schedule, ctx, nurseIdx, dayIdx) {
  if (nurseIdx === undefined || nurseIdx === null || dayIdx < 0) return false;
  const props = ctx.nurseProps[nurseIdx];
  const offset = getForbiddenExtraRecoveryOffset(props);
  if (offset === null) return false;
  const nightDayIdx = dayIdx - offset;
  if (getShiftAt(schedule, ctx, nurseIdx, nightDayIdx) !== 'N') return false;
  if (getShiftAt(schedule, ctx, nurseIdx, nightDayIdx + 1) !== 'S') return false;
  if (getShiftAt(schedule, ctx, nurseIdx, nightDayIdx + 2) !== 'R') return false;
  if (!props.noDiurni && getShiftAt(schedule, ctx, nurseIdx, nightDayIdx + 3) !== 'R') return false;
  return true;
}

function hasForbiddenExtraNightRest(schedule, ctx, nurseIdx, nightDayIdx) {
  const props = ctx.nurseProps[nurseIdx];
  const offset = getForbiddenExtraRecoveryOffset(props);
  if (offset === null) return false;
  const extraRestDayIdx = nightDayIdx + offset;
  return (
    getShiftAt(schedule, ctx, nurseIdx, extraRestDayIdx) === 'R' &&
    isForbiddenExtraNightRestDay(schedule, ctx, nurseIdx, extraRestDayIdx)
  );
}

// True for profiles whose night block is the rigid 4-day N-S-R-R (both rests
// mandatory): the diurni_e_notturni matrix is D-N-S-R-R with no shortcuts.
function needsSecondNightRest(props) {
  return !!(props && props.diurniENotturni);
}

// Detect the mandatory rest days of a night block: the first R immediately
// after S is locked for everyone; the second R (N-S-R-R) is locked only for
// diurni_e_notturni profiles (rigid D-N-S-R-R matrix) — for the others it is
// allowed but never mandatory, see isOptionalRestAfterNSR.
function isMandatoryNightRestDay(schedule, ctx, nurseIdx, dayIdx) {
  if (nurseIdx === undefined || nurseIdx === null || dayIdx < 0) return false;
  if (getShiftAt(schedule, ctx, nurseIdx, dayIdx) !== 'R') return false;
  if (getShiftAt(schedule, ctx, nurseIdx, dayIdx - 1) === 'S') return true;
  if (needsSecondNightRest(ctx.nurseProps && ctx.nurseProps[nurseIdx])) {
    return isOptionalRestAfterNSR(schedule, ctx, nurseIdx, dayIdx);
  }
  return false;
}

// The second R after N-S-R: allowed for every profile, required only by the
// diurni_e_notturni matrix (see isMandatoryNightRestDay).
function isOptionalRestAfterNSR(schedule, ctx, nurseIdx, dayIdx) {
  if (nurseIdx === undefined || nurseIdx === null || dayIdx < 0) return false;
  if (getShiftAt(schedule, ctx, nurseIdx, dayIdx) !== 'R') return false;
  return (
    getShiftAt(schedule, ctx, nurseIdx, dayIdx - 1) === 'R' &&
    getShiftAt(schedule, ctx, nurseIdx, dayIdx - 2) === 'S' &&
    getShiftAt(schedule, ctx, nurseIdx, dayIdx - 3) === 'N'
  );
}

// True when day coverage `cov` still has headroom on a shift THIS nurse could
// actually work (tag-aware): a rest is "avoidable" only if the nurse could
// have been assigned somewhere with spare capacity.
function nurseHasSpareCapacityOn(cov, ctx, props) {
  return (
    (cov.M < ctx.maxCovM && isRepairShiftAllowed(props, 'M')) ||
    (cov.P < ctx.maxCovP && isRepairShiftAllowed(props, 'P')) ||
    (cov.N < ctx.maxCovN && isRepairShiftAllowed(props, 'N')) ||
    (cov.D < ctx.maxCovD && isRepairShiftAllowed(props, 'D'))
  );
}

// An R that belongs to a night recovery block (first R after S, or the second
// R of N-S-R-R). Used to exempt structural block rests from the weekly rest
// EXCESS accounting for diurni_e_notturni nurses: their rigid D-N-S-R-R cycle
// can legitimately place 3-4 block rests inside one calendar week.
function isNightBlockRestDay(schedule, ctx, nurseIdx, dayIdx) {
  if (getShiftAt(schedule, ctx, nurseIdx, dayIdx) !== 'R') return false;
  if (getShiftAt(schedule, ctx, nurseIdx, dayIdx - 1) === 'S') return true;
  return isOptionalRestAfterNSR(schedule, ctx, nurseIdx, dayIdx);
}

function canAssignRestrictedNoDiurniRest(schedule, ctx, nurseIdx, dayIdx) {
  if (nurseIdx === undefined || nurseIdx === null || dayIdx < 0) return false;
  const props = ctx.nurseProps[nurseIdx];
  if (!isRestrictedNoDiurniNightNurse(props)) return true;
  return (
    getShiftAt(schedule, ctx, nurseIdx, dayIdx - 1) === 'S' ||
    (getShiftAt(schedule, ctx, nurseIdx, dayIdx - 1) === 'R' &&
      getShiftAt(schedule, ctx, nurseIdx, dayIdx - 2) === 'S' &&
      getShiftAt(schedule, ctx, nurseIdx, dayIdx - 3) === 'N')
  );
}

function isForbiddenRestrictedNoDiurniRestDay(schedule, ctx, nurseIdx, dayIdx) {
  if (nurseIdx === undefined || nurseIdx === null || dayIdx < 0) return false;
  const props = ctx.nurseProps[nurseIdx];
  if (!isRestrictedNoDiurniNightNurse(props)) return false;
  if (getShiftAt(schedule, ctx, nurseIdx, dayIdx) !== 'R') return false;
  return !canAssignRestrictedNoDiurniRest(schedule, ctx, nurseIdx, dayIdx);
}

// An R of an M/P/N matrix nurse that does not come from a night block (not
// right after the smonto, not the second R of N-S-R-R): the "isola di riposo"
// the ward forbids. Pinned cells (desiderate, continuity) and the first days
// of a month without continuity (unknowable previous block) are exempt.
// M/P/N matrix: start days of the runs of consecutive working days (M/P/N,
// night included, previous-month tail counted) longer than maxSequenzaLavoro.
// Ward rule: at most 5 shifts in a row night included, never 6.
function longWorkRunsMPN(schedule, ctx, n) {
  if (!isRestrictedNoDiurniNightNurse(ctx.nurseProps[n])) return [];
  const limit = ctx.maxSequenzaLavoro || 5;
  const isWork = c => c === 'M' || c === 'P' || c === 'N' || c === 'D';
  const tail = (ctx.prevTail && ctx.prevTail[n]) || [];
  let run = 0;
  for (let k = tail.length - 1; k >= 0 && isWork(tail[k]); k--) run++;
  const starts = [];
  let flagged = false;
  for (let d = 0; d < schedule[n].length; d++) {
    if (isWork(schedule[n][d])) {
      run++;
      if (run > limit && !flagged) {
        starts.push(d);
        flagged = true;
      }
    } else {
      run = 0;
      flagged = false;
    }
  }
  return starts;
}

function isRestOutsideMPNMatrix(schedule, ctx, n, d) {
  if (!isRestrictedNoDiurniNightNurse(ctx.nurseProps[n])) return false;
  if (schedule[n][d] !== 'R') return false;
  if (ctx.pinned && ctx.pinned[n] && ctx.pinned[n][d]) return false;
  const hasTail = !!(ctx.prevTail && ctx.prevTail[n] && ctx.prevTail[n].length);
  if (!hasTail && (d === 0 || (d === 1 && schedule[n][0] === 'R'))) return false;
  return !canAssignRestrictedNoDiurniRest(schedule, ctx, n, d);
}

// Rests of a week that count toward the M/P/N weekly cap (requested/pinned
// rests excluded).
function countMatrixWeekRest(schedule, ctx, n, wDays) {
  let c = 0;
  for (const d of wDays) if (schedule[n][d] === 'R' && !(ctx.pinned && ctx.pinned[n][d])) c++;
  return c;
}

function isWorkShift(shift) {
  return shift === 'M' || shift === 'P' || shift === 'D' || shift === 'N';
}

function isSplitRestDay(schedule, ctx, nurseIdx, dayIdx) {
  if (nurseIdx === undefined || nurseIdx === null || dayIdx < 0 || dayIdx >= ctx.numDays) return false;
  if (ctx.pinned && ctx.pinned[nurseIdx] && ctx.pinned[nurseIdx][dayIdx]) return false;
  if (getShiftAt(schedule, ctx, nurseIdx, dayIdx) !== 'R') return false;
  if (isMandatoryNightRestDay(schedule, ctx, nurseIdx, dayIdx)) return false;
  if (isOptionalRestAfterNSR(schedule, ctx, nurseIdx, dayIdx)) return false;

  const prev = getShiftAt(schedule, ctx, nurseIdx, dayIdx - 1);
  const next = getShiftAt(schedule, ctx, nurseIdx, dayIdx + 1);
  if (!isWorkShift(prev) || !isWorkShift(next)) return false;

  return true;
}

function getRestPromotionPriority(props) {
  if (props.noDiurni) return 0;
  if (props.mattineEPomeriggi) return 1;
  return 2;
}

function dayCoverage(schedule, d, numNurses) {
  let M = 0,
    P = 0,
    D = 0,
    N = 0;
  for (let n = 0; n < numNurses; n++) {
    const s = schedule[n][d];
    if (s === 'M') M++;
    else if (s === 'P') P++;
    else if (s === 'D') {
      D++;
      M++;
      P++;
    } else if (s === 'N') N++;
  }
  return { M, P, D, N };
}

function nurseHours(schedule, n, numDays) {
  let h = 0;
  for (let d = 0; d < numDays; d++) h += SHIFT_HOURS[schedule[n][d]] || 0;
  return h;
}

function nightCount(schedule, n, numDays) {
  let c = 0;
  for (let d = 0; d < numDays; d++) if (schedule[n][d] === 'N') c++;
  return c;
}

function diurniCount(schedule, n, numDays) {
  let c = 0;
  for (let d = 0; d < numDays; d++) if (schedule[n][d] === 'D') c++;
  return c;
}

function countWeekRest(schedule, n, weekDays) {
  let c = 0;
  for (const d of weekDays) if (schedule[n][d] === 'R') c++;
  return c;
}

function requiredRest(weekLen, minR) {
  if (weekLen >= 7) return minR;
  if (weekLen <= 2) return 0;
  return Math.max(1, Math.ceil((weekLen * minR) / 7));
}

// Rigid M/P weekly matrix: 5 working days + 2 consecutive rest days (7-day cycle).
const MP_CYCLE_PATTERNS = [
  ['M', 'M', 'M', 'P', 'P', 'R', 'R'],
  ['M', 'M', 'P', 'P', 'P', 'R', 'R'],
  ['M', 'M', 'M', 'M', 'P', 'R', 'R'],
];
const MP_NIGHT_PATTERNS = [
  ['M', 'M', 'P'],
  ['M', 'P', 'P'],
  ['M', 'M', 'M'],
  ['P', 'P', 'P'],
  ['M', 'P'],
  ['M', 'M'],
  ['P', 'P'],
];
// Rigid D/N matrix lead-in: the day before a night must be a D (cycle D-N-S-R-R).
const D_NIGHT_PATTERNS = [['D']];
const MP_CYCLE_PATTERN_LABELS = MP_CYCLE_PATTERNS.map(pattern => pattern.join('-')).join(', ');
const MP_NIGHT_PATTERN_LABELS = MP_NIGHT_PATTERNS.map(pattern => pattern.join('-')).join(', ');
const D_NIGHT_PATTERN_LABELS = D_NIGHT_PATTERNS.map(pattern => pattern.join('-')).join(', ');

function isMPCycleLimitedNurse(props) {
  return props.mattineEPomeriggi || (props.noNotti && props.noDiurni);
}

function getAllowedMPCyclePatterns() {
  return MP_CYCLE_PATTERNS;
}

function isAllowedMPCycleShift(shift) {
  return shift === 'M' || shift === 'P' || shift === 'R';
}

// Last shift of the previous month for a nurse (from the continuity tail), or null.
function getPrevTailShift(ctx, n) {
  const tail = ctx.prevTail && ctx.prevTail[n];
  return tail && tail.length > 0 ? tail[tail.length - 1] : null;
}

function getMPCyclePlan(schedule, nurseIdx, numDays, props, prevShift, dows) {
  const row = schedule[nurseIdx];
  const basePatterns = getAllowedMPCyclePatterns(props);
  // Weekend-aligned rests (the M/P matrix rests every Saturday+Sunday) make the
  // month edges special: a month ending on Saturday legitimately closes on the
  // first R (Sunday falls in the next month) and a month starting on Sunday
  // legitimately opens with the lone second R. `dows` (0=Sun..6=Sat), when
  // provided, enables those two calendar exemptions.
  const endsOnSaturday = !!(dows && dows[numDays - 1] === 6);
  const startsOnSunday = !!(dows && dows[0] === 0);
  // At month start the nurse may be mid-cycle (phase offset): allow suffixes of
  // a pattern as the first segment. The two rests must stay ADJACENT inside the
  // month: a suffix starting with the lone second R is allowed only when the
  // previous month actually ended with the first R (prevShift === 'R') or when
  // day 1 is a Sunday (weekend pair crossing the boundary).
  const phasePatterns = [];
  for (const pattern of basePatterns) {
    for (let cut = 1; cut < pattern.length; cut++) {
      const suffix = pattern.slice(cut);
      if (suffix[0] === 'R' && suffix.length === 1 && prevShift !== 'R' && !startsOnSunday) continue;
      phasePatterns.push(suffix);
    }
  }
  const memo = new Map();

  function scoreBlock(startDay, pattern) {
    // The block is truncated at the month end or at the first non-comparable
    // cell (absences interrupt the cycle without invalidating it).
    let mismatch = 0;
    let blockLen = 0;
    for (let offset = 0; offset < pattern.length && startDay + offset < numDays; offset++) {
      const shift = row[startDay + offset];
      if (!isAllowedMPCycleShift(shift)) break;
      if (shift !== pattern[offset]) mismatch++;
      blockLen++;
    }
    if (blockLen === 0) return null;
    // Month-end truncation that splits the R-R pair (the month closes on the
    // first R with the second one falling into the next month) counts as a
    // mismatch - EXCEPT when the month ends on a Saturday: the weekend pair
    // completes on the next month's Sunday.
    if (
      startDay + blockLen === numDays &&
      blockLen < pattern.length &&
      pattern[blockLen] === 'R' &&
      pattern[blockLen - 1] === 'R' &&
      !endsOnSaturday
    ) {
      mismatch++;
    }
    return { blockLen, mismatch };
  }

  function solve(startDay, allowPhase) {
    if (startDay >= numDays) return { mismatch: 0, segments: [] };
    const key = startDay * 2 + (allowPhase ? 1 : 0);
    if (memo.has(key)) return memo.get(key);

    // Non-comparable cell (absence code): skip it and resume the cycle with a
    // free phase, so the 5+2 matrix stays validated after every absence.
    if (!isAllowedMPCycleShift(row[startDay])) {
      const skipped = solve(startDay + 1, true);
      memo.set(key, skipped);
      return skipped;
    }

    let best = { mismatch: Infinity, segments: [] };
    const candidates = allowPhase ? basePatterns.concat(phasePatterns) : basePatterns;
    for (const pattern of candidates) {
      const block = scoreBlock(startDay, pattern);
      if (!block) continue;

      const tail = solve(startDay + block.blockLen, false);
      const totalMismatch = block.mismatch + tail.mismatch;
      if (totalMismatch < best.mismatch) {
        best = {
          mismatch: totalMismatch,
          segments: [{ startDay, blockLen: block.blockLen, mismatch: block.mismatch, pattern }, ...tail.segments],
        };
      }
    }

    const result = Number.isFinite(best.mismatch) ? best : { mismatch: 0, segments: [] };
    memo.set(key, result);
    return result;
  }

  return solve(0, true);
}

function getMPCycleBlockMismatch(schedule, nurseIdx, startDay, numDays, props) {
  const plan = getMPCyclePlan(schedule, nurseIdx, numDays, props);
  const segment = plan.segments.find(entry => entry.startDay === startDay);
  return segment ? segment.mismatch : 0;
}

function matchesPatternEndingAt(schedule, ctx, nurseIdx, endDayIdx, pattern) {
  const startDayIdx = endDayIdx - pattern.length + 1;
  for (let offset = 0; offset < pattern.length; offset++) {
    if (getShiftAt(schedule, ctx, nurseIdx, startDayIdx + offset) !== pattern[offset]) return false;
  }
  return true;
}

function getComparablePatterns(ctx, nurseIdx, nightDayIdx, patterns) {
  return patterns.filter(pattern => {
    const startDayIdx = nightDayIdx - pattern.length;
    if (startDayIdx >= 0) return true;
    const tail = ctx.prevTail && ctx.prevTail[nurseIdx];
    return !!(tail && tail.length >= -startDayIdx);
  });
}

function getNightPatternInfo(schedule, ctx, nurseIdx, nightDayIdx) {
  const props = ctx.nurseProps[nurseIdx];
  if (!props || props.soloNotti) return null;
  if (props.noDiurni) {
    const comparablePatterns = getComparablePatterns(ctx, nurseIdx, nightDayIdx, MP_NIGHT_PATTERNS);
    return {
      type: 'mp',
      validLead:
        comparablePatterns.length === 0 ||
        comparablePatterns.some(pattern => matchesPatternEndingAt(schedule, ctx, nurseIdx, nightDayIdx - 1, pattern)),
    };
  }
  if (props.diurniENotturni) {
    const comparablePatterns = getComparablePatterns(ctx, nurseIdx, nightDayIdx, D_NIGHT_PATTERNS);
    return {
      type: 'd',
      validLead:
        comparablePatterns.length === 0 ||
        comparablePatterns.some(pattern => matchesPatternEndingAt(schedule, ctx, nurseIdx, nightDayIdx - 1, pattern)),
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Reperibile notturno (night on-call) helpers
// ---------------------------------------------------------------------------

// True when at least one nurse works a night on day d (the night starting
// that evening — the one the on-call backs up).
function hasNightOnDay(schedule, d, numNurses) {
  for (let n = 0; n < numNurses; n++) {
    if (schedule[n][d] === 'N') return true;
  }
  return false;
}

// Profiles excluded from EVERY on-call duty (ward rule): "solo mattine
// feriali" and the rigid M/P matrix ("mattine e pomeriggi") never serve as
// reperibile, day or night.
function isReperibileExcluded(props) {
  return !!(props && (props.soloMattine || props.mattineEPomeriggi));
}

// True when at least one nurse is on smonto on day d.
function hasSmontoOnDay(schedule, ctx, d) {
  for (let n = 0; n < ctx.numNurses; n++) {
    if (schedule[n][d] === 'S') return true;
  }
  return false;
}

// True when the nurse can serve as night on-call on day d.
// With diurni in use (maxCovD > 0) the on-call is the nurse on SMONTO today
// (just off last night's shift); without diurni it is a nurse who worked the
// MORNING today ("dopo la mattina" — no other requirement).
// Day-1 fallback (smonto regime): without previous-month continuity nobody can
// be on smonto on day 1 — a morning/diurno worker covers the on-call instead
// of leaving the day uncovered.
function isReperibileEligible(schedule, ctx, n, d) {
  if (isReperibileExcluded(ctx.nurseProps && ctx.nurseProps[n])) return false;
  if (ctx.maxCovD > 0) {
    if (schedule[n][d] === 'S') return true;
    if (d === 0 && !hasSmontoOnDay(schedule, ctx, d)) {
      return schedule[n][d] === 'M' || schedule[n][d] === 'D';
    }
    return false;
  }
  return schedule[n][d] === 'M';
}

// The (first) eligible night on-call for day d, or -1 when none exists.
function findReperibile(schedule, d, numNurses, ctx) {
  for (let n = 0; n < numNurses; n++) {
    if (isReperibileEligible(schedule, ctx, n, d)) return n;
  }
  return -1;
}

// Day on-call for Sundays/holidays: assigned to a nurse working the night that
// same day (both regimes). Returns the first eligible nurse, or -1.
function findReperibileDiurno(schedule, d, numNurses) {
  for (let n = 0; n < numNurses; n++) {
    if (schedule[n][d] === 'N') return n;
  }
  return -1;
}

/**
 * True when assigning `newShift` at (n, d) would NOT break the currently-valid
 * lead-in of a night up to 3 days later (no_diurni nurses need an M/P sequence
 * right before N, diurni_e_notturni need a D or D-R-D block).
 */
function keepsNightLeadIns(schedule, ctx, n, d, newShift) {
  for (let nd = d + 1; nd <= d + 3 && nd < ctx.numDays; nd++) {
    if (schedule[n][nd] !== 'N') continue;
    const before = getNightPatternInfo(schedule, ctx, n, nd);
    if (!before || !before.validLead) return true;
    const old = schedule[n][d];
    schedule[n][d] = newShift;
    const after = getNightPatternInfo(schedule, ctx, n, nd);
    schedule[n][d] = old;
    return !after || after.validLead;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Scoring — lower is better (0 = perfect)
// ---------------------------------------------------------------------------

function computeScore(schedule, ctx) {
  const {
    numDays,
    numNurses,
    minCovM,
    minCovP,
    minCovN,
    minCovD,
    maxCovM,
    maxCovP,
    maxCovN,
    maxCovD,
    targetNights,
    maxNights,
    hardMaxNights,
    minRPerWeek,
    forbidden,
    nurseProps,
    weekDaysList,
    hourDeltas,
    monthlyTargetHours,
    coppiaTurni,
  } = ctx;
  let hard = 0,
    soft = 0;

  // Coverage — under-minimum coverage is penalized UNDER_COVERAGE_WEIGHT× harder so
  // the solver guarantees the required daily minimums first and only then assigns extra
  // staff toward the maximum. Night overcoverage is penalized 3× harder so the solver
  // prefers to exceed on M/P/D positions rather than on night shifts.
  // covByDay[d]: daily coverage, reused by the weekly rest-excess accounting to
  // decide (tag-aware) when an extra rest was avoidable vs. structural.
  const covByDay = new Array(numDays);
  for (let d = 0; d < numDays; d++) {
    const cov = dayCoverage(schedule, d, numNurses);
    covByDay[d] = cov;
    if (cov.M < minCovM) hard += (minCovM - cov.M) * UNDER_COVERAGE_WEIGHT;
    if (cov.M > maxCovM) hard += cov.M - maxCovM;
    if (cov.P < minCovP) hard += (minCovP - cov.P) * UNDER_COVERAGE_WEIGHT;
    if (cov.P > maxCovP) hard += cov.P - maxCovP;
    if (cov.N < minCovN) hard += (minCovN - cov.N) * UNDER_COVERAGE_WEIGHT;
    if (cov.N > maxCovN) hard += (cov.N - maxCovN) * 3;
    if (cov.D < minCovD) hard += (minCovD - cov.D) * UNDER_COVERAGE_WEIGHT;
    if (cov.D > maxCovD) hard += cov.D - maxCovD;
  }

  // Per-nurse hard constraints
  for (let n = 0; n < numNurses; n++) {
    // Check transition from previous month to day 0
    if (ctx.prevTail) {
      const tail = ctx.prevTail[n];
      if (tail && tail.length > 0) {
        const lastShift = tail[tail.length - 1];
        const secondLastShift = tail.length >= 2 ? tail[tail.length - 2] : null;
        if (lastShift) {
          const day0 = schedule[n][0];
          const fb0 = forbidden[lastShift];
          // D→D across the month boundary is legal only as a doppio D whose
          // extra D was the last day of the previous month.
          const boundaryDoppioD = lastShift === 'D' && day0 === 'D' && isDoppioDPair(schedule, ctx, n, -1);
          const boundaryDoppiaN = lastShift === 'N' && day0 === 'N' && isDoppiaNottePair(schedule, ctx, n, -1);
          if (fb0 && fb0.includes(day0) && !boundaryDoppioD && !boundaryDoppiaN) hard++;
          if (lastShift === 'N' && day0 !== 'S' && !boundaryDoppiaN) hard++;
          if (lastShift === 'S' && day0 !== 'R') hard++;
        }
      }
    }
    for (let d = 0; d < numDays - 1; d++) {
      const cur = schedule[n][d],
        nxt = schedule[n][d + 1];
      // Forbidden transitions. D→D is legal only as the monthly doppio D
      // (extra D replacing the SECOND rest of a D-N-S-R-R block).
      const fb = forbidden[cur];
      // N→N is legal only as the monthly doppia notte (option).
      const doppiaN = cur === 'N' && nxt === 'N' && isDoppiaNottePair(schedule, ctx, n, d);
      if (fb && fb.includes(nxt) && !doppiaN) {
        if (!(cur === 'D' && nxt === 'D' && isDoppioDPair(schedule, ctx, n, d))) hard++;
      }
      // N must be followed by S
      if (cur === 'N' && nxt !== 'S' && !doppiaN) hard++;
      if (doppiaN && !hasDoppiaNotteRests(schedule, n, d)) hard++;
      // S must be followed by R
      if (cur === 'S' && nxt !== 'R') hard++;
    }
    // Rigid D/N matrix: for diurni_e_notturni the night block is N-S-R-R, so
    // the second R (day N+3) is mandatory whenever it falls inside the month.
    // For every other profile the second R stays optional. Exception: the
    // monthly doppio D may replace the second R (and only the second one) when
    // it forms a D-D pair with the next block's lead-in D.
    if (needsSecondNightRest(nurseProps[n])) {
      for (let d = -3; d < numDays - 3; d++) {
        if (getShiftAt(schedule, ctx, n, d) !== 'N') continue;
        if (d + 3 >= 0 && schedule[n][d + 3] !== 'R') {
          const isDoppioD =
            schedule[n][d + 3] === 'D' &&
            d + 4 < numDays &&
            schedule[n][d + 4] === 'D' &&
            isDoppioDPair(schedule, ctx, n, d + 3);
          if (!isDoppioD) hard++;
        }
      }
    }
    // Doppio D cap: at most ONE per nurse per month
    if (ctx.consenteDoppioDMensile) {
      const dd = countDoppioD(schedule, n, numDays);
      if (dd > 1) hard += dd - 1;
    }
    if (ctx.doppiaNotteMensile) {
      const dn = countDoppiaNotte(schedule, n, numDays);
      if (dn > 1) hard += dn - 1;
    }
    // Weekly rest — weighted 2× so the annealer does not systematically strip
    // rest days to patch coverage (which weighs UNDER_COVERAGE_WEIGHT).
    // Partial boundary weeks are exempt for rigid-matrix M/P nurses: their 5+2
    // cycle guarantees 2 rests per full week, and a month starting or ending
    // mid-cycle is a calendar artifact, not a violation.
    if (minRPerWeek > 0) {
      for (const wDays of weekDaysList) {
        // Matrix-, absence- and doppio-D-aware requirement (see weeklyRestNeed)
        const need = weeklyRestNeed(schedule, ctx, n, wDays);
        const have = countWeekRest(schedule, n, wDays);
        if (have < need) hard += (need - have) * 2;
      }
    }
    for (let d = 0; d < numDays; d++) {
      if (schedule[n][d] !== 'N') continue;
      const info = isDoppiaNottePair(schedule, ctx, n, d - 1) ? null : getNightPatternInfo(schedule, ctx, n, d);
      if (info && !info.validLead) hard++;
      if (hasForbiddenExtraNightRest(schedule, ctx, n, d)) hard++;
    }
    if (isMPCycleLimitedNurse(nurseProps[n])) {
      hard += getMPCyclePlan(schedule, n, numDays, nurseProps[n], getPrevTailShift(ctx, n), ctx.dows).mismatch;
    }
  }

  // Soft: hours equity (weight 3 — on par with night fairness)
  // When hourDeltas from previous month are available, each nurse has an individual
  // target (avg + delta) so that nurses who worked less before work more now.
  const hours = [];
  for (let n = 0; n < numNurses; n++) hours.push(nurseHours(schedule, n, numDays));
  for (let n = 0; n < numNurses; n++) {
    const target = monthlyTargetHours + (hourDeltas ? hourDeltas[n] || 0 : 0);
    const hourDiff = hours[n] - target;
    // Deficit hours weigh more than surplus: the monthly monte ore must be met,
    // extra shifts are always preferable to missing hours.
    soft += hourDiff < 0 ? Math.abs(hourDiff) * 7 : Math.abs(hourDiff) * 3;
  }

  // Soft: weekly hour fluctuation band. The weekly min/max sliders bound how
  // much a single calendar week may fluctuate; weeks outside the band cost
  // light soft points — the monthly monte ore stays the binding hard target,
  // so later weeks can compensate earlier ones ("il tornaconto mensile").
  if (ctx.weeklyMinHours > 0 || ctx.weeklyMaxHours < Infinity) {
    for (let n = 0; n < numNurses; n++) {
      for (const wDays of weekDaysList) {
        if (wDays.length < 4) continue; // skip tiny boundary weeks
        let wh = 0;
        for (const d of wDays) wh += SHIFT_HOURS[schedule[n][d]] || 0;
        const scale = wDays.length / 7;
        const lo = ctx.weeklyMinHours * scale;
        const hi = ctx.weeklyMaxHours === Infinity ? Infinity : ctx.weeklyMaxHours * scale;
        if (wh < lo) soft += lo - wh;
        else if (wh > hi) soft += wh - hi;
      }
    }
  }

  // Soft: night-count fairness. The long-term carryover shifts each nurse's
  // fair share: who did more nights than average last month (positive
  // carryover) is steered toward fewer nights this month, and vice versa.
  for (let n = 0; n < numNurses; n++) {
    if (
      nurseProps[n].soloMattine ||
      nurseProps[n].soloDiurni ||
      nurseProps[n].noNotti ||
      nurseProps[n].diurniNoNotti ||
      nurseProps[n].mattineEPomeriggi
    )
      continue;
    const nc = nightCount(schedule, n, numDays);
    const carry = ctx.nightCarryover ? ctx.nightCarryover[n] || 0 : 0;
    soft += Math.abs(nc + carry - targetNights) * 3;
  }

  // Per-nurse night caps: exceeding the soft cap (maxNights) costs extra soft
  // penalty, exceeding the absolute cap (hardMaxNights) is a hard violation.
  // quattro_mattine_venerdi_notte nurses are excluded: their nights are pinned
  // structurally (every Friday) and not controlled by the solver.
  for (let n = 0; n < numNurses; n++) {
    if (nurseProps[n].quattroMattineVenerdiNotte) continue;
    const nc = nightCount(schedule, n, numDays);
    if (nc > maxNights) soft += (nc - maxNights) * 8;
    if (nc > hardMaxNights) hard += nc - hardMaxNights;
  }

  // Soft: D-shift (diurno) count fairness among D-eligible nurses
  {
    const dEligible = [];
    for (let n = 0; n < numNurses; n++) {
      if (
        nurseProps[n].soloMattine ||
        nurseProps[n].soloNotti ||
        nurseProps[n].noDiurni ||
        nurseProps[n].mattineEPomeriggi
      )
        continue;
      dEligible.push(n);
    }
    if (dEligible.length >= 2) {
      const dCounts = dEligible.map(n => diurniCount(schedule, n, numDays));
      const dAvg = dCounts.reduce((a, b) => a + b, 0) / dCounts.length;
      for (const dc of dCounts) soft += Math.abs(dc - dAvg) * 3;
    }
  }

  // Soft: worked Sundays/holidays fairness with long-term carryover — who
  // worked more festivi than average last month works fewer this month.
  // solo_mattine nurses are excluded (weekends are structurally pinned to R).
  {
    const festDays = [];
    for (let d = 0; d < numDays; d++) if (ctx.festivi[d]) festDays.push(d);
    const festEligible = [];
    for (let n = 0; n < numNurses; n++) if (!nurseProps[n].soloMattine) festEligible.push(n);
    if (festDays.length > 0 && festEligible.length >= 2) {
      const counts = festEligible.map(n => {
        let c = 0;
        for (const d of festDays) {
          const s = schedule[n][d];
          if (s === 'M' || s === 'P' || s === 'D' || s === 'N') c++;
        }
        return c + (ctx.festiviCarryover ? ctx.festiviCarryover[n] || 0 : 0);
      });
      const avg = counts.reduce((a, b) => a + b, 0) / counts.length;
      for (const c of counts) soft += Math.abs(c - avg) * 2;
    }
  }

  // Soft: M/P balance for nurses limited to M/P-heavy workloads
  for (let n = 0; n < numNurses; n++) {
    if (
      !nurseProps[n].noDiurni &&
      !nurseProps[n].mattineEPomeriggi &&
      !nurseProps[n].noNotti &&
      !nurseProps[n].diurniNoNotti
    )
      continue;
    if (
      nurseProps[n].soloMattine ||
      nurseProps[n].soloDiurni ||
      nurseProps[n].soloNotti ||
      nurseProps[n].diurniENotturni
    )
      continue;
    let mC = 0,
      pC = 0;
    for (let d = 0; d < numDays; d++) {
      if (schedule[n][d] === 'M') mC++;
      else if (schedule[n][d] === 'P') pC++;
    }
    soft += Math.abs(mC - pC) * 2;
  }

  // Soft: discourage isolated discretionary rest days between work stretches.
  // If extra rest is needed, prefer keeping it attached to post-night recovery.
  for (let n = 0; n < numNurses; n++) {
    for (let d = ctx.prevTail ? 0 : 1; d < numDays - 1; d++) {
      if (isSplitRestDay(schedule, ctx, n, d)) soft += 4;
    }
  }

  // Hard: M/P/N matrix nurses rest ONLY after the smonto (N-S-R / N-S-R-R)
  // and at most maxRPerWeek times per calendar week.
  for (let n = 0; n < numNurses; n++) {
    if (!isRestrictedNoDiurniNightNurse(nurseProps[n])) continue;
    for (let d = 0; d < numDays; d++) {
      if (isRestOutsideMPNMatrix(schedule, ctx, n, d)) hard++;
    }
    hard += longWorkRunsMPN(schedule, ctx, n).length;
    for (const wDays of weekDaysList) {
      const have = countMatrixWeekRest(schedule, ctx, n, wDays);
      if (have > ctx.maxRPerWeek) hard += have - ctx.maxRPerWeek;
    }
  }

  // Hard: coppiaTurni must have identical schedules (BUG #1 fix)
  if (coppiaTurni && Array.isArray(coppiaTurni) && coppiaTurni.length === 2) {
    const [n1, n2] = coppiaTurni;
    if (n1 >= 0 && n1 < numNurses && n2 >= 0 && n2 < numNurses) {
      for (let d = 0; d < numDays; d++) {
        if (schedule[n1][d] !== schedule[n2][d]) hard++;
      }
    }
  }

  // Hard: nurses outside the monthly hour band (weekly sliders scaled to the month).
  // A nurse is exempt from the minimum only when actually absent (has absence
  // shifts): an all-R row is an unassigned nurse, not an absent one.
  // The MAXIMUM compares WORKED hours only: absence days carry a contractual
  // hour value the solver cannot control (a full month of maternità may
  // "exceed" the cap on paper without any workload).
  {
    const absShifts = ['F', 'MA', 'L104', 'PR', 'MT', 'CP', 'F0', 'MA0', 'MT0', 'CP0'];
    for (let n = 0; n < numNurses; n++) {
      const hasAbsence = schedule[n].some(s => absShifts.includes(s));
      const isFullyAbsent = hasAbsence && schedule[n].every(s => absShifts.includes(s) || s === 'R');
      if (ctx.minMonthlyHours > 0 && !isFullyAbsent && hours[n] < ctx.minMonthlyHours - 0.01) hard++;
      let workedHours = hours[n];
      if (hasAbsence) {
        workedHours = 0;
        for (let d = 0; d < numDays; d++) {
          if (!absShifts.includes(schedule[n][d])) workedHours += SHIFT_HOURS[schedule[n][d]] || 0;
        }
      }
      if (workedHours > ctx.maxMonthlyHours + 0.01) hard++;
    }
  }

  // HARD: more than 2 consecutive R days are not allowed (smonto S excluded —
  // S,R,R after a night is fine, R,R,R is not).
  for (let n = 0; n < numNurses; n++) {
    let consRest = 0;
    for (let d = 0; d <= numDays; d++) {
      if (d < numDays && schedule[n][d] === 'R') {
        consRest++;
      } else {
        if (consRest > MAX_CONSECUTIVE_REST) hard += consRest - MAX_CONSECUTIVE_REST;
        consRest = 0;
      }
    }
  }

  // Weekly rest cap ("solo 2 riposi a settimana"): one extra rest above the
  // minimum can be unavoidable for D/N cycles (N-S-R blocks + no D-D adjacency
  // make some 3-rest calendar weeks mathematically forced), so it costs soft
  // points; from TWO extras up (4+ rests in a week) it is a hard violation.
  // Two exemptions keep the rigid matrices intact: (a) mandatory night-block
  // rests of diurni_e_notturni nurses never count toward the excess (their
  // D-N-S-R-R cycle can align 3-4 block rests inside one calendar week);
  // (b) when the week has no spare coverage capacity (every shift already at
  // its maximum) the surplus rest is structural over-staffing, soft only.
  if (minRPerWeek > 0) {
    for (let n = 0; n < numNurses; n++) {
      // M/P/N matrix nurses: weekly cap handled above (maxRPerWeek).
      if (isRestrictedNoDiurniNightNurse(nurseProps[n])) continue;
      const exemptBlockRests = needsSecondNightRest(nurseProps[n]);
      const mpMatrixExcess = isMPCycleLimitedNurse(nurseProps[n]);
      for (const wDays of weekDaysList) {
        // Partial boundary weeks are exempt for rigid-matrix M/P nurses (their
        // phase can legally place the R-R pair inside a 1-2 day calendar week).
        if (mpMatrixExcess && wDays.length < 7) continue;
        const need = requiredRest(wDays.length, minRPerWeek);
        const have = countWeekRest(schedule, n, wDays);
        let discretionary = have;
        let hasSpareDay = false;
        for (const d of wDays) {
          if (schedule[n][d] !== 'R') continue;
          // Pinned rests (fixed profiles, desiderate) are never discretionary.
          if (ctx.pinned[n][d]) discretionary--;
          else if (exemptBlockRests && isNightBlockRestDay(schedule, ctx, n, d)) discretionary--;
          else if (nurseHasSpareCapacityOn(covByDay[d], ctx, nurseProps[n])) hasSpareDay = true;
        }
        if (discretionary > need + 1 && hasSpareDay) hard += discretionary - need - 1;
        if (discretionary > need) soft += (discretionary - need) * 10;
      }
    }
  }

  // Hard: reperibile notturno — every day with nights scheduled must have an
  // eligible on-call: a nurse on smonto today (regime with diurni) or a nurse
  // who worked the morning today (regime without diurni).
  if (ctx.reperibileNotturno) {
    for (let d = 0; d < numDays; d++) {
      // Day 1 without continuity uses the morning/diurno fallback (see
      // isReperibileEligible). The on-call is required EVERY day of the month
      // (ward rule) as long as nights are part of the ward's coverage — not
      // only on days where the planner happened to place a night.
      if (!hasNightOnDay(schedule, d, numNurses) && ctx.minCovN <= 0) continue;
      if (findReperibile(schedule, d, numNurses, ctx) === -1) hard++;
    }
  }

  // Hard: reperibile diurno festivo — every Sunday/holiday must have a nurse
  // working the night that day, so they can be designated as the day on-call.
  if (ctx.reperibileDiurnoFestivo && ctx.festivi) {
    for (let d = 0; d < numDays; d++) {
      if (!ctx.festivi[d]) continue;
      if (findReperibileDiurno(schedule, d, numNurses) === -1) hard++;
    }
  }

  return { hard, soft, total: hard * 1000 + soft };
}

// ---------------------------------------------------------------------------
// Violations — detailed constraint violation report
// ---------------------------------------------------------------------------

function collectViolations(schedule, ctx) {
  const {
    numDays,
    numNurses,
    minCovM,
    maxCovM,
    minCovP,
    maxCovP,
    minCovN,
    maxCovN,
    minCovD,
    maxCovD,
    forbidden,
    nurseProps,
    minRPerWeek,
    weekDaysList,
  } = ctx;
  const violations = [];

  // Mirror of computeScore: daily coverage reused by the rest-excess checks.
  const covByDay = new Array(numDays);
  for (let d = 0; d < numDays; d++) {
    const cov = dayCoverage(schedule, d, numNurses);
    covByDay[d] = cov;
    if (cov.M < minCovM)
      violations.push({
        day: d,
        type: 'coverage_M',
        msg: `Giorno ${d + 1}: copertura mattina insufficiente (${cov.M}/${minCovM})`,
      });
    if (cov.M > maxCovM)
      violations.push({
        day: d,
        type: 'coverage_M_max',
        msg: `Giorno ${d + 1}: copertura mattina eccessiva (${cov.M}/${maxCovM})`,
      });
    if (cov.P < minCovP)
      violations.push({
        day: d,
        type: 'coverage_P',
        msg: `Giorno ${d + 1}: copertura pomeriggio insufficiente (${cov.P}/${minCovP})`,
      });
    if (cov.P > maxCovP)
      violations.push({
        day: d,
        type: 'coverage_P_max',
        msg: `Giorno ${d + 1}: copertura pomeriggio eccessiva (${cov.P}/${maxCovP})`,
      });
    if (cov.N < minCovN)
      violations.push({
        day: d,
        type: 'coverage_N',
        msg: `Giorno ${d + 1}: copertura notte insufficiente (${cov.N}/${minCovN})`,
      });
    if (cov.N > maxCovN)
      violations.push({
        day: d,
        type: 'coverage_N_max',
        msg: `Giorno ${d + 1}: copertura notte eccessiva (${cov.N}/${maxCovN})`,
      });
    if (cov.D < minCovD)
      violations.push({
        day: d,
        type: 'coverage_D',
        msg: `Giorno ${d + 1}: copertura diurni insufficiente (${cov.D}/${minCovD})`,
      });
    if (cov.D > maxCovD)
      violations.push({
        day: d,
        type: 'coverage_D_max',
        msg: `Giorno ${d + 1}: copertura diurni eccessiva (${cov.D}/${maxCovD})`,
      });
  }

  for (let n = 0; n < numNurses; n++) {
    // Check transition from previous month to day 0
    if (ctx.prevTail) {
      const tail = ctx.prevTail[n];
      if (tail && tail.length > 0) {
        const lastShift = tail[tail.length - 1];
        const secondLastShift = tail.length >= 2 ? tail[tail.length - 2] : null;
        if (lastShift) {
          const day0 = schedule[n][0];
          const fb0 = forbidden[lastShift];
          const boundaryDoppioD = lastShift === 'D' && day0 === 'D' && isDoppioDPair(schedule, ctx, n, -1);
          const boundaryDoppiaN = lastShift === 'N' && day0 === 'N' && isDoppiaNottePair(schedule, ctx, n, -1);
          if (fb0 && fb0.includes(day0) && !boundaryDoppioD && !boundaryDoppiaN)
            violations.push({
              nurse: n,
              day: -1,
              type: 'transition',
              msg: `Infermiere ${n + 1}, confine mese: transizione vietata ${lastShift}→${day0}`,
            });
          if (lastShift === 'N' && day0 !== 'S' && !boundaryDoppiaN)
            violations.push({
              nurse: n,
              day: -1,
              type: 'N_no_S',
              msg: `Infermiere ${n + 1}, confine mese: N non seguito da S`,
            });
          if (lastShift === 'S' && day0 !== 'R')
            violations.push({
              nurse: n,
              day: -1,
              type: 'S_no_R',
              msg: `Infermiere ${n + 1}, confine mese: S non seguito da R`,
            });
        }
      }
    }
    for (let d = 0; d < numDays - 1; d++) {
      const cur = schedule[n][d],
        nxt = schedule[n][d + 1];
      const fb = forbidden[cur];
      const doppiaN = cur === 'N' && nxt === 'N' && isDoppiaNottePair(schedule, ctx, n, d);
      if (doppiaN && !hasDoppiaNotteRests(schedule, n, d))
        violations.push({
          nurse: n,
          day: d,
          type: 'doppia_notte_riposi',
          msg: `Infermiere ${n + 1}, giorno ${d + 1}: dopo la doppia notte servono smonto e due riposi (N-N-S-R-R)`,
        });
      if (fb && fb.includes(nxt) && !doppiaN && !(cur === 'D' && nxt === 'D' && isDoppioDPair(schedule, ctx, n, d)))
        violations.push({
          nurse: n,
          day: d,
          type: 'transition',
          msg: `Infermiere ${n + 1}, giorno ${d + 1}-${d + 2}: transizione vietata ${cur}→${nxt}`,
        });
      if (cur === 'N' && nxt !== 'S' && !doppiaN)
        violations.push({
          nurse: n,
          day: d,
          type: 'N_no_S',
          msg: `Infermiere ${n + 1}, giorno ${d + 1}: N non seguito da S`,
        });
      if (cur === 'S' && nxt !== 'R')
        violations.push({
          nurse: n,
          day: d,
          type: 'S_no_R',
          msg: `Infermiere ${n + 1}, giorno ${d + 1}: S non seguito da R (primo riposo dopo smonto)`,
        });
    }
    // Rigid D/N matrix: for diurni_e_notturni the second R of N-S-R-R is
    // mandatory (D-N-S-R-R cycle). For every other profile it stays optional.
    if (needsSecondNightRest(nurseProps[n])) {
      for (let d = -3; d < numDays - 3; d++) {
        if (getShiftAt(schedule, ctx, n, d) !== 'N') continue;
        if (d + 3 >= 0 && schedule[n][d + 3] !== 'R') {
          // The monthly doppio D may replace the second R (never the first,
          // never right after the smonto) when it pairs with the next lead-in D.
          const isDoppioD =
            schedule[n][d + 3] === 'D' &&
            d + 4 < numDays &&
            schedule[n][d + 4] === 'D' &&
            isDoppioDPair(schedule, ctx, n, d + 3);
          if (!isDoppioD)
            violations.push({
              nurse: n,
              day: Math.max(0, d),
              type: 'need_2R_after_night',
              msg: `Infermiere ${n + 1}, giorno ${Math.max(0, d) + 1}: la matrice D-N-S-R-R richiede due riposi dopo lo smonto`,
            });
        }
      }
    }
    // Doppio D cap: at most ONE per nurse per month
    if (ctx.consenteDoppioDMensile) {
      const dd = countDoppioD(schedule, n, numDays);
      if (dd > 1)
        violations.push({
          nurse: n,
          type: 'doppio_d_multiplo',
          msg: `Infermiere ${n + 1}: ${dd} doppi D nel mese (massimo 1 consentito)`,
        });
    }
    if (ctx.doppiaNotteMensile) {
      const dn = countDoppiaNotte(schedule, n, numDays);
      if (dn > 1)
        violations.push({
          nurse: n,
          type: 'doppia_notte_multipla',
          msg: `Infermiere ${n + 1}: ${dn} doppie notti nel mese (massimo 1 consentita)`,
        });
    }
    for (let d = 0; d < numDays; d++) {
      if (schedule[n][d] !== 'N') continue;
      const info = isDoppiaNottePair(schedule, ctx, n, d - 1) ? null : getNightPatternInfo(schedule, ctx, n, d);
      if (info && !info.validLead)
        violations.push({
          nurse: n,
          day: d,
          type: info.type === 'mp' ? 'mp_night_pattern' : 'd_night_pattern',
          msg:
            info.type === 'mp'
              ? `Infermiere ${n + 1}, giorno ${d + 1}: prima della notte serve una sequenza tra ${MP_NIGHT_PATTERN_LABELS}`
              : `Infermiere ${n + 1}, giorno ${d + 1}: il blocco diurno/notte deve seguire ${D_NIGHT_PATTERN_LABELS}`,
        });
      if (hasForbiddenExtraNightRest(schedule, ctx, n, d))
        violations.push({
          nurse: n,
          day: d,
          type: 'night_extra_rest',
          msg: nurseProps[n].noDiurni
            ? `Infermiere ${n + 1}, giorno ${d + 1}: non è consentito un secondo riposo dopo N-S-R`
            : `Infermiere ${n + 1}, giorno ${d + 1}: non è consentito un terzo riposo dopo il blocco N-S-R-R`,
        });
    }
    if (isMPCycleLimitedNurse(nurseProps[n])) {
      const plan = getMPCyclePlan(schedule, n, numDays, nurseProps[n], getPrevTailShift(ctx, n), ctx.dows);
      for (const segment of plan.segments) {
        if (segment.mismatch > 0) {
          violations.push({
            nurse: n,
            day: segment.startDay,
            type: 'mp_cycle_5_2',
            msg:
              `Infermiere ${n + 1}, giorni ${segment.startDay + 1}-${Math.min(numDays, segment.startDay + segment.blockLen)}: ` +
              `il ciclo M/P deve seguire 5 giorni di lavoro + 2 riposi (${MP_CYCLE_PATTERN_LABELS})`,
          });
        }
      }
    }
  }

  if (minRPerWeek > 0) {
    for (let n = 0; n < numNurses; n++) {
      const exemptBlockRests = needsSecondNightRest(nurseProps[n]);
      const mpMatrix = isMPCycleLimitedNurse(nurseProps[n]);
      const mpnMatrix = isRestrictedNoDiurniNightNurse(nurseProps[n]);
      for (let w = 0; w < weekDaysList.length; w++) {
        const wDays = weekDaysList[w];
        // Deficit: matrix-, absence- and doppio-D-aware requirement (mirror of
        // computeScore, see weeklyRestNeed). Excess below keeps the raw need.
        const needMin = weeklyRestNeed(schedule, ctx, n, wDays);
        const need = requiredRest(wDays.length, minRPerWeek);
        const have = countWeekRest(schedule, n, wDays);
        if (have < needMin)
          violations.push({
            nurse: n,
            week: w,
            type: 'min_R_week',
            msg: `Infermiere ${n + 1}, settimana ${w + 1}: solo ${have} riposi (minimo ${needMin})`,
          });
        // Mirror of computeScore: exclude mandatory night-block rests for
        // diurni_e_notturni, exempt partial boundary weeks for rigid-matrix
        // M/P nurses, and count only rests the nurse could have avoided
        // (tag-aware spare capacity).
        if (mpnMatrix) {
          const capped = countMatrixWeekRest(schedule, ctx, n, wDays);
          if (capped > ctx.maxRPerWeek)
            violations.push({
              nurse: n,
              week: w,
              type: 'troppi_riposi_settimana',
              msg: `Infermiere ${n + 1}, settimana ${w + 1}: ${capped} riposi (massimo ${ctx.maxRPerWeek})`,
            });
          continue;
        }
        if (mpMatrix && wDays.length < 7) continue;
        let discretionary = have;
        let hasSpareDay = false;
        for (const d of wDays) {
          if (schedule[n][d] !== 'R') continue;
          // Pinned rests (fixed profiles, desiderate) are never discretionary.
          if (ctx.pinned[n][d]) discretionary--;
          else if (exemptBlockRests && isNightBlockRestDay(schedule, ctx, n, d)) discretionary--;
          else if (nurseHasSpareCapacityOn(covByDay[d], ctx, nurseProps[n])) hasSpareDay = true;
        }
        if (discretionary > need + 1 && hasSpareDay)
          violations.push({
            nurse: n,
            week: w,
            type: 'troppi_riposi_settimana',
            msg: `Infermiere ${n + 1}, settimana ${w + 1}: ${discretionary} riposi (massimo ${need + 1})`,
          });
      }
    }
  }

  // BUG #1 fix: coppia divergente violations
  if (ctx.coppiaTurni && Array.isArray(ctx.coppiaTurni) && ctx.coppiaTurni.length === 2) {
    const [n1, n2] = ctx.coppiaTurni;
    if (n1 >= 0 && n1 < numNurses && n2 >= 0 && n2 < numNurses) {
      for (let d = 0; d < numDays; d++) {
        if (schedule[n1][d] !== schedule[n2][d]) {
          violations.push({
            type: 'coppia_divergente',
            nurse: n2,
            day: d,
            msg: `Coppia: ${ctx.nurses[n1].name} e ${ctx.nurses[n2].name} hanno turni diversi il giorno ${d + 1}`,
          });
        }
      }
    }
  }

  // Monthly hour band violations (weekly sliders scaled to the month) and
  // per-nurse absolute night cap (hardMaxNights).
  {
    const absShiftsV = ['F', 'MA', 'L104', 'PR', 'MT', 'CP', 'F0', 'MA0', 'MT0', 'CP0'];
    for (let n = 0; n < numNurses; n++) {
      const h = nurseHours(schedule, n, numDays);
      const hasAbsence = schedule[n].some(s => absShiftsV.includes(s));
      const isFullyAbsent = hasAbsence && schedule[n].every(s => absShiftsV.includes(s) || s === 'R');
      if (ctx.minMonthlyHours > 0 && !isFullyAbsent && h < ctx.minMonthlyHours - 0.01) {
        violations.push({
          type: 'low_hours',
          nurse: n,
          day: -1,
          msg: `${ctx.nurses[n].name}: ore totali ${h.toFixed(1)} < minimo mensile ${ctx.minMonthlyHours}`,
        });
      }
      // The maximum compares WORKED hours only (mirror of computeScore):
      // absence days carry contractual hours outside the solver's control.
      let workedHours = h;
      if (hasAbsence) {
        workedHours = 0;
        for (let d = 0; d < numDays; d++) {
          if (!absShiftsV.includes(schedule[n][d])) workedHours += SHIFT_HOURS[schedule[n][d]] || 0;
        }
      }
      if (workedHours > ctx.maxMonthlyHours + 0.01) {
        violations.push({
          type: 'high_hours',
          nurse: n,
          day: -1,
          msg: `${ctx.nurses[n].name}: ore lavorate ${workedHours.toFixed(1)} > massimo mensile ${ctx.maxMonthlyHours}`,
        });
      }
      if (!nurseProps[n].quattroMattineVenerdiNotte) {
        const nc = nightCount(schedule, n, numDays);
        if (nc > ctx.hardMaxNights) {
          violations.push({
            type: 'troppe_notti',
            nurse: n,
            day: -1,
            msg: `${ctx.nurses[n].name}: ${nc} notti > massimo assoluto ${ctx.hardMaxNights}`,
          });
        }
      }
    }
  }

  // M/P/N matrix: at most maxSequenzaLavoro shifts in a row, night included.
  for (let n = 0; n < numNurses; n++) {
    for (const d of longWorkRunsMPN(schedule, ctx, n)) {
      violations.push({
        type: 'sequenza_lavoro_lunga',
        nurse: n,
        day: d,
        msg: `${ctx.nurses[n].name}, giorno ${d + 1}: più di ${ctx.maxSequenzaLavoro} turni di fila (notte compresa)`,
      });
    }
  }

  // M/P/N matrix: a rest that does not follow the smonto is a rest island.
  for (let n = 0; n < numNurses; n++) {
    if (!isRestrictedNoDiurniNightNurse(nurseProps[n])) continue;
    for (let d = 0; d < numDays; d++) {
      if (!isRestOutsideMPNMatrix(schedule, ctx, n, d)) continue;
      violations.push({
        type: 'riposo_fuori_matrice',
        nurse: n,
        day: d,
        msg: `${ctx.nurses[n].name}, giorno ${d + 1}: riposo non preceduto dallo smonto (isola di riposo)`,
      });
    }
  }

  // Isole di riposo: more than 2 consecutive R days (S excluded) must be avoided.
  for (let n = 0; n < numNurses; n++) {
    let consRest = 0;
    let islandStart = 0;
    for (let d = 0; d <= numDays; d++) {
      if (d < numDays && schedule[n][d] === 'R') {
        if (consRest === 0) islandStart = d;
        consRest++;
      } else {
        if (consRest > MAX_CONSECUTIVE_REST) {
          violations.push({
            type: 'isola_di_riposo',
            nurse: n,
            day: islandStart,
            msg: `${ctx.nurses[n].name}: ${consRest} riposi consecutivi dal giorno ${islandStart + 1} (max 2)`,
          });
        }
        consRest = 0;
      }
    }
  }

  // Reperibile notturno: a day with nights needs an eligible on-call (smonto
  // today with diurni in use, morning today otherwise).
  if (ctx.reperibileNotturno) {
    for (let d = 0; d < numDays; d++) {
      // Day 1 without continuity uses the morning/diurno fallback (see
      // isReperibileEligible). The on-call is required EVERY day of the month
      // (ward rule) as long as nights are part of the ward's coverage — not
      // only on days where the planner happened to place a night.
      if (!hasNightOnDay(schedule, d, numNurses) && ctx.minCovN <= 0) continue;
      if (findReperibile(schedule, d, numNurses, ctx) === -1) {
        violations.push({
          type: 'reperibile_mancante',
          day: d,
          msg:
            ctx.maxCovD > 0
              ? `Giorno ${d + 1}: nessun reperibile notturno (serve un infermiere in smonto)`
              : `Giorno ${d + 1}: nessun reperibile notturno (serve un infermiere di mattina)`,
        });
      }
    }
  }

  // Reperibile diurno festivo: every Sunday/holiday needs a nurse working the
  // night that day to serve as the day on-call.
  if (ctx.reperibileDiurnoFestivo && ctx.festivi) {
    for (let d = 0; d < numDays; d++) {
      if (!ctx.festivi[d]) continue;
      if (findReperibileDiurno(schedule, d, numNurses) === -1) {
        violations.push({
          type: 'reperibile_diurno_mancante',
          day: d,
          msg: `Giorno ${d + 1} (festivo): nessun reperibile diurno (serve un infermiere di notte)`,
        });
      }
    }
  }

  return violations;
}

// ---------------------------------------------------------------------------
// Stats — same format expected by the UI
// ---------------------------------------------------------------------------

function computeStats(schedule, ctx) {
  const { year, month, numDays, nurses } = ctx;
  return nurses.map((_, n) => {
    let totalHours = 0,
      nights = 0,
      diurni = 0,
      weekends = 0;
    for (let d = 0; d < numDays; d++) {
      const s = schedule[n][d];
      totalHours += SHIFT_HOURS[s] || 0;
      if (s === 'N') nights++;
      if (s === 'D') diurni++;
      if (isWeekend(year, month, d + 1) && s && s !== 'R') weekends++;
    }
    return { totalHours: Math.round(totalHours * 10) / 10, nights, diurni, weekends };
  });
}
