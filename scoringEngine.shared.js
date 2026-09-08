/**
 * scoringEngine.shared.js — canonical fantasy scoring engine.
 *
 * This is the ONE place batting/bowling/fielding points, dismissal parsing,
 * and rules resolution should live. It's plain, dependency-free ES module
 * JS (no Deno/Node/RN-only APIs) so it can be imported unmodified by:
 *   - Deno edge functions   (supabase/functions/poll-cricapi/index.ts,
 *                             supabase/functions/scrape-scorecard/index.ts)
 *   - the browser admin app (index.html, via <script type="module">)
 *   - the mobile app         (app/src/... via Metro)
 *
 * It replaces FOUR previously-independent copies of this same math:
 *   Engine #1  supabase/functions/poll-cricapi/index.ts    (lines 62-347)
 *   Engine #2  supabase/functions/scrape-scorecard/index.ts (lines 650-750)
 *   Engine #3  index.html inline <script type="module">     (lines 2450-2930)
 *   Engine #4  app/src/engine/cricketScoringEngine.ts
 * ...and the standalone cricketScoringEngine.js this file supersedes.
 *
 * Bugs fixed by consolidating (see divergence audit):
 *   1. isDismissed now always falls back to `dismissal-text` when the short
 *      `dismissal` code is absent (was missing in index.html:2824 and
 *      poll-cricapi/index.ts:325 — the reason scraper-sourced ducks silently
 *      dropped in the browser Fantasy Scorecard preview).
 *   2. resolveEffectiveRules() takes an explicit `contest` argument so ANY
 *      consumer — including a cron job — can honor per-contest custom rules,
 *      not just the browser's manual Finalize/Recalc path.
 *   3. sr_70_to_100 default unified to -2 (scrape-scorecard/index.ts:726 had
 *      drifted to -4).
 *   4. Run-out detection checks both the short code and dismissal-text
 *      everywhere (poll-cricapi/index.ts:219 only checked the short code).
 *   5. ballsBowled parsed one way (string-split on "4.3" overs notation,
 *      not decimal rounding — avoids float edge cases).
 *   6. lbw/bowled bonus wired inline in calcBowlingPoints everywhere (was a
 *      separately-called function only in scrape-scorecard/index.ts).
 *   7. calculateScore() carries the same rulesOverride + booster support the
 *      browser's Engine #3 already had, so per-contest re-scoring (season
 *      leagues, and any display-only breakdown recompute in the mobile app)
 *      always uses this same function instead of a bespoke local copy.
 *
 * Migration note: this file intentionally does NOT include the raw-payload
 * walkers (CricAPI JSON shape vs scraped HTML table shape) — those inputs
 * really are provider-specific. What's unified is everything downstream of
 * "I have a normalized dismissal string + role", which is where every bug
 * above actually lived.
 */

// ─── Default scoring rules (canonical baseline) ─────────────────────────────

