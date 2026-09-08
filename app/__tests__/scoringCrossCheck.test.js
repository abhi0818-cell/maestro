/**
 * scoringCrossCheck.test.js
 *
 * Asserts that the web scoring engine (tests/web-scoring-engine.js, extracted
 * from index.html) and the mobile TS engine (src/engine/cricketScoringEngine.ts)
 * produce IDENTICAL output for the same inputs.
 *
 * This is the core safety net from Phase 1: any time the two implementations
 * drift, these tests fail before the discrepancy can cause a wrong leaderboard.
 *
 * Run: cd app && node -r ./node_modules/sucrase/register --test __tests__/scoringCrossCheck.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

// Web engine (plain CommonJS, no DOM needed)
const web = require('../../tests/web-scoring-engine.js');

// Mobile engine loaded via sucrase (TS → CJS on the fly)
const mob = require('../src/engine/cricketScoringEngine');

// ─── Shared fixtures ──────────────────────────────────────────────────────────

const BATTING_CASES = [
  { label: 'basic batter 30 runs',        inn: { runs: 30, ballsFaced: 25, fours: 2, sixes: 0, isDismissed: false, role: 'bat' } },
  { label: '30-run bonus, no half-century', inn: { runs: 32, ballsFaced: 26, fours: 1, sixes: 0, isDismissed: false, role: 'bat' } },
  { label: 'below 30 — no milestone bonus', inn: { runs: 29, ballsFaced: 25, fours: 0, sixes: 0, isDismissed: false, role: 'bat' } },
  { label: '50+ bonus',                   inn: { runs: 55, ballsFaced: 40, fours: 3, sixes: 1, isDismissed: true,  role: 'bat' } },
  { label: 'century',                     inn: { runs: 110,ballsFaced: 80, fours: 8, sixes: 4, isDismissed: false, role: 'bat' } },
  { label: 'duck — batter',               inn: { runs: 0,  ballsFaced: 4,  fours: 0, sixes: 0, isDismissed: true,  role: 'bat' } },
  { label: 'duck — bowler (no penalty)',  inn: { runs: 0,  ballsFaced: 4,  fours: 0, sixes: 0, isDismissed: true,  role: 'bowl' } },
  { label: 'SR > 170',                    inn: { runs: 20, ballsFaced: 10, fours: 2, sixes: 0, isDismissed: false, role: 'bat' } },
  { label: 'SR 140-170',                  inn: { runs: 15, ballsFaced: 10, fours: 1, sixes: 0, isDismissed: false, role: 'bat' } },
  { label: 'SR < 70',                     inn: { runs: 5,  ballsFaced: 10, fours: 0, sixes: 0, isDismissed: false, role: 'bat' } },
  { label: 'SR 70-100 penalty',           inn: { runs: 8,  ballsFaced: 10, fours: 0, sixes: 0, isDismissed: false, role: 'bat' } },
  { label: '< 10 balls — no SR',         inn: { runs: 9,  ballsFaced: 5,  fours: 0, sixes: 0, isDismissed: false, role: 'bat' } },
];

const BOWLING_CASES = [
  { label: '2 wickets, good eco',         spell: { wickets: 2, wicketTypes: [], maidens: 0, runsConceded: 16, ballsBowled: 24, dotBalls: 4, noBalls: 0, wides: 0 } },
  { label: 'lbw + bowled bonus',          spell: { wickets: 2, wicketTypes: ['lbw','bowled'], maidens: 0, runsConceded: 20, ballsBowled: 18, dotBalls: 3, noBalls: 0, wides: 0 } },
  { label: 'maiden over',                 spell: { wickets: 0, wicketTypes: [], maidens: 2, runsConceded: 0, ballsBowled: 12, dotBalls: 12, noBalls: 0, wides: 0 } },
  { label: 'expensive: eco > 11',         spell: { wickets: 0, wicketTypes: [], maidens: 0, runsConceded: 50, ballsBowled: 24, dotBalls: 0, noBalls: 0, wides: 0 } },
  { label: 'no-balls and wides',          spell: { wickets: 1, wicketTypes: [], maidens: 0, runsConceded: 15, ballsBowled: 12, dotBalls: 2, noBalls: 2, wides: 3 } },
  { label: 'ODI 5-wkt haul',             spell: { wickets: 5, wicketTypes: [], maidens: 0, runsConceded: 30, ballsBowled: 48, dotBalls: 0, noBalls: 0, wides: 0 }, fmt: 'ODI' },
  { label: 'ODI 4-wkt haul',             spell: { wickets: 4, wicketTypes: [], maidens: 0, runsConceded: 25, ballsBowled: 36, dotBalls: 0, noBalls: 0, wides: 0 }, fmt: 'ODI' },
  { label: 'T20 5-wkt haul',             spell: { wickets: 5, wicketTypes: [], maidens: 0, runsConceded: 30, ballsBowled: 24, dotBalls: 0, noBalls: 0, wides: 0 } },
  { label: 'T20 4-wkt haul',             spell: { wickets: 4, wicketTypes: [], maidens: 0, runsConceded: 25, ballsBowled: 24, dotBalls: 0, noBalls: 0, wides: 0 } },
  { label: 'T20 3-wkt haul',             spell: { wickets: 3, wicketTypes: [], maidens: 0, runsConceded: 20, ballsBowled: 24, dotBalls: 0, noBalls: 0, wides: 0 } },
  { label: 'T20 2 wickets — no haul bonus', spell: { wickets: 2, wicketTypes: [], maidens: 0, runsConceded: 20, ballsBowled: 24, dotBalls: 0, noBalls: 0, wides: 0 } },
  { label: 'confirmed hat-trick, 3-wkt haul stacks', spell: { wickets: 3, wicketTypes: [], maidens: 0, runsConceded: 20, ballsBowled: 24, dotBalls: 0, noBalls: 0, wides: 0, hattrick: true } },
  { label: 'confirmed hat-trick, 5-wkt haul stacks', spell: { wickets: 5, wicketTypes: [], maidens: 0, runsConceded: 30, ballsBowled: 24, dotBalls: 0, noBalls: 0, wides: 0, hattrick: true }, fmt: 'ODI' },
  { label: '3+ wickets, hattrick not yet confirmed', spell: { wickets: 3, wicketTypes: [], maidens: 0, runsConceded: 20, ballsBowled: 24, dotBalls: 0, noBalls: 0, wides: 0, hattrick: false } },
  { label: '≤ 6 balls: no eco bonus',    spell: { wickets: 1, wicketTypes: [], maidens: 0, runsConceded: 4, ballsBowled: 6, dotBalls: 2, noBalls: 0, wides: 0 } },
];

const FIELDING_CASES = [
  { label: '2 catches', f: { catches: 2, stumpings: 0, runOutDirect: 0, runOutIndirect: 0 } },
  { label: 'stumping',  f: { catches: 0, stumpings: 1, runOutDirect: 0, runOutIndirect: 0 } },
  { label: 'direct RO', f: { catches: 0, stumpings: 0, runOutDirect: 1, runOutIndirect: 0 } },
  { label: 'mixed',     f: { catches: 1, stumpings: 1, runOutDirect: 1, runOutIndirect: 2 } },
];

// ─── SCORING_RULES constants match ───────────────────────────────────────────

describe('SCORING_RULES — web vs mobile constants identical', () => {
  for (const fmt of ['T20', 'ODI', 'TEST']) {
    it(`${fmt} rules match`, () => {
      const webRules = web.DEFAULT_SCORING_RULES[fmt];
      const mobRules = mob.SCORING_RULES[fmt];
      for (const [key, val] of Object.entries(webRules)) {
        assert.equal(mobRules[key], val, `${fmt}.${key}: web=${val} mob=${mobRules[key]}`);
      }
      // Mobile may have keys web doesn't — verify no extras either way
      for (const [key, val] of Object.entries(mobRules)) {
        assert.equal(webRules[key], val, `${fmt}.${key} extra in mobile: web=${webRules[key]} mob=${val}`);
      }
    });
  }

  it('MULTIPLIERS match', () => {
    for (const [key, val] of Object.entries(web.MULTIPLIERS)) {
      assert.equal(mob.MULTIPLIERS[key], val);
    }
  });
});

// ─── Batting cross-check ──────────────────────────────────────────────────────

describe('calcBatting — web vs mobile identical', () => {
  for (const { label, inn } of BATTING_CASES) {
    it(label, () => {
      const w = web.calcBatting(inn, 'T20');
      const m = mob.calcBattingPoints(inn, 'T20');
      assert.equal(w.points, m.points, `points mismatch: web=${w.points} mob=${m.points}`);
      // Key breakdown entries must match
      for (const key of ['runs','boundary4','boundary6','thirtyRunBonus','half_century','century','duck','strikeRateBonus']) {
        const wv = w.breakdown[key] ?? 0;
        const mv = m.breakdown[key] ?? 0;
        assert.equal(wv, mv, `breakdown.${key}: web=${wv} mob=${mv}`);
      }
    });
  }
});

// ─── Bowling cross-check ──────────────────────────────────────────────────────

describe('calcBowling — web vs mobile identical', () => {
  for (const { label, spell, fmt = 'T20' } of BOWLING_CASES) {
    it(label, () => {
      const w = web.calcBowling(spell, fmt);
      const m = mob.calcBowlingPoints(spell, fmt);
      assert.equal(w.points, m.points, `points: web=${w.points} mob=${m.points}`);
      for (const key of ['wickets','lbwBowledBonus','maidens','dotBalls','economyBonus','noBalls','wides','fiveWicket','fourWicket','threeWicket','hattrick']) {
        const wv = w.breakdown[key] ?? 0;
        const mv = m.breakdown[key] ?? 0;
        assert.equal(wv, mv, `breakdown.${key}: web=${wv} mob=${mv}`);
      }
    });
  }

  it('dot_ball clamped to 0 via rulesOverride — both engines agree', () => {
    const spell = { wickets: 1, wicketTypes: [], maidens: 0, runsConceded: 10, ballsBowled: 12, dotBalls: 5, noBalls: 0, wides: 0 };
    const override = { ...web.DEFAULT_SCORING_RULES.T20, dot_ball: 0 };
    const w = web.calcBowling(spell, 'T20', override);
    const m = mob.calcBowlingPoints(spell, 'T20', override);
    assert.equal(w.breakdown.dotBalls, 0);
    assert.equal(m.breakdown.dotBalls, 0);
    assert.equal(w.points, m.points);
  });
});

// ─── Fielding cross-check ─────────────────────────────────────────────────────

describe('calcFielding — web vs mobile identical', () => {
  for (const { label, f } of FIELDING_CASES) {
    it(label, () => {
      const w = web.calcFielding(f, 'T20');
      const m = mob.calcFieldingPoints(f, 'T20');
      assert.equal(w.points, m.points, `points: web=${w.points} mob=${m.points}`);
    });
  }
});

// ─── calculateScore — captaincy + boosters cross-check ───────────────────────

describe('calculateScore — web vs mobile identical', () => {
  const player = {
    name: 'TestPlayer',
    role: 'bat',
    captaincy: 'normal',
    is_overseas: false,
    batting: { runs: 60, ballsFaced: 45, fours: 5, sixes: 2, isDismissed: false },
    bowling: { wickets: 1, wicketTypes: ['lbw'], maidens: 0, runsConceded: 24, ballsBowled: 18, dotBalls: 4, noBalls: 0, wides: 0 },
    fielding: { catches: 1, stumpings: 0, runOutDirect: 0, runOutIndirect: 0 },
  };

  const captancyCases = ['normal', 'captain', 'vice_captain'];
  const boosterCases  = [undefined, 'triple_captain', 'dual_captain', 'team_double', 'wildcard', 'free_hit'];

  for (const cap of captancyCases) {
    for (const booster of boosterCases) {
      const label = `captaincy=${cap}${booster ? ' booster='+booster : ''}`;
      it(label, () => {
        const p = { ...player, captaincy: cap };
        // Web: calculateScore(player, fmt, rulesOverride, booster)
        // Mobile: calculateScore(player, fmt, booster)
        const w = web.calculateScore(p, 'T20', null, booster);
        const m = mob.calculateScore(p, 'T20', booster);
        // totalPoints and rawPoints must be identical — this is the critical check.
        assert.equal(w.totalPoints, m.totalPoints, `totalPoints: web=${w.totalPoints} mob=${m.totalPoints}`);
        assert.equal(w.rawPoints,   m.rawPoints,   `rawPoints: web=${w.rawPoints} mob=${m.rawPoints}`);
        // NOTE: multiplier is intentionally NOT checked here for player-class boosters
        // (team_double, os_double, indian_double). Web combines captaincy × booster into
        // one `multiplier` field; mobile keeps captaincy multiplier separate and applies
        // the booster internally. The totalPoints assertion above catches any real drift.
      });
    }
  }

  it('os_double: overseas player gets 2× raw', () => {
    const p = { ...player, captaincy: 'normal', is_overseas: true };
    const w = web.calculateScore(p, 'T20', null, 'os_double');
    const m = mob.calculateScore(p, 'T20', 'os_double');
    assert.equal(w.totalPoints, m.totalPoints);
  });

  it('os_double: domestic player unaffected', () => {
    const p = { ...player, captaincy: 'normal', is_overseas: false };
    const w = web.calculateScore(p, 'T20', null, 'os_double');
    const m = mob.calculateScore(p, 'T20', 'os_double');
    assert.equal(w.totalPoints, m.totalPoints);
  });

  it('indian_double: domestic player gets 2× raw', () => {
    const p = { ...player, captaincy: 'normal', is_overseas: false };
    const w = web.calculateScore(p, 'T20', null, 'indian_double');
    const m = mob.calculateScore(p, 'T20', 'indian_double');
    assert.equal(w.totalPoints, m.totalPoints);
  });
});
