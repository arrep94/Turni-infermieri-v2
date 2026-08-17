/**
 * @file property.test.js — Property-based tests over the full solve pipeline
 * plus targeted tests for the new solver features (coordinated M/P stagger,
 * festivi-aware reperibile diurno repair, long-term night/festivi equity).
 *
 * The property tests generate seeded random rosters, run construct + localSearch
 * (repairs included) and assert the STRUCTURAL INVARIANTS that must hold on any
 * output schedule regardless of the roster:
 *   1. pinned cells are never overwritten
 *   2. M/P-matrix nurses: max 5 consecutive work days, R-R pairs adjacent
 *   3. every N is followed by S then R (second R too for diurni_e_notturni)
 *   4. no forbidden N→X transition survives
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
    'solver/solvers.js',
  ];

  const context = {
    self: {},
    console,
    Math,
    Date,
    Array,
    Object,
    Map,
    Set,
    String,
    Number,
    Boolean,
    RegExp,
    JSON,
    Error,
    TypeError,
    RangeError,
    Infinity,
    NaN,
    undefined,
    parseInt,
    parseFloat,
    isNaN,
    isFinite,
    importScripts: () => {},
    postMessage: () => {},
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    Promise,
  };

  vm.createContext(context);
  vm.runInContext('function progress() {}', context);

  const jsDir = path.join(__dirname, '..', 'js');
  for (const file of moduleFiles) {
    const code = fs.readFileSync(path.join(jsDir, file), 'utf8');
    vm.runInContext(code, context, { filename: file });
  }
  return context;
}

function toPlain(v) {
  return JSON.parse(JSON.stringify(v));
}

let ctx;

before(() => {
  ctx = loadSolver();
});

// Deterministic LCG so every run generates the same rosters.
function makeRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const TAG_POOL = [[], [], [], ['mattine_e_pomeriggi'], ['diurni_e_notturni'], ['no_notti'], ['no_diurni']];

function randomConfig(rng, seedIdx) {
  const numNurses = 8 + Math.floor(rng() * 5); // 8–12
  const nurses = [];
  for (let i = 0; i < numNurses; i++) {
    nurses.push({ name: `N${i}`, tags: TAG_POOL[Math.floor(rng() * TAG_POOL.length)].slice(), absencePeriods: {} });
  }
  const months = [
    [2026, 0],
    [2026, 3],
    [2026, 5],
    [2026, 8],
  ];
  const [year, month] = months[seedIdx % months.length];
  return {
    year,
    month,
    nurses,
    rules: {
      minCoverageM: 2,
      maxCoverageM: 4,
      minCoverageP: 2,
      maxCoverageP: 4,
      minCoverageD: 0,
      maxCoverageD: rng() < 0.5 ? 0 : 2,
      minCoverageN: 1 + Math.floor(rng() * 2),
      maxCoverageN: 3,
      targetHours: 36,
      minHours: 28,
      maxHours: 42,
      targetNights: 4,
      maxNights: 6,
      hardMaxNights: 7,
      minGap11h: true,
      minRPerWeek: 2,
      reperibileNotturno: false,
      reperibileDiurnoFestivo: false,
      fasciaOraria: 'auto',
    },
  };
}

function solveInVM(config, seed, iters = 3000, budgetSec = 2) {
  const script = `(function () {
    const config = ${JSON.stringify(config)};
    const c = buildContext(config);
    const schedule = withSeededRandom(${seed}, () => localSearch(construct(c), c, ${iters}, ${budgetSec}));
    return { schedule, pinned: c.pinned, numDays: c.numDays };
  })()`;
  return toPlain(vm.runInContext(script, ctx));
}

function isMPLimited(tags) {
  return tags.includes('mattine_e_pomeriggi') || (tags.includes('no_notti') && tags.includes('no_diurni'));
}

describe('property: invarianti strutturali su roster casuali', () => {
  for (let seedIdx = 0; seedIdx < 4; seedIdx++) {
    it(`seed ${seedIdx}: pinned, matrici M/P e blocchi notte rispettati`, () => {
      const rng = makeRng(1000 + seedIdx * 77);
      const config = randomConfig(rng, seedIdx);
      const { schedule, pinned, numDays } = solveInVM(config, 42 + seedIdx);

      for (let n = 0; n < config.nurses.length; n++) {
        const label = `nurse ${n} [${config.nurses[n].tags.join(',')}] seed ${seedIdx}`;
        const row = schedule[n];

        // 1. Pinned cells never overwritten
        for (let d = 0; d < numDays; d++) {
          if (pinned[n][d]) {
            assert.equal(row[d], pinned[n][d], `${label}: pinned cell day ${d + 1} overwritten`);
          }
        }

        // 3+4. Night block: N → S → R (…R for diurni_e_notturni); N never followed by work
        const isDN = config.nurses[n].tags.includes('diurni_e_notturni');
        for (let d = 0; d < numDays; d++) {
          if (row[d] !== 'N') continue;
          if (d + 1 < numDays) assert.equal(row[d + 1], 'S', `${label}: day ${d + 2} after N must be S`);
          if (d + 2 < numDays) assert.equal(row[d + 2], 'R', `${label}: day ${d + 3} after N-S must be R`);
          if (isDN && d + 3 < numDays) {
            assert.equal(row[d + 3], 'R', `${label}: rigid D-N-S-R-R needs the second R on day ${d + 4}`);
          }
        }

        // 2. M/P matrix: never more than 5 consecutive work days; R-R adjacent
        if (isMPLimited(config.nurses[n].tags)) {
          let run = 0;
          for (let d = 0; d < numDays; d++) {
            if (row[d] === 'M' || row[d] === 'P') run++;
            else run = 0;
            assert.ok(run <= 5, `${label}: ${run} consecutive work days at day ${d + 1} (max 5)`);
          }
          for (let d = 0; d < numDays; d++) {
            if (row[d] !== 'R') continue;
            const prevR = d > 0 && row[d - 1] === 'R';
            const nextR = d + 1 < numDays && row[d + 1] === 'R';
            assert.ok(prevR || nextR, `${label}: lone R at day ${d + 1} (R-R pair must stay adjacent)`);
          }
        }
      }
    });
  }
});

describe('rotazione sfalsata coordinata (matrici M/P)', () => {
  it('i riposi delle matrici M/P non si concentrano sugli stessi giorni', () => {
    const nurses = [];
    for (let i = 0; i < 7; i++) nurses.push({ name: `MP${i}`, tags: ['mattine_e_pomeriggi'], absencePeriods: {} });
    for (let i = 0; i < 4; i++) nurses.push({ name: `Free${i}`, tags: [], absencePeriods: {} });
    const config = {
      year: 2026,
      month: 2, // March 2026, 31 days
      nurses,
      rules: {
        minCoverageM: 2,
        maxCoverageM: 6,
        minCoverageP: 2,
        maxCoverageP: 6,
        minCoverageD: 0,
        maxCoverageD: 0,
        minCoverageN: 1,
        maxCoverageN: 2,
        targetHours: 36,
        minHours: 28,
        maxHours: 42,
        targetNights: 4,
        maxNights: 6,
        hardMaxNights: 7,
        minRPerWeek: 2,
        reperibileNotturno: false,
        reperibileDiurnoFestivo: false,
        fasciaOraria: 'auto',
      },
    };
    const result = toPlain(
      vm.runInContext(
        `(function () {
          const config = ${JSON.stringify(config)};
          const c = buildContext(config);
          const schedule = withSeededRandom(7, () => construct(c));
          return { schedule, numDays: c.numDays };
        })()`,
        ctx
      )
    );
    // 7 nurses × 2 R per 7-day cycle = on average 2 resting per day; with the
    // coordinated stagger no single day may concentrate most of the group.
    for (let d = 0; d < result.numDays; d++) {
      let resting = 0;
      for (let n = 0; n < 7; n++) if (result.schedule[n][d] === 'R') resting++;
      assert.ok(resting <= 4, `day ${d + 1}: ${resting}/7 M/P-matrix nurses resting at once`);
    }
  });
});

describe('reperibile diurno festivo: riparazione con minCoverageN = 0', () => {
  it('piazza un blocco notte su un festivo senza notti quando la reperibilità lo richiede', () => {
    const nurses = [];
    for (let i = 0; i < 8; i++) nurses.push({ name: `N${i}`, tags: [], absencePeriods: {} });
    const config = {
      year: 2026,
      month: 3, // April 2026: Sundays 5/12/19/26, Pasquetta 6, Liberazione 25
      nurses,
      rules: {
        minCoverageM: 1,
        maxCoverageM: 6,
        minCoverageP: 1,
        maxCoverageP: 6,
        minCoverageD: 0,
        maxCoverageD: 0,
        minCoverageN: 0,
        maxCoverageN: 2,
        targetHours: 36,
        minHours: 28,
        maxHours: 42,
        targetNights: 4,
        maxNights: 6,
        hardMaxNights: 7,
        minRPerWeek: 2,
        reperibileNotturno: false,
        reperibileDiurnoFestivo: true,
        fasciaOraria: 'auto',
      },
    };
    const result = toPlain(
      vm.runInContext(
        `(function () {
          const config = ${JSON.stringify(config)};
          const c = buildContext(config);
          // Start from a grid with NO nights at all: alternate M/P work weeks
          // with weekly rests, so the only hard gaps are the festivo on-calls.
          const schedule = [];
          for (let n = 0; n < c.numNurses; n++) {
            const row = [];
            for (let d = 0; d < c.numDays; d++) {
              const slot = (d + n) % 7;
              row.push(slot >= 5 ? 'R' : slot >= 3 ? 'P' : 'M');
            }
            schedule.push(row);
          }
          const before = [];
          for (let d = 0; d < c.numDays; d++) {
            if (c.festivi[d]) before.push(hasNightOnDay(schedule, d, c.numNurses));
          }
          const repaired = withSeededRandom(11, () => repairReperibileDiurnoFestivo(schedule, c));
          const after = [];
          for (let d = 0; d < c.numDays; d++) {
            if (c.festivi[d]) after.push(hasNightOnDay(repaired, d, c.numNurses));
          }
          return { before, after };
        })()`,
        ctx
      )
    );
    assert.ok(
      result.before.every(v => v === false),
      'the starting grid must have no nights on festivi'
    );
    const coveredAfter = result.after.filter(Boolean).length;
    assert.ok(coveredAfter > 0, `repair covered no festivo at all (${result.after.length} festivi)`);
  });
});

describe('equità di lungo periodo (carryover notti/festivi)', () => {
  it('buildContext espone nightCarryover e festiviCarryover', () => {
    const result = toPlain(
      vm.runInContext(
        `(function () {
          const nurses = [
            { name: 'A', tags: [], absencePeriods: {} },
            { name: 'B', tags: [], absencePeriods: {} },
          ];
          const rules = { minCoverageM: 1, maxCoverageM: 2, minCoverageP: 1, maxCoverageP: 2,
            minCoverageD: 0, maxCoverageD: 0, minCoverageN: 0, maxCoverageN: 2, minRPerWeek: 2 };
          const c = buildContext({ year: 2026, month: 0, nurses, rules,
            equityCarryover: { nights: [2, -2], festivi: [1, -1] } });
          return { nights: c.nightCarryover, festivi: c.festiviCarryover };
        })()`,
        ctx
      )
    );
    assert.deepEqual(result.nights, [2, -2]);
    assert.deepEqual(result.festivi, [1, -1]);
  });

  it('il carryover notti sposta il target equo: stesso numero di notti costa di più a chi ne ha già fatte di più', () => {
    const result = toPlain(
      vm.runInContext(
        `(function () {
          const nurses = [
            { name: 'A', tags: [], absencePeriods: {} },
            { name: 'B', tags: [], absencePeriods: {} },
          ];
          const rules = { minCoverageM: 0, maxCoverageM: 4, minCoverageP: 0, maxCoverageP: 4,
            minCoverageD: 0, maxCoverageD: 0, minCoverageN: 0, maxCoverageN: 4,
            targetNights: 4, maxNights: 6, hardMaxNights: 8, minRPerWeek: 0 };
          const base = { year: 2026, month: 0, nurses, rules };
          const cPlain = buildContext(base);
          const cCarry = buildContext(Object.assign({}, base, { equityCarryover: { nights: [2, 0], festivi: null } }));
          // Same schedule: both nurses do exactly targetNights nights.
          const schedule = [];
          for (let n = 0; n < 2; n++) {
            const row = new Array(cPlain.numDays).fill('R');
            for (let b = 0; b < 4; b++) {
              const start = b * 7;
              row[start] = 'N'; row[start + 1] = 'S'; row[start + 2] = 'R';
            }
            schedule.push(row);
          }
          return { plain: computeScore(schedule, cPlain).soft, carry: computeScore(schedule, cCarry).soft };
        })()`,
        ctx
      )
    );
    // Nurse A carries +2 nights from last month: |4+2-4|*3 = 6 extra soft points.
    assert.equal(result.carry - result.plain, 6);
  });
});
