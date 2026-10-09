/**
 * @file context.js — Build shared context object and absence handling
 * @description Preprocessing: creates the context used by all solver phases.
 */

'use strict';

/* global getMonthlyContractHours, countWeekdaysInMonth */

// ---------------------------------------------------------------------------
// Preprocessing — build a shared context object used by all phases
// ---------------------------------------------------------------------------

function buildContext(config) {
  const { year, month, nurses, rules, hourDeltas, previousMonthTail } = config;

  // Long-term equity carryover (see buildEquityCarryover in app.js): per-nurse
  // deltas of nights/worked-festivi vs the roster average in the previous month.
  // A positive value means the nurse already did MORE than their share and gets
  // a lower fair-share target this month.
  const equity = config.equityCarryover || null;
  const nightCarryover = equity && Array.isArray(equity.nights) ? equity.nights : null;
  const festiviCarryover = equity && Array.isArray(equity.festivi) ? equity.festivi : null;

  // Apply fascia oraria before any hour-dependent computation. 'auto' follows
  // the diurni usage: schedules WITH diurni (maxCoverageD > 0) use the standard
  // hours (M/P 6.2, N 12.2, assenze 6.12), schedules WITHOUT diurni use the
  // extended ones (M/P 7.2, N 10.2, assenze 7.12).
  const requestedFascia = rules.fasciaOraria || 'auto';
  const resolvedFascia =
    requestedFascia === 'auto' ? ((rules.maxCoverageD ?? 4) > 0 ? 'standard' : '7-10') : requestedFascia;
  applyFasciaOraria(resolvedFascia);

  const numDays = daysInMonth(year, month);
  const numNurses = nurses.length;
  // Monthly target: contractual hours (7.12 per weekday) by default; when the
  // weekly target slider is moved away from 36 it overrides the contract value
  // (targetHours/5 per weekday). Mirrored in app.js getMonthlyTargetHours.
  const monthlyTargetHours =
    rules.targetHours && rules.targetHours !== 36
      ? Math.round(countWeekdaysInMonth(year, month) * (rules.targetHours / 5) * 100) / 100
      : getMonthlyContractHours(year, month);

  // Forbidden-transition table (may be relaxed by rule flags)
  const forbidden = {
    P: [...BASE_FORBIDDEN_NEXT.P],
    D: [...BASE_FORBIDDEN_NEXT.D],
    N: [...BASE_FORBIDDEN_NEXT.N],
    S: [...BASE_FORBIDDEN_NEXT.S],
  };
  if (rules.consentePomeriggioDiurno) forbidden.P = forbidden.P.filter(s => s !== 'D');
  // D→D stays in the forbidden table: the ONLY allowed pair is the structural
  // "doppio D mensile" checked directly in transitionOk (isDoppioDPair).

  // Per-nurse properties
  const nurseProps = nurses.map(n => ({
    soloMattine: n.tags.includes('solo_mattine'),
    quattroMattineVenerdiNotte: n.tags.includes('quattro_mattine_venerdi_notte'),
    soloDiurni: n.tags.includes('solo_diurni'),
    soloNotti: n.tags.includes('solo_notti'),
    diurniENotturni: n.tags.includes('diurni_e_notturni'),
    noNotti: n.tags.includes('no_notti'),
    diurniNoNotti: n.tags.includes('diurni_no_notti'),
    noDiurni: n.tags.includes('no_diurni') || n.tags.includes('quattro_mattine_venerdi_notte'),
    mattineEPomeriggi: n.tags.includes('mattine_e_pomeriggi'),
  }));

  // Day-of-week cache & week index helpers
  const dows = [];
  for (let d = 0; d < numDays; d++) dows.push(dayOfWeek(year, month, d + 1));
  const firstDow = dayOfWeek(year, month, 1);
  const adjustedFirstDow = firstDow === 0 ? 6 : firstDow - 1;
  const weekOf = d => Math.floor((d + adjustedFirstDow) / 7);
  const numWeeks = weekOf(numDays - 1) + 1;

  // Coverage targets
  const minCovM = rules.minCoverageM ?? 6,
    maxCovM = rules.maxCoverageM ?? 7;
  const minCovP = rules.minCoverageP ?? 6,
    maxCovP = rules.maxCoverageP ?? 7;
  const minCovD = rules.minCoverageD ?? 0,
    maxCovD = rules.maxCoverageD ?? 4;
  const minCovN = rules.minCoverageN ?? 6,
    maxCovN = rules.maxCoverageN ?? 6;

  const targetNights = rules.targetNights ?? 4;
  // maxNights is the soft monthly night cap; hardMaxNights ("Notti massime assolute")
  // is the absolute per-nurse limit. The soft cap can never exceed the hard cap.
  const hardMaxNights = rules.hardMaxNights ?? rules.maxNights ?? 7;
  const maxNights = Math.min(rules.maxNights ?? 7, hardMaxNights);
  const minRPerWeek = rules.minRPerWeek ?? 2;
  // M/P/N matrix (no_diurni): rests only after the smonto (N-S-R or N-S-R-R),
  // at most maxRPerWeek per calendar week, at least 2 M/P days before each
  // night and at most maxSequenzaLavoro shifts in a row NIGHT INCLUDED.
  const maxRPerWeek = rules.maxRPerWeek ?? 2;
  const maxSequenzaLavoro = rules.maxSequenzaLavoro ?? 5;
  // Optional: once per month a doppia notte N-N-S-R-R (two rests after it).
  const doppiaNotteMensile = !!rules.doppiaNotteMensile;

  // Hour limits: the UI sliders express WEEKLY hours (min/max per settimana).
  // Convert them to monthly thresholds using the number of weekdays in the month
  // (5 weekdays = one contract week). Values above 60 cannot come from the weekly
  // sliders and are treated as already-monthly for backward compatibility.
  const weeksEquivalent = countWeekdaysInMonth(year, month) / 5;
  const minHoursRule = rules.minHours || 0;
  const minMonthlyHours = minHoursRule > 60 ? minHoursRule : Math.round(minHoursRule * weeksEquivalent * 10) / 10;
  const maxHoursRule = rules.maxHours || 0;
  const maxMonthlyHours =
    maxHoursRule > 0
      ? maxHoursRule > 60
        ? maxHoursRule
        : Math.round(maxHoursRule * weeksEquivalent * 10) / 10
      : Infinity;
  // Weekly fluctuation band (soft): the same sliders, kept at weekly scale.
  // Weeks may fluctuate between these bounds while the monthly band stays hard.
  const weeklyMinHours = minHoursRule > 60 ? 0 : minHoursRule;
  const weeklyMaxHours = maxHoursRule > 0 && maxHoursRule <= 60 ? maxHoursRule : Infinity;
  const preferDiurni = rules.preferDiurni ?? false;
  const coppiaTurni = rules.coppiaTurni ?? null;
  // "Doppio D mensile": at most ONE extra D per month per diurni_e_notturni
  // nurse, replacing the SECOND rest of a D-N-S-R-R block (never the first,
  // never right after the smonto) to recover the structural hour deficit of
  // the rigid matrix. Enforced in transitionOk/scoring; placed by repairDoppioD.
  const consenteDoppioDMensile = rules.consenteDoppioDMensile ?? false;
  // Night on-call: each day with nights needs an eligible on-call (smonto today
  // with diurni in use, morning today otherwise). Off unless explicitly enabled.
  const reperibileNotturno = rules.reperibileNotturno ?? false;
  // Day on-call on Sundays/holidays: assigned to a nurse working the night that
  // day. Off unless explicitly enabled by the rules, and structurally impossible
  // when nights are disallowed (maxCovN = 0) — disabled in that case so the
  // solver does not chase an unsatisfiable hard constraint.
  const reperibileDiurnoFestivo = maxCovN > 0 ? (rules.reperibileDiurnoFestivo ?? false) : false;

  // Precomputed Sunday/holiday flags for the month (festivi[d], 0-based day)
  const festivi = [];
  for (let d = 0; d < numDays; d++) festivi.push(isFestivoItaliano(year, month, d + 1));

  // Pre-compute pinned cells (absences + solo_mattine)
  // pinned[n][d] = shift code or null
  const pinned = Array.from({ length: numNurses }, () => new Array(numDays).fill(null));
  for (let n = 0; n < numNurses; n++) {
    const nurse = nurses[n];
    for (let d = 0; d < numDays; d++) {
      const abs = getAbsenceShift(nurse, d + 1, year, month);
      if (abs) {
        pinned[n][d] = abs;
        continue;
      }
      if (nurseProps[n].quattroMattineVenerdiNotte) {
        if (dows[d] >= 1 && dows[d] <= 4) pinned[n][d] = 'M';
        else if (dows[d] === 5) pinned[n][d] = 'N';
        else if (dows[d] === 6) pinned[n][d] = 'S';
        else pinned[n][d] = 'R';
      } else if (nurseProps[n].soloMattine) {
        pinned[n][d] = dows[d] === 0 || dows[d] === 6 ? 'R' : 'M';
      } else if (nurseProps[n].mattineEPomeriggi || (nurseProps[n].noNotti && nurseProps[n].noDiurni)) {
        // M/P matrix (5 work + 2 adjacent rests): the rests are FIXED on
        // Saturday+Sunday (ward rule) - work days stay free for the M/P mix.
        if (dows[d] === 0 || dows[d] === 6) pinned[n][d] = 'R';
      }
    }
  }

  // Previous month tail: pin mandatory continuation days at month start
  // Handles the N→S→R(→R) continuation across the month boundary
  const prevTail = previousMonthTail || null;
  if (prevTail) {
    for (let n = 0; n < numNurses; n++) {
      const tail = prevTail[n];
      if (!tail || tail.length === 0) continue;
      const last = tail[tail.length - 1];
      const secondLast = tail.length >= 2 ? tail[tail.length - 2] : null;

      // For diurni_e_notturni the night block is the rigid N-S-R-R, so the
      // second R must be pinned too when the block crosses the month boundary.
      const rigidSecondR = nurseProps[n].diurniENotturni;
      const thirdLast = tail.length >= 3 ? tail[tail.length - 3] : null;
      if (last === 'N') {
        // N on last day → need S, R at start (second R only for rigid D/N)
        if (!pinned[n][0]) pinned[n][0] = 'S';
        if (numDays > 1 && !pinned[n][1]) pinned[n][1] = 'R';
        if (rigidSecondR && numDays > 2 && !pinned[n][2]) pinned[n][2] = 'R';
      } else if (last === 'S' && secondLast === 'N') {
        // N-S on last two days → need R at start
        if (!pinned[n][0]) pinned[n][0] = 'R';
        if (rigidSecondR && numDays > 1 && !pinned[n][1]) pinned[n][1] = 'R';
      } else if (rigidSecondR && last === 'R' && secondLast === 'S' && thirdLast === 'N') {
        // N-S-R on last three days → the rigid block still owes the second R
        if (!pinned[n][0]) pinned[n][0] = 'R';
      }
    }
  }

  // Desiderate (requested days): pin the requested shift on each free cell.
  // Requested nights bring their mandatory recovery tail along (S, R and the
  // second R for the rigid diurni_e_notturni matrix). Requests incompatible
  // with the nurse's limitation tags are ignored.
  for (let n = 0; n < numNurses; n++) {
    const nurse = nurses[n];
    if (!nurse.tags.includes('desiderate') || !nurse.desiderate) continue;
    for (let d = 0; d < numDays; d++) {
      if (pinned[n][d]) continue;
      const wish = getDesiderataShift(nurse, d + 1, year, month);
      if (!wish) continue;
      // Tag compatibility: isRepairShiftAllowed covers M/P/D/R; a requested
      // night is valid for every profile that may work nights.
      const wishAllowed =
        wish === 'R' ||
        (wish === 'N'
          ? !(
              nurseProps[n].noNotti ||
              nurseProps[n].diurniNoNotti ||
              nurseProps[n].mattineEPomeriggi ||
              nurseProps[n].soloMattine ||
              nurseProps[n].soloDiurni
            )
          : isRepairShiftAllowed(nurseProps[n], wish));
      if (!wishAllowed) continue;
      pinned[n][d] = wish;
      if (wish === 'N') {
        if (d + 1 < numDays && !pinned[n][d + 1]) pinned[n][d + 1] = 'S';
        if (d + 2 < numDays && !pinned[n][d + 2]) pinned[n][d + 2] = 'R';
        if (nurseProps[n].diurniENotturni && d + 3 < numDays && !pinned[n][d + 3]) pinned[n][d + 3] = 'R';
      }
    }
  }

  // Precompute week day-lists
  const weekDaysList = Array.from({ length: numWeeks }, () => []);
  for (let d = 0; d < numDays; d++) weekDaysList[weekOf(d)].push(d);

  return {
    year,
    month,
    nurses,
    rules,
    numDays,
    numNurses,
    forbidden,
    nurseProps,
    dows,
    weekOf,
    numWeeks,
    pinned,
    weekDaysList,
    minCovM,
    maxCovM,
    minCovP,
    maxCovP,
    minCovD,
    maxCovD,
    minCovN,
    maxCovN,
    targetNights,
    maxNights,
    hardMaxNights,
    minMonthlyHours,
    maxMonthlyHours,
    weeklyMinHours,
    weeklyMaxHours,
    minRPerWeek,
    maxRPerWeek,
    maxSequenzaLavoro,
    doppiaNotteMensile,
    preferDiurni,
    coppiaTurni,
    consenteDoppioDMensile,
    reperibileNotturno,
    reperibileDiurnoFestivo,
    festivi,
    monthlyTargetHours,
    hourDeltas: hourDeltas || null,
    nightCarryover,
    festiviCarryover,
    prevTail,
  };
}