export const DEFAULT_RULES = {
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

export const MULTIPLIERS = { captain: 2, triple_captain: 3, vice_captain: 1.5, normal: 1 };

// ─── Rules resolution ────────────────────────────────────────────────────────

/**
 * The single place "what rules apply to this player's points" gets decided.
 * Order of precedence: contest-level override > tournament-level override >
 * built-in default. Also applies the dot-ball gate (migration_v30): dot_ball
 * scoring is forced to 0 unless the tournament has explicitly turned it on,
 * regardless of what numeric weight is saved in scoring_rules.
 *
 * @param {{ scoring_rules?: object, dot_ball_enabled?: boolean }} [tournament]
 * @param {{ scoring_rules?: object }} [contest] - a private league / contest row; pass null/undefined for Daily contests, which never get per-contest overrides
 * @param {'T20'|'ODI'|'TEST'} format
 * @returns {object} effective rules for this format
 */
export function resolveEffectiveRules(tournament, contest, format) {
  const fmt = DEFAULT_RULES[format] ? format : 'T20';
  const base = { ...DEFAULT_RULES[fmt] };
  const tournamentOverride = tournament?.scoring_rules?.[fmt];
  const contestOverride = contest?.scoring_rules?.[fmt];
  const rules = { ...base, ...(tournamentOverride || {}), ...(contestOverride || {}) };
  if (!tournament?.dot_ball_enabled) rules.dot_ball = 0;
  return rules;
}

// ─── Small helpers ───────────────────────────────────────────────────────────

function strikeRate(runs, ballsFaced) { return ballsFaced ? (runs / ballsFaced) * 100 : null; }
function economyRate(runsConceded, ballsBowled) { return ballsBowled ? (runsConceded / ballsBowled) * 6 : null; }

/**
 * Canonical overs → balls conversion. Overs are cricket notation ("4.3" means
 * 4 overs + 3 balls, NOT 4.3 overs decimal) — parsed by splitting on "." and
 * combining, rather than rounding a decimal (which drifts on values like
 * 4.2999999 and was scrape-scorecard/index.ts's divergent approach).
 * @param {string|number} overs
 * @returns {number} total balls bowled
 */
export function parseOversToBalls(overs) {
  const [o, b] = String(overs ?? 0).split('.');
  return (parseInt(o, 10) || 0) * 6 + (parseInt(b || '0', 10) || 0);
}

/** @param {string} [s] a provider's playing_role/role string */
export function deriveRole(s = '') {
  s = String(s).toLowerCase();
  if (s.includes('wicket') || s === 'wk') return 'wk';
  if (s.includes('allround') || s === 'ar') return 'ar';
  if (s.includes('bowl')) return 'bowl';
  return 'bat';
}

// ─── Dismissal parsing ───────────────────────────────────────────────────────

/**
 * Whether a batter was genuinely dismissed, given whatever the provider gave
 * us. Always checks BOTH the short structured code (`dismissal`, e.g. CricAPI's
 * 'lbw'/'catch') AND the free-text description (`dismissal-text`), because
 * scraper-sourced rows only ever populate the latter (see
 * scrape-scorecard/index.ts's match_scorecards cache-writer). This single
 * function is what index.html:2824 and poll-cricapi/index.ts:325 each used to
 * compute independently — with the browser's copy missing the dText fallback.
 *
 * @param {{ dismissal?: string, 'dismissal-text'?: string }} b
 * @returns {boolean}
 */
export function deriveIsDismissed(b) {
  return classifyDismissal(b).status !== 'not_out';
}

/**
 * @typedef {{ type: string, bowler: string|null, fielder: string|null, fielder2?: string|null }} DismissalParse
 * @typedef {
 *   { status: 'not_out' } |
 *   { status: 'parsed', type: string, bowler: string|null, fielder: string|null, fielder2?: string|null } |
 *   { status: 'unparsed', raw: string }
 * } DismissalClassification
 */

/**
 * Classifies one batter's raw dismissal record into exactly one of three
 * outcomes — this is the fix for the "silent failure" class of bug: every
 * consumer used to treat "not out" and "genuinely out but the text didn't
 * match any known dismissal shape" as the same `null`, so a batter who WAS
 * out (e.g. "retired hurt", "timed out", or scraper HTML noise that garbled
 * the text) got no duck-relevant credit logged and no issue surfaced — the
 * bowler/fielder credit for that dismissal just silently vanished with no
 * trace anywhere. Callers should log a `status: 'unparsed'` result as an
 * issue (the same way scraper_fielding_issues already surfaces unmatched
 * fielder names) instead of quietly doing nothing.
 *
 * @param {any} b - raw batter row (provider-shaped: dismissal, dismissal-text, catch/fielder/catcher, bowler)
 * @returns {DismissalClassification}
 */
export function classifyDismissal(b) {
  const dText = String(b?.['dismissal-text'] ?? b?.dismissal ?? '').toLowerCase().trim();
  const d = String(b?.dismissal ?? '').toLowerCase().trim();
  if (!d && !dText) return { status: 'not_out' };
  if (d.includes('not out') || dText.includes('not out')) return { status: 'not_out' };

  const strOrName = v => v?.name ?? (typeof v === 'string' && v ? v : null);
  const fielderName = strOrName(b?.catch) ?? strOrName(b?.fielder) ?? strOrName(b?.catcher) ?? null;
  const bowlerName = strOrName(b?.bowler) ?? null;

  if (bowlerName && ['catch', 'caught', 'bowled', 'lbw', 'stumped'].includes(d)) {
    const type = d === 'catch' ? 'caught' : d;
    return { status: 'parsed', type, bowler: bowlerName, fielder: fielderName };
  }
  if (d === 'cb' && bowlerName) return { status: 'parsed', type: 'caught', bowler: bowlerName, fielder: bowlerName };
  if (/^hit.?wicket$/i.test(d)) return { status: 'parsed', type: 'hit_wicket', bowler: bowlerName, fielder: null };

  // Run-out: check BOTH d and dText (this is the fix — poll-cricapi's copy
  // used to check only `d`, which is always empty on a text-only payload).
  if (/^run\s*out/.test(d) || /^run\s*out/.test(dText)) {
    const parenMatch = d.match(/run\s*out\s*\(([^)]+)\)/i) || dText.match(/run\s*out\s*\(([^)]+)\)/i);
    const parts = parenMatch
      ? parenMatch[1].split(/\s*[/\\&]\s*/).map(n => n.trim()).filter(Boolean)
      : (fielderName ? [fielderName] : []);
    return { status: 'parsed', type: 'run_out', bowler: null, fielder: parts[0] || null, fielder2: parts[1] || null };
  }

  // Shape B — parse the full free-text string (covers scraped HTML and any
  // CricAPI payload that only ever had the long form).
  const str = dText || d;
  let m;
  if ((m = str.match(/^lbw(?:\s+b\s+(.+))?/)))        return { status: 'parsed', type: 'lbw',     bowler: (m[1] || bowlerName || '').trim() || null, fielder: fielderName };
  if ((m = str.match(/^c\s*&\s*b\s+(.+)/)))           return { status: 'parsed', type: 'caught',  bowler: m[1].trim(),                               fielder: m[1].trim() };
  if ((m = str.match(/^c(?:t)?\s+(.+?)\s+b\s+(.+)/))) return { status: 'parsed', type: 'caught',  bowler: m[2].trim(),                               fielder: m[1].trim() };
  if ((m = str.match(/^st\s+(.+?)\s+b\s+(.+)/)))      return { status: 'parsed', type: 'stumped', bowler: m[2].trim(),                               fielder: m[1].trim() };
  if ((m = str.match(/^b\s+(.+)/)))                   return { status: 'parsed', type: 'bowled',  bowler: m[1].trim(),                               fielder: null };

  // Genuinely dismissed (we already ruled out not-out above) but nothing
  // matched — e.g. "retired hurt", "timed out", "obstructing the field", or
  // garbled scraper text. This used to come back as `null`, identical to a
  // not-out, and the caller silently dropped it. Now it's distinguishable.
  return { status: 'unparsed', raw: str };
}

