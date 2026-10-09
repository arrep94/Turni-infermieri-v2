/**
 * @file matrix-solver.test.js — Guarantees of the "Generatore a matrici"
 *
 * The matrix generator builds every nurse row with an exact DP over the
 * profile grammar, so these properties must hold on EVERY output:
 *   1. M/P/N (no_diurni) nurses rest only after the smonto (no rest islands)
 *      and never more than maxRPerWeek times per calendar week
 *   2. every N is followed by S then R; P→M never appears
 *   3. nobody goes under the personal monte ore when the matrix allows it
 *   4. diurni_e_notturni rows follow D-N-S-R-R with at most one doppio D,
 *      never at the month edges
 *   5. pinned cells (absences, desiderate) are kept
 */

'use strict';

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadSolver() {
  const moduleFiles = [
    'solver/constants.js',
    'solver/context.js',
    'solver/scoring.js',
    'solver/construct.js',
    'solver/local-search.js',
    'solver/pattern-planner.js',
    'solver/matrix-solver.js',
    'solver/solvers.js',
  ];
  const context = {
    self: {},
    console: { log() {}, warn() {}, error: console.error },
    Math,
    Date,
    Array,
    Object,
    Map,
    Set,
    String,
    Number,
    Boolean,
    JSON,
    Error,
    Infinity,
    NaN,
    undefined,
    parseInt,
    parseFloat,
    isNaN,
    isFinite,
    Float64Array,
    Int16Array,
    Int32Array,
    Uint8Array,
    progress: () => {},
  };
  vm.createContext(context);
  for (const file of moduleFiles) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'js', file), 'utf-8'), context, { filename: file });
  }
  return context;
}

const BASE_RULES = {
  minCoverageM: 6,
  maxCoverageM: 8,
  minCoverageP: 6,
  maxCoverageP: 8,
  minCoverageD: 0,
  maxCoverageD: 0,
  minCoverageN: 5,
  maxCoverageN: 6,
  targetHours: 36,
  minHours: 0,
  maxHours: 42,
  targetNights: 4,
  maxNights: 5,
  hardMaxNights: 6,
  minGap11h: true,
  minRPerWeek: 2,
  maxRPerWeek: 2,
  maxSequenzaLavoro: 5,
  consenteDoppioDMensile: true,
  reperibileNotturno: true,
  reperibileDiurnoFestivo: true,
  fasciaOraria: '7-10',
};

// The user's ward shape (anonymised): 1 solo_mattine, 1 mattine_e_pomeriggi,
// 1 quattro mattine + venerdì notte, 30 M/P/N rotating nurses.
function wardConfig(year, month, extra = {}) {
  const nurses = [];
  for (let i = 0; i < 33; i++) {
    let tags = ['no_diurni'];
    if (i === 0) tags = ['solo_mattine'];
    if (i === 4) tags = ['no_notti', 'mattine_e_pomeriggi'];
    if (i === 9) tags = ['no_diurni', 'quattro_mattine_venerdi_notte'];
    nurses.push({ id: `n${i}`, name: `Infermiere ${i + 1}`, tags, absencePeriods: {}, desiderate: {} });
  }
  return { year, month, nurses, rules: { ...BASE_RULES, ...extra } };
}

function assertMPNRows(S, cfg, schedule) {
  const ctx = S.buildContext(cfg);
  for (let n = 0; n < ctx.numNurses; n++) {
    if (!S.isRestrictedNoDiurniNightNurse(ctx.nurseProps[n])) continue;
    const row = schedule[n];
    for (let d = 0; d < row.length; d++) {
      assert.equal(S.isRestOutsideMPNMatrix(schedule, ctx, n, d), false, `isola di riposo n${n} g${d + 1}: ${row}`);
      if (d + 1 < row.length) {
        if (row[d] === 'N') assert.equal(row[d + 1], 'S', `N senza S n${n} g${d + 1}`);
        if (row[d] === 'S' && !ctx.pinned[n][d + 1]) assert.equal(row[d + 1], 'R', `S senza R n${n} g${d + 1}`);
        assert.ok(!(row[d] === 'P' && row[d + 1] === 'M'), `P→M n${n} g${d + 1}`);
      }
    }
    for (const wDays of ctx.weekDaysList) {
      assert.ok(S.countMatrixWeekRest(schedule, ctx, n, wDays) <= ctx.maxRPerWeek, `troppi riposi n${n}: ${row}`);
    }
  }
  return ctx;
}

