/**
 * scoringEngine.test.ts
 *
 * Unit tests for app/src/engine/cricketScoringEngine.ts — the mobile TypeScript
 * scoring implementation. Covers batting, bowling, fielding, captaincy multipliers,
 * booster effects, and edge cases.
 *
 * Run: cd app && node -r ./node_modules/sucrase/register --test __tests__/scoringEngine.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  SCORING_RULES,
  MULTIPLIERS,
  calcBattingPoints,
  calcBowlingPoints,
  calcFieldingPoints,
  calculateScore,
} from '../src/engine/cricketScoringEngine';

// ─── Scoring rules sanity ─────────────────────────────────────────────────────

describe('SCORING_RULES constants', () => {
  it('T20 wicket is 25', () => assert.equal(SCORING_RULES.T20.wicket, 25));
  it('T20 run is 1',    () => assert.equal(SCORING_RULES.T20.run, 1));
  it('T20 six bonus is 2', () => assert.equal(SCORING_RULES.T20.boundary6, 2));
  it('T20 century bonus is 16', () => assert.equal(SCORING_RULES.T20.century, 16));
  it('ODI wicket is 25', () => assert.equal(SCORING_RULES.ODI.wicket, 25));
  it('TEST wicket is 16', () => assert.equal(SCORING_RULES.TEST.wicket, 16));
  it('captain multiplier is 2',       () => assert.equal(MULTIPLIERS.captain, 2));
  it('vice_captain multiplier is 1.5',() => assert.equal(MULTIPLIERS.vice_captain, 1.5));
  it('triple_captain multiplier is 3',() => assert.equal(MULTIPLIERS.triple_captain, 3));
});

// ─── calcBattingPoints ────────────────────────────────────────────────────────

describe('calcBattingPoints — T20', () => {
  it('basic run scoring', () => {
    // 22 runs off 20 balls: no milestone (< 30), SR 110 falls in the neutral 100-140 zone → no SR effect
    const { points } = calcBattingPoints({ runs: 22, ballsFaced: 20, fours: 0, sixes: 0, isDismissed: false, role: 'bat' }, 'T20');
    assert.equal(points, 22); // 22×1
  });

  it('30-run bonus at exactly 30 runs (no half-century added)', () => {
    // 30 runs off 25 balls: SR 120 is neutral, isolates the milestone bonus
    const { breakdown } = calcBattingPoints({ runs: 30, ballsFaced: 25, fours: 0, sixes: 0, isDismissed: false, role: 'bat' }, 'T20');
    assert.equal(breakdown.thirtyRunBonus, 4);
    assert.equal(breakdown.half_century, undefined);
  });

  it('no 30-run bonus below 30 runs', () => {
    const { breakdown } = calcBattingPoints({ runs: 29, ballsFaced: 25, fours: 0, sixes: 0, isDismissed: false, role: 'bat' }, 'T20');
    assert.equal(breakdown.thirtyRunBonus, undefined);
  });

  it('boundaries add bonus pts on top of run points', () => {
    const { points, breakdown } = calcBattingPoints({ runs: 10, ballsFaced: 10, fours: 2, sixes: 1, isDismissed: false, role: 'bat' }, 'T20');
    assert.equal(breakdown.runs, 10);
    assert.equal(breakdown.boundary4, 2);   // 2 fours × 1pt bonus each
    assert.equal(breakdown.boundary6, 2);   // 1 six  × 2pt bonus
    assert.equal(points, 14);
  });

  it('half-century bonus at exactly 50 runs', () => {
    const { breakdown } = calcBattingPoints({ runs: 50, ballsFaced: 40, fours: 0, sixes: 0, isDismissed: false, role: 'bat' }, 'T20');
    assert.equal(breakdown.half_century, 8);
    assert.equal(breakdown.century, undefined);
  });

  it('century bonus at exactly 100 runs (no half-century added)', () => {
    const { breakdown } = calcBattingPoints({ runs: 100, ballsFaced: 80, fours: 0, sixes: 0, isDismissed: false, role: 'bat' }, 'T20');
    assert.equal(breakdown.century, 16);
    assert.equal(breakdown.half_century, undefined);
  });

  it('duck penalty for batter dismissed on 0', () => {
    const { breakdown } = calcBattingPoints({ runs: 0, ballsFaced: 3, fours: 0, sixes: 0, isDismissed: true, role: 'bat' }, 'T20');
    assert.equal(breakdown.duck, -2);
  });

  it('no duck penalty for bowler dismissed on 0', () => {
    const { breakdown } = calcBattingPoints({ runs: 0, ballsFaced: 3, fours: 0, sixes: 0, isDismissed: true, role: 'bowl' }, 'T20');
    assert.equal(breakdown.duck, undefined);
  });

  it('no duck penalty if not dismissed', () => {
    const { breakdown } = calcBattingPoints({ runs: 0, ballsFaced: 5, fours: 0, sixes: 0, isDismissed: false, role: 'bat' }, 'T20');
    assert.equal(breakdown.duck, undefined);
  });

  it('SR > 170 earns bonus (min 10 balls faced)', () => {
    // 18 runs off 10 balls = SR 180
    const { breakdown } = calcBattingPoints({ runs: 18, ballsFaced: 10, fours: 0, sixes: 0, isDismissed: false, role: 'bat' }, 'T20');
    assert.equal(breakdown.strikeRateBonus, 6);
  });

  it('SR 140-170 earns 4pt bonus', () => {
    // 15 runs off 10 balls = SR 150
    const { breakdown } = calcBattingPoints({ runs: 15, ballsFaced: 10, fours: 0, sixes: 0, isDismissed: false, role: 'bat' }, 'T20');
    assert.equal(breakdown.strikeRateBonus, 4);
  });

  it('SR < 70 earns -6pt penalty', () => {
    // 5 runs off 10 balls = SR 50
    const { breakdown } = calcBattingPoints({ runs: 5, ballsFaced: 10, fours: 0, sixes: 0, isDismissed: false, role: 'bat' }, 'T20');
    assert.equal(breakdown.strikeRateBonus, -6);
  });

  it('no SR bonus if fewer than 10 balls faced', () => {
    const { breakdown } = calcBattingPoints({ runs: 9, ballsFaced: 5, fours: 0, sixes: 0, isDismissed: false, role: 'bat' }, 'T20');
    assert.equal(breakdown.strikeRateBonus, 0);
  });

  it('comprehensive T20 batter: 75 runs, 50 balls, 4 fours, 2 sixes', () => {
    // 75×1 + 4×1 + 2×2 + 8 (50+ bonus) + SR bonus: 75/50×100=150 → 4pt
    const { points } = calcBattingPoints({ runs: 75, ballsFaced: 50, fours: 4, sixes: 2, isDismissed: true, role: 'bat' }, 'T20');
    assert.equal(points, 75 + 4 + 4 + 8 + 4); // = 95
  });
});

// ─── calcBowlingPoints ────────────────────────────────────────────────────────

describe('calcBowlingPoints — T20', () => {
  it('basic wicket scoring', () => {
    // eco = 12/12×6 = 6.0 — neutral T20 economy (no bonus, no penalty)
    const { points } = calcBowlingPoints({ wickets: 2, wicketTypes: [], maidens: 0, runsConceded: 12, ballsBowled: 12, dotBalls: 0, noBalls: 0, wides: 0 }, 'T20');
    assert.equal(points, 50); // 2×25
  });

  it('LBW/bowled bonus', () => {
    const { breakdown } = calcBowlingPoints({ wickets: 2, wicketTypes: ['lbw', 'caught'], maidens: 0, runsConceded: 20, ballsBowled: 12, dotBalls: 0, noBalls: 0, wides: 0 }, 'T20');
    assert.equal(breakdown.lbwBowledBonus, 8); // 1 lbw × 8
  });

  it('maiden over bonus', () => {
    const { breakdown } = calcBowlingPoints({ wickets: 0, wicketTypes: [], maidens: 1, runsConceded: 0, ballsBowled: 12, dotBalls: 6, noBalls: 0, wides: 0 }, 'T20');
    assert.equal(breakdown.maidens, 12);
  });

  it('dot ball points', () => {
    const { breakdown } = calcBowlingPoints({ wickets: 0, wicketTypes: [], maidens: 0, runsConceded: 10, ballsBowled: 12, dotBalls: 4, noBalls: 0, wides: 0 }, 'T20');
    assert.equal(breakdown.dotBalls, 4); // 4×1pt
  });

  it('T20 5-wicket haul bonus', () => {
    const { breakdown } = calcBowlingPoints({ wickets: 5, wicketTypes: [], maidens: 0, runsConceded: 30, ballsBowled: 24, dotBalls: 0, noBalls: 0, wides: 0 }, 'T20');
    assert.equal(breakdown.fiveWicket, 16);
    assert.equal(breakdown.fourWicket, undefined);
    assert.equal(breakdown.threeWicket, undefined);
    assert.equal(breakdown.wickets, 125);
  });

  it('T20 4-wicket haul bonus (no 5-wicket bonus stacked)', () => {
    const { breakdown } = calcBowlingPoints({ wickets: 4, wicketTypes: [], maidens: 0, runsConceded: 30, ballsBowled: 24, dotBalls: 0, noBalls: 0, wides: 0 }, 'T20');
    assert.equal(breakdown.fourWicket, 8);
    assert.equal(breakdown.fiveWicket, undefined);
  });

  it('T20 3-wicket haul bonus (no 4/5-wicket bonus stacked)', () => {
    const { breakdown } = calcBowlingPoints({ wickets: 3, wicketTypes: [], maidens: 0, runsConceded: 30, ballsBowled: 24, dotBalls: 0, noBalls: 0, wides: 0 }, 'T20');
    assert.equal(breakdown.threeWicket, 8);
    assert.equal(breakdown.fourWicket, undefined);
  });

  it('no wicket-haul bonus below 3 wickets', () => {
    const { breakdown } = calcBowlingPoints({ wickets: 2, wicketTypes: [], maidens: 0, runsConceded: 30, ballsBowled: 24, dotBalls: 0, noBalls: 0, wides: 0 }, 'T20');
    assert.equal(breakdown.threeWicket, undefined);
  });

  it('ODI 5-wicket haul bonus', () => {
    const { breakdown } = calcBowlingPoints({ wickets: 5, wicketTypes: [], maidens: 0, runsConceded: 30, ballsBowled: 24, dotBalls: 0, noBalls: 0, wides: 0 }, 'ODI');
    assert.equal(breakdown.fiveWicket, 8);
  });

  it('ODI 4-wicket haul bonus', () => {
    const { breakdown } = calcBowlingPoints({ wickets: 4, wicketTypes: [], maidens: 0, runsConceded: 30, ballsBowled: 24, dotBalls: 0, noBalls: 0, wides: 0 }, 'ODI');
    assert.equal(breakdown.fourWicket, 4);
  });

  it('economy bonus (eco < 5 in T20)', () => {
    // 20 runs in 24 balls = eco 5.0 → no bonus. 16 runs in 24 balls = eco 4.0 → +6
    const { breakdown } = calcBowlingPoints({ wickets: 0, wicketTypes: [], maidens: 0, runsConceded: 16, ballsBowled: 24, dotBalls: 0, noBalls: 0, wides: 0 }, 'T20');
    assert.equal(breakdown.economyBonus, 6);
  });

  it('economy penalty (eco > 11 in T20)', () => {
    // 48 runs in 24 balls = eco 12 → -6
    const { breakdown } = calcBowlingPoints({ wickets: 0, wicketTypes: [], maidens: 0, runsConceded: 48, ballsBowled: 24, dotBalls: 0, noBalls: 0, wides: 0 }, 'T20');
    assert.equal(breakdown.economyBonus, -6);
  });

  it('no economy bonus if ≤ 6 balls bowled', () => {
    const { breakdown } = calcBowlingPoints({ wickets: 0, wicketTypes: [], maidens: 0, runsConceded: 2, ballsBowled: 6, dotBalls: 0, noBalls: 0, wides: 0 }, 'T20');
    assert.equal(breakdown.economyBonus, 0);
  });

  it('no-ball and wide penalties', () => {
    const { breakdown } = calcBowlingPoints({ wickets: 0, wicketTypes: [], maidens: 0, runsConceded: 10, ballsBowled: 12, dotBalls: 0, noBalls: 2, wides: 3 }, 'T20');
    assert.equal(breakdown.noBalls, -2);
    assert.equal(breakdown.wides,   -3);
  });

  it('dot_ball 0 when rulesOverride clamps it', () => {
    const override = { ...SCORING_RULES.T20, dot_ball: 0 };
    const { breakdown } = calcBowlingPoints({ wickets: 1, wicketTypes: [], maidens: 0, runsConceded: 10, ballsBowled: 12, dotBalls: 5, noBalls: 0, wides: 0 }, 'T20', override);
    assert.equal(breakdown.dotBalls, 0);
    assert.equal(breakdown.wickets, 25);
  });
});

// ─── calcFieldingPoints ───────────────────────────────────────────────────────

describe('calcFieldingPoints — T20', () => {
  it('catch', () => {
    const { points } = calcFieldingPoints({ catches: 1, stumpings: 0, runOutDirect: 0, runOutIndirect: 0 }, 'T20');
    assert.equal(points, 8);
  });

  it('stumping', () => {
    const { points } = calcFieldingPoints({ catches: 0, stumpings: 1, runOutDirect: 0, runOutIndirect: 0 }, 'T20');
    assert.equal(points, 12);
  });

  it('direct run-out', () => {
    const { points } = calcFieldingPoints({ catches: 0, stumpings: 0, runOutDirect: 1, runOutIndirect: 0 }, 'T20');
    assert.equal(points, 12);
  });

  it('indirect run-out', () => {
    const { points } = calcFieldingPoints({ catches: 0, stumpings: 0, runOutDirect: 0, runOutIndirect: 1 }, 'T20');
    assert.equal(points, 6);
  });

  it('combined fielding', () => {
    const { points } = calcFieldingPoints({ catches: 2, stumpings: 1, runOutDirect: 1, runOutIndirect: 1 }, 'T20');
    assert.equal(points, 8*2 + 12 + 12 + 6); // 50
  });
});

// ─── calculateScore — captaincy + boosters ────────────────────────────────────

describe('calculateScore — captaincy multipliers', () => {
  const base = {
    id: 'p1', // placeholder — calculateScore() never reads PlayerMatchPerf.id, this only satisfies the type
    name: 'Rohit',
    role: 'bat' as const,
    batting: { runs: 50, ballsFaced: 40, fours: 4, sixes: 1, isDismissed: false },
    bowling: undefined,
    fielding: undefined,
  };

  it('normal player — multiplier 1', () => {
    const score = calculateScore({ ...base, captaincy: 'normal' }, 'T20');
    assert.equal(score.multiplier, 1);
    assert.equal(score.totalPoints, score.rawPoints);
  });

  it('captain — multiplier 2', () => {
    const score = calculateScore({ ...base, captaincy: 'captain' }, 'T20');
    assert.equal(score.multiplier, 2);
    assert.equal(score.totalPoints, score.rawPoints * 2);
  });

  it('vice-captain — multiplier 1.5', () => {
    const score = calculateScore({ ...base, captaincy: 'vice_captain' }, 'T20');
    assert.equal(score.multiplier, 1.5);
    assert.equal(score.totalPoints, score.rawPoints * 1.5);
  });

  it('triple_captain booster promotes captain to 3×', () => {
    const score = calculateScore({ ...base, captaincy: 'captain' }, 'T20', 'triple_captain');
    assert.equal(score.multiplier, 3);
  });

  it('triple_captain booster does NOT promote vice-captain', () => {
    const score = calculateScore({ ...base, captaincy: 'vice_captain' }, 'T20', 'triple_captain');
    assert.equal(score.multiplier, 1.5);
  });

  it('dual_captain booster promotes vice-captain to 2×', () => {
    const score = calculateScore({ ...base, captaincy: 'vice_captain' }, 'T20', 'dual_captain');
    assert.equal(score.multiplier, 2);
  });

  it('team_double doubles everyone\'s raw points', () => {
    const normal = calculateScore({ ...base, captaincy: 'normal' }, 'T20');
    const boosted = calculateScore({ ...base, captaincy: 'normal' }, 'T20', 'team_double');
    assert.equal(boosted.totalPoints, normal.rawPoints * 2);
  });

  it('os_double doubles overseas players only', () => {
    const overseas = calculateScore({ ...base, captaincy: 'normal', is_overseas: true }, 'T20', 'os_double');
    const domestic = calculateScore({ ...base, captaincy: 'normal', is_overseas: false }, 'T20', 'os_double');
    const plain    = calculateScore({ ...base, captaincy: 'normal' }, 'T20');
    assert.equal(overseas.totalPoints, plain.rawPoints * 2);
    assert.equal(domestic.totalPoints, plain.rawPoints);
  });

  it('indian_double doubles non-overseas players only', () => {
    const domestic = calculateScore({ ...base, captaincy: 'normal', is_overseas: false }, 'T20', 'indian_double');
    const overseas = calculateScore({ ...base, captaincy: 'normal', is_overseas: true }, 'T20', 'indian_double');
    const plain    = calculateScore({ ...base, captaincy: 'normal' }, 'T20');
    assert.equal(domestic.totalPoints, plain.rawPoints * 2);
    assert.equal(overseas.totalPoints, plain.rawPoints);
  });

  it('wildcard booster has no scoring effect', () => {
    const normal  = calculateScore({ ...base, captaincy: 'captain' }, 'T20');
    const wildcard = calculateScore({ ...base, captaincy: 'captain' }, 'T20', 'wildcard');
    assert.equal(wildcard.totalPoints, normal.totalPoints);
  });

  it('free_hit booster has no scoring effect', () => {
    const normal  = calculateScore({ ...base, captaincy: 'captain' }, 'T20');
    const freeHit = calculateScore({ ...base, captaincy: 'captain' }, 'T20', 'free_hit');
    assert.equal(freeHit.totalPoints, normal.totalPoints);
  });
});
