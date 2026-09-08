/**
 * Fantasy Cricket Scoring Engine — TypeScript port
 * Identical logic to cricketScoringEngine.js; types added only.
 */

import {
  MatchFormat,
  CaptaincyRole,
  PlayerRole,
  BattingInnings,
  BowlingSpell,
  FieldingStats,
  PlayerMatchPerf,
  PlayerScore,
  ScoreBreakdown,
} from '../types';

// ─── Scoring Rules ────────────────────────────────────────────────────────────

export type ScoringRuleSet = Record<string, number>;

export const SCORING_RULES: Record<MatchFormat, ScoringRuleSet> = {
  T20: {
    run: 1, boundary4: 1, boundary6: 2,
    thirty_run_bonus: 4, half_century: 8, century: 16, duck: -2,
    sr_above_170: 6, sr_140_to_170: 4, sr_below_70: -6, sr_70_to_100: -2,
    wicket: 25, lbw_bowled_bonus: 8, maiden_over: 12, dot_ball: 1,
    three_wicket_haul: 8, four_wicket_haul: 8, five_wicket_haul: 16, hattrick_bonus: 16,
    economy_below_5: 6, economy_5_to_6: 4, economy_10_to_11: -4, economy_above_11: -6,
    catch: 8, stumping: 12, run_out_direct: 12, run_out_indirect: 6,
    no_ball: -1, wide: -1,
  },
  ODI: {
    run: 1, boundary4: 1, boundary6: 2,
    half_century: 4, century: 8, duck: -3,
    sr_above_140: 6, sr_120_to_140: 2, sr_below_50: -6, sr_50_to_75: -2,
    wicket: 25, lbw_bowled_bonus: 8, maiden_over: 4, dot_ball: 0.5,
    four_wicket_haul: 4, five_wicket_haul: 8, hattrick_bonus: 16,
    economy_below_2_5: 6, economy_2_5_to_3_5: 4, economy_7_to_8: -4, economy_above_9: -6,
    catch: 8, stumping: 12, run_out_direct: 12, run_out_indirect: 6,
    no_ball: -1, wide: -1,
  },
  TEST: {
    run: 1, boundary4: 0, boundary6: 0,
    half_century: 4, century: 8, duck: -4,
    wicket: 16, lbw_bowled_bonus: 8, maiden_over: 4, five_wicket_haul: 8, hattrick_bonus: 16,
    catch: 8, stumping: 12, run_out_direct: 12, run_out_indirect: 6,
    no_ball: -1, wide: -1,
  },
};