describe('Generatore a matrici', () => {
  let S;
  before(() => {
    S = loadSolver();
  });

  it('reparto reale (gennaio 2027): matrici rispettate, notti coperte, nessuno sotto il monte ore', () => {
    const cfg = wardConfig(2027, 0);
    const res = S.withSeededRandom(12345, () => S.solveMatrix(cfg, 3));
    const ctx = assertMPNRows(S, cfg, res.schedule);
    for (let n = 0; n < ctx.numNurses; n++) {
      const h = S.nurseHours(res.schedule, n, ctx.numDays);
      assert.ok(h >= ctx.monthlyTargetHours - 0.01, `n${n} sotto monte ore: ${h}`);
    }
    for (let d = 0; d < ctx.numDays; d++) {
      const cov = S.dayCoverage(res.schedule, d, ctx.numNurses);
      assert.ok(cov.N >= 5, `notte scoperta il giorno ${d + 1}`);
      assert.ok(cov.M >= 6 && cov.P >= 6, `M/P scoperti il giorno ${d + 1}`);
    }
    const types = new Set(res.violations.map(v => v.type));
    for (const t of ['riposo_fuori_matrice', 'troppi_riposi_settimana', 'isola_di_riposo', 'transition', 'S_no_R'])
      assert.ok(!types.has(t), `violazione ${t}`);
  });

  it('con ferie, malattie, desiderate e continuità: le matrici restano integre', () => {
    let prevTail = null;
    for (const [month, seed] of [
      [3, 7],
      [4, 11],
    ]) {
      const cfg = wardConfig(2027, month);
      const mm = String(month + 1).padStart(2, '0');
      cfg.nurses[2].tags.push('ferie');
      cfg.nurses[2].absencePeriods.ferie = { start: `2027-${mm}-05`, end: `2027-${mm}-11` };
      cfg.nurses[14].tags.push('malattia');
      cfg.nurses[14].absencePeriods.malattia = { start: `2027-${mm}-14`, end: `2027-${mm}-16` };
      cfg.nurses[20].tags.push('desiderate');
      cfg.nurses[20].desiderate[`2027-${mm}-20`] = 'R';
      cfg.previousMonthTail = prevTail;
      const res = S.withSeededRandom(seed, () => S.solveMatrix(cfg, 2));
      const ctx = assertMPNRows(S, cfg, res.schedule);
      for (let n = 0; n < ctx.numNurses; n++)
        for (let d = 0; d < ctx.numDays; d++)
          if (ctx.pinned[n][d]) assert.equal(res.schedule[n][d], ctx.pinned[n][d], `cella fissata n${n} g${d + 1}`);
      assert.equal(res.schedule[20][19], 'R');
      prevTail = res.schedule.map(r => r.slice(-7));
    }
  });

  it('matrice D/N: D-N-S-R-R con al massimo un doppio D, mai ai bordi del mese', () => {
    const cfg = wardConfig(2027, 0, {
      minCoverageM: 6,
      maxCoverageM: 9,
      minCoverageP: 6,
      maxCoverageP: 9,
      minCoverageD: 6,
      maxCoverageD: 8,
      minCoverageN: 6,
      maxCoverageN: 7,
      maxNights: 7,
      hardMaxNights: 7,
      fasciaOraria: 'auto',
    });
    cfg.nurses = cfg.nurses.map((n, i) => ({ ...n, tags: i === 0 ? ['solo_mattine'] : ['diurni_e_notturni'] }));
    const res = S.withSeededRandom(99, () => S.solveMatrix(cfg, 3));
    const ctx = S.buildContext(cfg);
    for (let n = 1; n < ctx.numNurses; n++) {
      const row = res.schedule[n].join('');
      // Only D, N, S, R in the row, and the D-D pair must be preceded by N-S-R.
      assert.match(row, /^[DNSR]+$/);
      const pairs = [...row.matchAll(/DD/g)];
      assert.ok(pairs.length <= 1, `più doppi D: ${row}`);
      for (const p of pairs) assert.ok(p.index >= 3 && row.slice(p.index - 3, p.index) === 'NSR', `doppio D: ${row}`);
      assert.ok(!row.endsWith('RD') || row.endsWith('RRD'), `doppio D troncato: ${row}`);
      const types = res.violations.filter(v => v.nurse === n).map(v => v.type);
      for (const t of ['transition', 'need_2R_after_night', 'd_night_pattern', 'doppio_d_multiplo'])
        assert.ok(!types.includes(t), `${t} su ${row}`);
    }
  });

  it('segnala come violazione un riposo non preceduto dallo smonto', () => {
    const cfg = wardConfig(2027, 0);
    cfg.previousMonthTail = cfg.nurses.map(() => ['M', 'M', 'P', 'N', 'S', 'R', 'M']);
    const ctx = S.buildContext(cfg);
    const schedule = cfg.nurses.map(() => new Array(ctx.numDays).fill('M'));
    schedule[1][5] = 'R';
    assert.equal(S.isRestOutsideMPNMatrix(schedule, ctx, 1, 5), true);
    const v = S.collectViolations(schedule, ctx).filter(x => x.type === 'riposo_fuori_matrice');
    assert.equal(v.length, 1);
    assert.equal(v[0].nurse, 1);
  });
});