/**
 * Back-compat wrapper — same contract the old copies in index.html /
 * poll-cricapi / scrape-scorecard exposed (parsed shape, or `null` if there
 * was nothing to credit a bowler/fielder for). Prefer classifyDismissal()
 * directly in new code so 'unparsed' results can be logged as an issue
 * instead of silently discarded.
 * @param {any} b
 * @returns {DismissalParse|null}
 */
export function parseDismissalEntry(b) {
  const c = classifyDismissal(b);
  if (c.status !== 'parsed') return null;
  const { status, ...parsed } = c;
  return parsed;
}

/**
 * Loose match of a dismissal's bowler reference (e.g. "A Russell") against
 * the full names actually listed in the bowling table ("Andre Russell").
 * Returns a `reason` alongside `name` so callers can tell "no reference at
 * all" apart from "had a reference but it didn't resolve" — the latter is
 * worth logging (misspelling, or a surname shared by two bowlers on the same
 * team), the former usually isn't. Wicket *count* is never affected either
 * way — that comes from the bowling table's own column — only the specific
 * wicket-type attribution used for the lbw/bowled bonus is at stake.
 *
 * @param {string|null} ref
 * @param {string[]} candidates
 * @returns {{ name: string|null, reason: 'matched'|'no_reference'|'no_candidate'|'ambiguous' }}
 */
export function matchBowlerName(ref, candidates) {
  if (!ref) return { name: null, reason: 'no_reference' };
  const t = ref.toLowerCase().trim();
  const exact = candidates.find(c => c.toLowerCase() === t);
  if (exact) return { name: exact, reason: 'matched' };
  const refSurname = t.split(/\s+/).pop();
  if (refSurname) {
    const bySurname = candidates.filter(c => c.toLowerCase().split(/\s+/).pop() === refSurname);
    if (bySurname.length === 1) return { name: bySurname[0], reason: 'matched' };
    if (bySurname.length > 1) return { name: null, reason: 'ambiguous' };
  }
  return { name: null, reason: 'no_candidate' };
}

// ─── Core scoring functions ──────────────────────────────────────────────────