export const MULTIPLIERS: Record<string, number> = {
  captain:        2,
  vice_captain:   1.5,
  normal:         1,
  triple_captain: 3,
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function strikeRate(runs: number, ballsFaced: number): number | null {
  if (ballsFaced === 0) return null;
  return (runs / ballsFaced) * 100;
}

function economyRate(runsConceded: number, ballsBowled: number): number | null {
  if (ballsBowled === 0) return null;
  return (runsConceded / ballsBowled) * 6;
}

function calcStrikeRateBonus(sr: number, format: MatchFormat, rules: ScoringRuleSet): number {
  if (format === 'T20') {
    if (sr > 170) return rules.sr_above_170 ?? 0;
    if (sr >= 140) return rules.sr_140_to_170 ?? 0;
    if (sr < 70)  return rules.sr_below_70 ?? 0;
    if (sr < 100) return rules.sr_70_to_100 ?? 0;
  }
  if (format === 'ODI') {
    if (sr > 140) return rules.sr_above_140 ?? 0;
    if (sr >= 120) return rules.sr_120_to_140 ?? 0;
    if (sr < 50)  return rules.sr_below_50 ?? 0;
    if (sr < 75)  return rules.sr_50_to_75 ?? 0;
  }
  return 0;
}

function calcEconomyBonus(eco: number, format: MatchFormat, rules: ScoringRuleSet): number {
  if (format === 'T20') {
    if (eco < 5)   return rules.economy_below_5 ?? 0;
    if (eco < 6)   return rules.economy_5_to_6 ?? 0;
    if (eco >= 11) return rules.economy_above_11 ?? 0;
    if (eco >= 10) return rules.economy_10_to_11 ?? 0;
  }
  if (format === 'ODI') {
    if (eco < 2.5) return rules.economy_below_2_5 ?? 0;
    if (eco < 3.5) return rules.economy_2_5_to_3_5 ?? 0;
    if (eco >= 9)  return rules.economy_above_9 ?? 0;
    if (eco >= 7)  return rules.economy_7_to_8 ?? 0;
  }
  return 0;
}

// ─── Component calculators ────────────────────────────────────────────────────

export function calcBattingPoints(
  innings: BattingInnings & { role: PlayerRole },
  format: MatchFormat = 'T20',
  rulesOverride?: ScoringRuleSet,
): { points: number; breakdown: Record<string, number> } {
  const rules = rulesOverride ?? SCORING_RULES[format];
  const { runs, ballsFaced, fours, sixes, isDismissed, role } = innings;
  const breakdown: Record<string, number> = {};

  breakdown.runs      = runs * rules.run;
  breakdown.boundary4 = (fours ?? 0) * (rules.boundary4 ?? 0);
  breakdown.boundary6 = (sixes ?? 0) * (rules.boundary6 ?? 0);

  if (runs >= 100) breakdown.century = rules.century ?? 0;
  else if (runs >= 50) breakdown.half_century = rules.half_century ?? 0;
  else if (runs >= 30) breakdown.thirtyRunBonus = rules.thirty_run_bonus ?? 0;

  if (isDismissed && runs === 0 && role !== 'bowl') {
    breakdown.duck = rules.duck ?? 0;
  }

  if (rules.sr_above_170 !== undefined && ballsFaced >= 10) {
    const sr = strikeRate(runs, ballsFaced);
    breakdown.strikeRateBonus = sr !== null
      ? calcStrikeRateBonus(sr, format, rules)
      : 0;
  } else {
    breakdown.strikeRateBonus = 0;
  }

  const points = Object.values(breakdown).reduce((a, b) => a + b, 0);
  return { points, breakdown };
}

export function calcBowlingPoints(
  spell: BowlingSpell,
  format: MatchFormat = 'T20',
  rulesOverride?: ScoringRuleSet,
): { points: number; breakdown: Record<string, number> } {
  const rules = rulesOverride ?? SCORING_RULES[format];
  const { wickets, wicketTypes = [], maidens, runsConceded, ballsBowled, dotBalls, noBalls, wides, hattrick } = spell;
  const breakdown: Record<string, number> = {};

  breakdown.wickets = wickets * rules.wicket;

  const premiumWickets = wicketTypes.filter(t =>
    ['lbw', 'bowled'].includes(t.toLowerCase()),
  ).length;
  breakdown.lbwBowledBonus = premiumWickets * (rules.lbw_bowled_bonus ?? 0);

  if (wickets >= 5 && rules.five_wicket_haul) breakdown.fiveWicket = rules.five_wicket_haul;
  else if (wickets >= 4 && rules.four_wicket_haul) breakdown.fourWicket = rules.four_wicket_haul;
  else if (wickets >= 3 && rules.three_wicket_haul) breakdown.threeWicket = rules.three_wicket_haul;

  // Hat-trick bonus — independent of the wicket-haul tiers above; stacks with
  // whichever haul bonus applies. Only ever true after an admin confirms it
  // via the web Review tab (see BowlingSpell.hattrick).
  if (hattrick && rules.hattrick_bonus) breakdown.hattrick = rules.hattrick_bonus;

  breakdown.maidens  = (maidens  ?? 0) * rules.maiden_over;
  breakdown.dotBalls = (dotBalls ?? 0) * (rules.dot_ball ?? 0);

  if (ballsBowled > 6) {
    const eco = economyRate(runsConceded, ballsBowled);
    breakdown.economyBonus = eco !== null ? calcEconomyBonus(eco, format, rules) : 0;
  } else {
    breakdown.economyBonus = 0;
  }

  breakdown.noBalls = (noBalls ?? 0) * (rules.no_ball ?? 0);
  breakdown.wides   = (wides   ?? 0) * (rules.wide   ?? 0);

  const points = Object.values(breakdown).reduce((a, b) => a + b, 0);
  return { points, breakdown };
}

export function calcFieldingPoints(
  fielding: FieldingStats,
  format: MatchFormat = 'T20',
  rulesOverride?: ScoringRuleSet,
): { points: number; breakdown: Record<string, number> } {
  const rules = rulesOverride ?? SCORING_RULES[format];
  const breakdown: Record<string, number> = {
    catches:        (fielding.catches        ?? 0) * rules.catch,
    stumpings:      (fielding.stumpings      ?? 0) * rules.stumping,
    runOutDirect:   (fielding.runOutDirect   ?? 0) * rules.run_out_direct,
    runOutIndirect: (fielding.runOutIndirect ?? 0) * rules.run_out_indirect,
  };
  const points = Object.values(breakdown).reduce((a, b) => a + b, 0);
  return { points, breakdown };
}

// ─── Master calculator ────────────────────────────────────────────────────────

/**
 * Calculate a single player's score, optionally with a team booster applied.
 *
 * Booster logic (mirrors web calculateScore):
 *   triple_captain — captain's multiplier becomes 3× (instead of 2×)
 *   dual_captain   — vice-captain's multiplier becomes 2× (same as captain)
 *   team_double    — every player's base points × 2 before captaincy multiplier
 *   indian_double  — US domestic (non-overseas) players' base points × 2
 *   os_double      — overseas players' base points × 2
 *   free_hit       — transfer-only booster, no scoring effect
 *   wildcard       — transfer-only booster, no scoring effect
 */
export function calculateScore(
  player: PlayerMatchPerf,
  format: MatchFormat = 'T20',
  booster?: string,
): PlayerScore {
  const { name, role, captaincy = 'normal', is_overseas = false, batting, bowling, fielding } = player;
  const breakdown: ScoreBreakdown = {};
  let rawPoints = 0;

  if (batting) {
    const bat = calcBattingPoints({ ...batting, role }, format);
    breakdown.batting = bat.breakdown;
    rawPoints += bat.points;
  }
  if (bowling) {
    const bowl = calcBowlingPoints(bowling, format);
    breakdown.bowling = bowl.breakdown;
    rawPoints += bowl.points;
  }
  if (fielding) {
    const field = calcFieldingPoints(fielding, format);
    breakdown.fielding = field.breakdown;
    rawPoints += field.points;
  }

  // Resolve effective captaincy key based on booster
  const captancyKey: string =
    (booster === 'triple_captain' && captaincy === 'captain')      ? 'triple_captain' :
    (booster === 'dual_captain'   && captaincy === 'vice_captain') ? 'captain'        :
    captaincy;

  // Player-class boost: team_double = everyone, os_double = overseas only, indian_double = non-overseas only
  const teamBoost =
    booster === 'team_double'                          ? 2 :
    booster === 'os_double'     &&  is_overseas        ? 2 :
    booster === 'indian_double' && !is_overseas        ? 2 :
    1;

  const multiplier = MULTIPLIERS[captancyKey] ?? 1;
  const totalPoints = Math.round(rawPoints * teamBoost * multiplier * 10) / 10;

  return { name, totalPoints, multiplier, rawPoints: Math.round(rawPoints * 10) / 10, breakdown };
}

export function scoreTeam(
  players: PlayerMatchPerf[],
  format: MatchFormat = 'T20',
  booster?: string,
): PlayerScore[] {
  return players
    .map(p => calculateScore(p, format, booster))
    .sort((a, b) => b.totalPoints - a.totalPoints);
}
