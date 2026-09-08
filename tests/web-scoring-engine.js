/**
 * web-scoring-engine.js
 *
 * Verbatim extraction of the pure scoring functions from index.html's inline
 * <script type="module"> (lines ~2053–2220). No DOM, no state, no imports —
 * just the math, exported as CommonJS for use in node:test cross-check tests.
 *
 * IMPORTANT: Keep this file in sync with index.html whenever the scoring
 * constants or function logic changes. The cross-check tests exist to catch
 * drift between this file and app/src/engine/cricketScoringEngine.ts.
 * Do NOT change the logic here without updating index.html and vice versa.
 */

'use strict';

// ─── Scoring rules ────────────────────────────────────────────────────────────

const DEFAULT_SCORING_RULES = {
  T20: {
    run: 1, boundary4: 1, boundary6: 2, thirty_run_bonus: 4, half_century: 8, century: 16, duck: -2,
    sr_above_170: 6, sr_140_to_170: 4, sr_below_70: -6, sr_70_to_100: -2,
    wicket: 25, lbw_bowled_bonus: 8, maiden_over: 12, dot_ball: 1,
    three_wicket_haul: 8, four_wicket_haul: 8, five_wicket_haul: 16, hattrick_bonus: 16,
    economy_below_5: 6, economy_5_to_6: 4, economy_10_to_11: -4, economy_above_11: -6,
    catch: 8, stumping: 12, run_out_direct: 12, run_out_indirect: 6,
    no_ball: -1, wide: -1,
  },
  ODI: {
    run: 1, boundary4: 1, boundary6: 2, half_century: 4, century: 8, duck: -3,
    sr_above_140: 6, sr_120_to_140: 2, sr_below_50: -6, sr_50_to_75: -2,
    wicket: 25, lbw_bowled_bonus: 8, maiden_over: 4, dot_ball: 0.5,
    four_wicket_haul: 4, five_wicket_haul: 8, hattrick_bonus: 16,
    economy_below_2_5: 6, economy_2_5_to_3_5: 4, economy_7_to_8: -4, economy_above_9: -6,
    catch: 8, stumping: 12, run_out_direct: 12, run_out_indirect: 6,
    no_ball: -1, wide: -1,
  },
  TEST: {
    run: 1, boundary4: 0, boundary6: 0, half_century: 4, century: 8, duck: -4,
    wicket: 16, lbw_bowled_bonus: 8, maiden_over: 4, five_wicket_haul: 8, hattrick_bonus: 16,
    catch: 8, stumping: 12, run_out_direct: 12, run_out_indirect: 6,
    no_ball: -1, wide: -1,
  },
};

const MULTIPLIERS = { captain: 2, triple_captain: 3, vice_captain: 1.5, normal: 1 };

// ─── Helpers ──────────────────────────────────────────────────────────────────

function strikeRate(r, b) { return b === 0 ? null : (r / b) * 100; }
function economyRate(r, b) { return b === 0 ? null : (r / b) * 6; }

function srBonus(sr, fmt, r) {
  if (fmt === 'T20') {
    if (sr > 170) return r.sr_above_170;
    if (sr >= 140) return r.sr_140_to_170;
    if (sr < 70)  return r.sr_below_70;
    if (sr < 100) return r.sr_70_to_100;
  }
  if (fmt === 'ODI') {
    if (sr > 140) return r.sr_above_140;
    if (sr >= 120) return r.sr_120_to_140;
    if (sr < 50)  return r.sr_below_50;
    if (sr < 75)  return r.sr_50_to_75;
  }
  return 0;
}

function ecoBonus(e, fmt, r) {
  if (fmt === 'T20') {
    if (e < 5)   return r.economy_below_5;
    if (e < 6)   return r.economy_5_to_6;
    if (e >= 11) return r.economy_above_11;
    if (e >= 10) return r.economy_10_to_11;
  }
  if (fmt === 'ODI') {
    if (e < 2.5) return r.economy_below_2_5;
    if (e < 3.5) return r.economy_2_5_to_3_5;
    if (e >= 9)  return r.economy_above_9;
    if (e >= 7)  return r.economy_7_to_8;
  }
  return 0;
}

// ─── Component calculators ────────────────────────────────────────────────────

function calcBatting(inn, fmt = 'T20', rulesOverride) {
  const r = rulesOverride || DEFAULT_SCORING_RULES[fmt];
  const { runs = 0, ballsFaced = 0, fours = 0, sixes = 0, isDismissed = false, role } = inn || {};
  const b = {};
  b.runs      = runs * r.run;
  b.boundary4 = fours * (r.boundary4 || 0);
  b.boundary6 = sixes * (r.boundary6 || 0);
  if (runs >= 100) b.century       = r.century || 0;
  else if (runs >= 50) b.half_century = r.half_century || 0;
  else if (runs >= 30) b.thirtyRunBonus = r.thirty_run_bonus || 0;
  if (isDismissed && runs === 0 && role !== 'bowl') b.duck = r.duck || 0;
  if (r.sr_above_170 !== undefined && ballsFaced >= 10) {
    b.strikeRateBonus = srBonus(strikeRate(runs, ballsFaced), fmt, r);
  } else {
    b.strikeRateBonus = 0;
  }
  return { points: Object.values(b).reduce((a, c) => a + c, 0), breakdown: b };
}