// Requested shift for a day from the nurse's desiderate map
// ({ 'YYYY-MM-DD': 'M'|'P'|'D'|'N'|'R' }), or null.
function getDesiderataShift(nurse, day1Based, year, month) {
  if (!nurse.desiderate) return null;
  const key = `${year}-${String(month + 1).padStart(2, '0')}-${String(day1Based).padStart(2, '0')}`;
  const wish = nurse.desiderate[key];
  return wish === 'M' || wish === 'P' || wish === 'D' || wish === 'N' || wish === 'R' ? wish : null;
}

const WEEKEND_REST_ABSENCE_TAGS = new Set(['ferie', 'malattia', 'maternita', 'congedo_parentale']);

function getAbsenceShift(nurse, day1Based, year, month) {
  if (!nurse.absencePeriods) return null;
  for (const [tagKey, shiftCode] of Object.entries(ABSENCE_TAG_TO_SHIFT)) {
    if (!nurse.tags.includes(tagKey)) continue;
    const period = nurse.absencePeriods[tagKey];
    if (period && period.start && period.end) {
      const ds = `${year}-${String(month + 1).padStart(2, '0')}-${String(day1Based).padStart(2, '0')}`;
      if (ds >= period.start && ds <= period.end) {
        // Ferie/malattia/maternita/congedo parentale credit 5 paid days out of
        // every 7 of absence, counted from the period START (ward works on 5
        // shifts + 2 rests a week): days 6-7 of each rolling block keep the
        // absence CODE in the grid but assign 0 hours (the '0' variant). An
        // absence starting on Saturday therefore pays the weekend and leaves
        // the two unpaid days later in the block.
        if (WEEKEND_REST_ABSENCE_TAGS.has(tagKey)) {
          const [sy, sm, sd] = period.start.split('-').map(Number);
          const dayIdx = Math.round((new Date(year, month, day1Based) - new Date(sy, sm - 1, sd)) / 86400000);
          if (dayIdx % 7 >= 5) return shiftCode + '0';
        }
        return shiftCode;
      }
    } else {
      // No dates → absent indefinitely: anchor the two unpaid days on the
      // calendar weekend (Saturday+Sunday).
      if (WEEKEND_REST_ABSENCE_TAGS.has(tagKey) && isWeekend(year, month, day1Based)) return shiftCode + '0';
      return shiftCode;
    }
  }
  return null;
}