/**
 * @param {{ runs?: number, ballsFaced?: number, fours?: number, sixes?: number, isDismissed?: boolean, role?: string }} innings
 * @param {'T20'|'ODI'|'TEST'} format
 * @param {object} rules - effective rules, from resolveEffectiveRules()
 * @returns {{ points: number, breakdown: object }}
 */
export function calcBattingPoints(innings, format, rules) {
  const { runs = 0, ballsFaced = 0, fours = 0, sixes = 0, isDismissed = false, role } = innings || {};
  const b = {};

  b.runs = runs * (rules.run ?? 0);
  b.boundary4 = fours * (rules.boundary4 ?? 0);
  b.boundary6 = sixes * (rules.boundary6 ?? 0);

  if (runs >= 100) b.century = rules.century ?? 0;
  else if (runs >= 50) b.half_century = rules.half_century ?? 0;
  else if (runs >= 30) b.thirtyRunBonus = rules.thirty_run_bonus ?? 0;

  // Duck penalty: batters / AR / WK only, never bowlers.
  if (isDismissed && runs === 0 && role !== 'bowl') b.duck = rules.duck ?? 0;

  if (rules.sr_above_170 !== undefined && ballsFaced >= 10) {
    b.strikeRateBonus = strikeRateBonus(strikeRate(runs, ballsFaced), format, rules);
  } else {
    b.strikeRateBonus = 0;
  }

  return { points: Object.values(b).reduce((a, c) => a + c, 0), breakdown: b };
}

function strikeRateBonus(sr, format, r) {
  if (sr === null) return 0;
  if (format === 'T20') {
    if (sr > 170) return r.sr_above_170 ?? 0;
    if (sr >= 140) return r.sr_140_to_170 ?? 0;
    if (sr < 70) return r.sr_below_70 ?? 0;
    if (sr < 100) return r.sr_70_to_100 ?? 0;
  }
  if (format === 'ODI') {
    if (sr > 140) return r.sr_above_140 ?? 0;
    if (sr >= 120) return r.sr_120_to_140 ?? 0;
    if (sr < 50) return r.sr_below_50 ?? 0;
    if (sr < 75) return r.sr_50_to_75 ?? 0;
  }
  return 0;
}

/**
 * @param {{ wickets?: number, wicketTypes?: string[], maidens?: number, runsConceded?: number, ballsBowled?: number, dotBalls?: number, noBalls?: number, wides?: number, hattrick?: boolean }} spell
 * @param {'T20'|'ODI'|'TEST'} format
 * @param {object} rules
 * @returns {{ points: number, breakdown: object }}
 */
export function calcBowlingPoints(spell, format, rules) {
  const { wickets = 0, wicketTypes = [], maidens = 0, runsConceded = 0, ballsBowled = 0, dotBalls = 0, noBalls = 0, wides = 0, hattrick = false } = spell || {};
  const b = {};

  b.wickets = wickets * (rules.wicket ?? 0);

  // lbw/bowled bonus — always inline here (was a separately-called function
  // only in scrape-scorecard/index.ts; same math, now one wiring).
  const premium = wicketTypes.filter(t => ['lbw', 'bowled'].includes(String(t).toLowerCase())).length;
  b.lbwBowledBonus = premium * (rules.lbw_bowled_bonus ?? 0);

  if (wickets >= 5 && rules.five_wicket_haul) b.fiveWicket = rules.five_wicket_haul;
  else if (wickets >= 4 && rules.four_wicket_haul) b.fourWicket = rules.four_wicket_haul;
  else if (wickets >= 3 && rules.three_wicket_haul) b.threeWicket = rules.three_wicket_haul;

  // Hat-trick bonus — 3 wickets in 3 consecutive deliveries, independent of
  // the wicket-haul tiers above (which key off total wickets in the innings),
  // so it stacks with whichever haul bonus applies. Never auto-detected: none
  // of our data sources reliably expose ball-by-ball sequencing, so `hattrick`
  // is only ever set true after an admin confirms it via the Review tab's
  // Potential Hat-tricks queue (see db.js confirmHattrick).
  if (hattrick && rules.hattrick_bonus) b.hattrick = rules.hattrick_bonus;

  b.maidens = maidens * (rules.maiden_over ?? 0);
  b.dotBalls = dotBalls * (rules.dot_ball ?? 0);

  // Economy bonus only once a bowler has bowled more than 1 over.
  b.economyBonus = ballsBowled > 6 ? economyBonus(economyRate(runsConceded, ballsBowled), format, rules) : 0;

  b.noBalls = noBalls * (rules.no_ball ?? 0);
  b.wides = wides * (rules.wide ?? 0);

  return { points: Object.values(b).reduce((a, c) => a + c, 0), breakdown: b };
}