function calcBowling(s, fmt = 'T20', rulesOverride) {
  const r = rulesOverride || DEFAULT_SCORING_RULES[fmt];
  const { wickets = 0, wicketTypes = [], maidens = 0, runsConceded = 0, ballsBowled = 0, dotBalls = 0, noBalls = 0, wides = 0, hattrick = false } = s || {};
  const b = {};
  b.wickets = wickets * r.wicket;
  const prem = wicketTypes.filter(t => ['lbw', 'bowled'].includes(String(t).toLowerCase())).length;
  b.lbwBowledBonus = prem * (r.lbw_bowled_bonus || 0);
  if (wickets >= 5 && r.five_wicket_haul) b.fiveWicket = r.five_wicket_haul;
  else if (wickets >= 4 && r.four_wicket_haul) b.fourWicket = r.four_wicket_haul;
  else if (wickets >= 3 && r.three_wicket_haul) b.threeWicket = r.three_wicket_haul;
  if (hattrick && r.hattrick_bonus) b.hattrick = r.hattrick_bonus;
  b.maidens  = maidens * r.maiden_over;
  b.dotBalls = dotBalls * (r.dot_ball || 0);
  b.economyBonus = ballsBowled > 6 ? ecoBonus(economyRate(runsConceded, ballsBowled), fmt, r) : 0;
  b.noBalls = noBalls * (r.no_ball || 0);
  b.wides   = wides   * (r.wide   || 0);
  return { points: Object.values(b).reduce((a, c) => a + c, 0), breakdown: b };
}

function calcFielding(f, fmt = 'T20', rulesOverride) {
  const r = rulesOverride || DEFAULT_SCORING_RULES[fmt];
  const { catches = 0, stumpings = 0, runOutDirect = 0, runOutIndirect = 0 } = f || {};
  const b = {
    catches:        catches        * r.catch,
    stumpings:      stumpings      * r.stumping,
    runOutDirect:   runOutDirect   * r.run_out_direct,
    runOutIndirect: runOutIndirect * r.run_out_indirect,
  };
  return { points: Object.values(b).reduce((a, c) => a + c, 0), breakdown: b };
}

function calculateScore(player, fmt = 'T20', rulesOverride, booster) {
  const { name, role, captaincy = 'normal', batting, bowling, fielding, is_overseas = false } = player;
  const breakdown = {}; let raw = 0;
  if (batting) { const res = calcBatting({ ...batting, role }, fmt, rulesOverride); breakdown.batting = res.breakdown; raw += res.points; }
  if (bowling) { const res = calcBowling(bowling, fmt, rulesOverride);               breakdown.bowling = res.breakdown; raw += res.points; }
  if (fielding) { const res = calcFielding(fielding, fmt, rulesOverride);            breakdown.fielding = res.breakdown; raw += res.points; }
  const captancyKey =
    (booster === 'triple_captain' && captaincy === 'captain')      ? 'triple_captain' :
    (booster === 'dual_captain'   && captaincy === 'vice_captain') ? 'captain'        :
    captaincy;
  const captMult   = MULTIPLIERS[captancyKey] || 1;
  let boosterMult  = 1;
  if (booster === 'team_double')                              boosterMult = 2;
  else if (booster === 'os_double'     &&  is_overseas)      boosterMult = 2;
  else if (booster === 'indian_double' && !is_overseas)      boosterMult = 2;
  const mult = captMult * boosterMult;
  return { name, totalPoints: Math.round(raw * mult * 10) / 10, multiplier: mult, rawPoints: Math.round(raw * 10) / 10, breakdown };
}

// ─── Name-fallback helper (mirrors db.js getProfiles / leaderboardStore.ts) ──

/**
 * Resolve the display name for a user profile row, using the same fallback
 * chain used in db.js (getProfiles, getLeaderboardSL) and the mobile stores
 * (leaderboardStore.ts, dailyLeaderboard.ts).
 */
function resolveDisplayName(profile) {
  return profile.team_name || profile.display_name || profile.email || (profile.id || '').slice(0, 8);
}

// ─── Dot-ball gate helper (mirrors applyDotBallGate in index.html) ────────────

/**
 * Returns the effective dot_ball points value for a given tournament flag.
 * Mirrors the clamping logic in index.html's applyDotBallGate() and
 * dailyLeaderboard.ts / seasonHistory.ts.
 */
function effectiveDotBall(baseValue, dotBallEnabled) {
  return dotBallEnabled ? baseValue : 0;
}

module.exports = {
  DEFAULT_SCORING_RULES,
  MULTIPLIERS,
  calcBatting,
  calcBowling,
  calcFielding,
  calculateScore,
  resolveDisplayName,
  effectiveDotBall,
};