function economyBonus(eco, format, r) {
  if (eco === null) return 0;
  if (format === 'T20') {
    if (eco < 5) return r.economy_below_5 ?? 0;
    if (eco < 6) return r.economy_5_to_6 ?? 0;
    if (eco >= 11) return r.economy_above_11 ?? 0;
    if (eco >= 10) return r.economy_10_to_11 ?? 0;
  }
  if (format === 'ODI') {
    if (eco < 2.5) return r.economy_below_2_5 ?? 0;
    if (eco < 3.5) return r.economy_2_5_to_3_5 ?? 0;
    if (eco >= 9) return r.economy_above_9 ?? 0;
    if (eco >= 7) return r.economy_7_to_8 ?? 0;
  }
  return 0;
}

/**
 * @param {{ catches?: number, stumpings?: number, runOutDirect?: number, runOutIndirect?: number }} fielding
 * @param {object} rules
 * @returns {{ points: number, breakdown: object }}
 */
export function calcFieldingPoints(fielding, rules) {
  const { catches = 0, stumpings = 0, runOutDirect = 0, runOutIndirect = 0 } = fielding || {};
  const b = {
    catches: catches * (rules.catch ?? 0),
    stumpings: stumpings * (rules.stumping ?? 0),
    runOutDirect: runOutDirect * (rules.run_out_direct ?? 0),
    runOutIndirect: runOutIndirect * (rules.run_out_indirect ?? 0),
  };
  return { points: Object.values(b).reduce((a, c) => a + c, 0), breakdown: b };
}

// ─── Master calculator ────────────────────────────────────────────────────────

/**
 * Total fantasy points for one player's full match performance, including
 * captaincy and booster multipliers. This is the single function every
 * consumer should call — the ingestion edge functions when first computing
 * player_match_stats.raw_points, the browser when previewing or re-scoring
 * for a custom-rules contest, and the mobile app when it needs to render an
 * itemized breakdown for an already-known total (pass the SAME rules that
 * produced that total, via resolveEffectiveRules(), so the breakdown always
 * sums to it).
 *
 * @param {{ name?: string, role?: string, captaincy?: 'captain'|'vice_captain'|'normal', batting?: object, bowling?: object, fielding?: object, is_overseas?: boolean }} player
 * @param {'T20'|'ODI'|'TEST'} format
 * @param {object} rules - effective rules for this player's match/contest, from resolveEffectiveRules()
 * @param {string|null} [booster] - active booster key for this player's squad+match ('triple_captain'|'dual_captain'|'os_double'|'indian_double'|'team_double'|null)
 * @returns {{ name: string|undefined, totalPoints: number, multiplier: number, rawPoints: number, breakdown: object }}
 */
export function calculateScore(player, format, rules, booster = null) {
  const { name, role, captaincy = 'normal', batting, bowling, fielding, is_overseas = false } = player || {};
  const breakdown = {};
  let raw = 0;

  if (batting) { const r = calcBattingPoints({ ...batting, role }, format, rules); breakdown.batting = r.breakdown; raw += r.points; }
  if (bowling) { const r = calcBowlingPoints(bowling, format, rules); breakdown.bowling = r.breakdown; raw += r.points; }
  if (fielding) { const r = calcFieldingPoints(fielding, rules); breakdown.fielding = r.breakdown; raw += r.points; }

  const captaincyKey =
    (booster === 'triple_captain' && captaincy === 'captain') ? 'triple_captain' :
    (booster === 'dual_captain' && captaincy === 'vice_captain') ? 'captain' :
    captaincy;
  const captMult = MULTIPLIERS[captaincyKey] ?? 1;

  let boosterMult = 1;
  if (booster === 'team_double') boosterMult = 2;
  else if (booster === 'os_double' && is_overseas) boosterMult = 2;
  else if (booster === 'indian_double' && !is_overseas) boosterMult = 2;

  const mult = captMult * boosterMult;
  return {
    name,
    totalPoints: Math.round(raw * mult * 10) / 10,
    multiplier: mult,
    rawPoints: Math.round(raw * 10) / 10,
    breakdown,
  };
}
