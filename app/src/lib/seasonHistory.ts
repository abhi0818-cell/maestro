/**
 * Season Long match-by-match history for one squad — powers the leaderboard's
 * "tap a player → see their team for each matchweek" drill-down.
 *
 * Mirrors index.html's loadSLDetailInto() / db.getSquadSeason(), which reads
 * the same v_match_xi_with_scores view, but recomputes bat/bowl/field/bonus
 * point subtotals client-side from the stored batting/bowling/fielding JSONB
 * (via the ported cricketScoringEngine) instead of just itemizing lines —
 * this screen's UI shows one number per category rather than a line list.
 *
 * Category split (matches how the web's histBreakdownRowHtml groups lines):
 *   bat   = runs + boundary4 + boundary6
 *   bowl  = wickets + maidens + dotBalls
 *   field = catches + stumpings + runOutDirect + runOutIndirect (no separate
 *           fielding bonus exists in the scoring rules)
 *   bonus = everything else: century/half-century/duck/strike-rate bonus,
 *           lbw-bowled bonus, 4/5-wicket haul, economy bonus, no-ball/wide
 *           penalties
 *
 * total_points/multiplier on each row already come from the view pre-computed
 * (booster-aware) — bat/bowl/field/bonus here are the RAW, pre-multiplier
 * subtotals; the screen applies `multiplier` on top, same convention the web
 * version uses so the per-player number can never contradict the team total.
 */

import { supabase } from './supabase';
import {
  calcBattingPoints,
  calcBowlingPoints,
  calcFieldingPoints,
} from '../engine/cricketScoringEngine';
import { MatchFormat, PlayerRole, CaptaincyRole, BattingInnings, BowlingSpell, FieldingStats } from '../types';
import { getBoosterMeta } from '../store/boosterStore';
import { isMatchPlayed } from './matchLock';
import { resolveEffectiveRules } from './scoringUtils';
import { resolveBudgetWindow, resolveContestBudgetConfig, MatchLite } from './transferCap';

export type MatchWeek = { id: string; label: string; match: string; date: string };

export type BreakdownLine = { label: string; value: number };

export type MatchPlayer = {
  name: string;
  team: string;
  role: PlayerRole;
  captaincy: CaptaincyRole;
  bat: number;
  bowl: number;
  field: number;
  bonus: number;
  multiplier: number;   // booster-aware; prefer this over a hardcoded captain/VC guess
  /** Itemized points breakdown for this match — one line per scoring
   * category that contributed non-zero points (Runs, Fours, Sixes, 50+
   * bonus, Wickets, LBW/Bowled bonus, Catches, etc.), same source
   * (calcBattingPoints/calcBowlingPoints/calcFieldingPoints) as bat/bowl/
   * field/bonus above, so it can never contradict them. Mirrors web's
   * histBreakdownRowHtml line-by-line. Empty when there's no recorded stat
   * for this player in this match. */
  breakdown: BreakdownLine[];
  /** Short stat-line summary for the breakdown header — "40 (28)" runs
   * (balls), "2/22 (3.0)" wkts/runs(overs), "1 fielding" — same convention
   * as web's hist-bd-meta. Empty string when there's nothing to show. */
  statLine: string;
};

export type MatchTeam = {
  mwId: string;
  pts: number;
  boosters: Array<{ id: string; icon: string; name: string }>;
  players: MatchPlayer[];
  /** Player swaps logged in user_transfers for this match. 0 when a
   * transfer-bypass booster (wildcard/free_hit) was active — those swaps
   * are free/unlimited and never get logged, so 0 here doesn't mean "no
   * changes were made", it means "nothing was charged". Callers should
   * check `boosters` for wildcard/free_hit before treating this as a
   * literal swap count. */
  xferCount: number;
  /** Season-to-date figures AS OF this matchweek (i.e. recomputed per tab,
   * not "as of today") — cumulative transfers/boosters used through and
   * including this match, against the cap/allowance active in that match's
   * phase. transfersAllowed null = unlimited that phase. */
  seasonXferUsed:      number;
  seasonXferAllowed:   number | null;
  seasonBoosterUsed:   number;
  seasonBoosterAllowed: number;
};

// ─── Itemized breakdown lines ───────────────────────────────────────────────
// Mirrors web's histBreakdownRowHtml exactly — same line labels/order/
// thresholds — just building a typed {label,value}[] instead of HTML. Reused
// by both getSquadSeasonHistory (here) and dailyLeaderboard.ts's
// getDailyUserHistory so Season Long and Daily show identical breakdown
// formatting. Takes the ALREADY-COMPUTED breakdown records from
// calcBattingPoints/calcBowlingPoints/calcFieldingPoints (never recomputes
// scoring) so the itemized lines can never disagree with bat/bowl/field/bonus.
export function buildBreakdownLines(
  st: { batting?: BattingInnings; bowling?: BowlingSpell; fielding?: FieldingStats } | undefined,
  rules: Record<string, number>,
  batBd?: Record<string, number>,
  bowlBd?: Record<string, number>,
  fieldBd?: Record<string, number>,
): { lines: BreakdownLine[]; statLine: string } {
  const lines: BreakdownLine[] = [];
  const metaParts: string[] = [];

  const bat = st?.batting;
  if (bat && batBd) {
    if (batBd.runs)      lines.push({ label: `Runs (${bat.runs || 0} × ${rules.run})`, value: batBd.runs });
    if (batBd.boundary4) lines.push({ label: `Fours (${bat.fours || 0} × ${rules.boundary4})`, value: batBd.boundary4 });
    if (batBd.boundary6) lines.push({ label: `Sixes (${bat.sixes || 0} × ${rules.boundary6})`, value: batBd.boundary6 });
    if (batBd.century)             lines.push({ label: '100+ bonus', value: batBd.century });
    else if (batBd.half_century)   lines.push({ label: '50+ bonus', value: batBd.half_century });
    else if (batBd.thirtyRunBonus) lines.push({ label: '30+ bonus', value: batBd.thirtyRunBonus });
    if (batBd.duck)            lines.push({ label: 'Duck penalty', value: batBd.duck });
    if (batBd.strikeRateBonus) lines.push({ label: 'Strike-rate bonus', value: batBd.strikeRateBonus });
    metaParts.push(`${bat.runs || 0} (${bat.ballsFaced || 0})`);
  }

  const bowl = st?.bowling;
  if (bowl && bowlBd) {
    if (bowlBd.wickets) lines.push({ label: `Wickets (${bowl.wickets || 0} × ${rules.wicket})`, value: bowlBd.wickets });
    if (bowlBd.lbwBowledBonus) {
      const premium = (bowl.wicketTypes || []).filter(t => ['lbw', 'bowled'].includes(String(t).toLowerCase())).length;
      lines.push({ label: `LBW/Bowled bonus (${premium})`, value: bowlBd.lbwBowledBonus });
    }
    if (bowlBd.fiveWicket)       lines.push({ label: '5-wicket haul bonus', value: bowlBd.fiveWicket });
    else if (bowlBd.fourWicket)  lines.push({ label: '4-wicket haul bonus', value: bowlBd.fourWicket });
    else if (bowlBd.threeWicket) lines.push({ label: '3-wicket haul bonus', value: bowlBd.threeWicket });
    if (bowlBd.hattrick) lines.push({ label: 'Hat-trick bonus', value: bowlBd.hattrick });
    if (bowlBd.maidens)  lines.push({ label: `Maidens (${bowl.maidens || 0} × ${rules.maiden_over})`, value: bowlBd.maidens });
    if (bowlBd.dotBalls) lines.push({ label: `Dot balls (${bowl.dotBalls || 0} × ${rules.dot_ball ?? 0})`, value: bowlBd.dotBalls });
    if (bowlBd.economyBonus) lines.push({ label: 'Economy bonus', value: bowlBd.economyBonus });
    if (bowlBd.noBalls) lines.push({ label: 'No-ball penalty', value: bowlBd.noBalls });
    if (bowlBd.wides)   lines.push({ label: 'Wide penalty', value: bowlBd.wides });
    const ballsBowled = bowl.ballsBowled || 0;
    metaParts.push(`${bowl.wickets || 0}/${bowl.runsConceded || 0} (${Math.floor(ballsBowled / 6)}.${ballsBowled % 6})`);
  }

  const fld = st?.fielding;
  if (fld && fieldBd) {
    if (fieldBd.catches)        lines.push({ label: `Catches (${fld.catches || 0} × ${rules.catch})`, value: fieldBd.catches });
    if (fieldBd.stumpings)      lines.push({ label: `Stumpings (${fld.stumpings || 0} × ${rules.stumping})`, value: fieldBd.stumpings });
    if (fieldBd.runOutDirect)   lines.push({ label: `Direct run-outs (${fld.runOutDirect || 0} × ${rules.run_out_direct})`, value: fieldBd.runOutDirect });
    if (fieldBd.runOutIndirect) lines.push({ label: `Indirect run-outs (${fld.runOutIndirect || 0} × ${rules.run_out_indirect})`, value: fieldBd.runOutIndirect });
    const fcount = (fld.catches || 0) + (fld.stumpings || 0) + (fld.runOutDirect || 0) + (fld.runOutIndirect || 0);
    if (fcount) metaParts.push(`${fcount} field${fcount > 1 ? 'ings' : 'ing'}`);
  }

  return { lines, statLine: metaParts.join(' · ') };
}

export async function getSquadSeasonHistory(squadId: string): Promise<{
  matchWeeks: MatchWeek[];
  history: MatchTeam[];
}> {
  if (!squadId) return { matchWeeks: [], history: [] };

  const [
    { data: xiRows, error: e1 },
    { data: xferRows, error: e2 },
    { data: boosterRows, error: e3 },
  ] = await Promise.all([
    supabase.from('v_match_xi_with_scores').select('*').eq('squad_id', squadId).order('match_number'),
    supabase.from('user_transfers').select('match_id, points_deducted').eq('squad_id', squadId),
    supabase.from('user_booster_activations').select('match_id, booster').eq('squad_id', squadId),
  ]);
  if (e1) throw e1;
  if (e2) throw e2;
  if (e3) throw e3;
  if (!xiRows?.length) return { matchWeeks: [], history: [] };

  const matchIds  = [...new Set(xiRows.map((r: any) => r.match_id))];
  const playerIds = [...new Set(xiRows.map((r: any) => r.player_id))];

  const [{ data: roleRows }, { data: statRows }, { data: matchRows }] = await Promise.all([
    supabase.from('players').select('id, role').in('id', playerIds),
    supabase.from('player_match_stats')
      .select('match_id, player_id, batting, bowling, fielding')
      .in('match_id', matchIds).in('player_id', playerIds),
    supabase.from('matches').select('id, format, status, tournament_id').in('id', matchIds),
  ]);

  // Tournament-level scoring rules + dot_ball_enabled per tournament
  // (migration_v30) — without the dot-ball gate, a tournament with the
  // toggle OFF would still show dot-ball points baked into the
  // locally-recomputed `bowl` subtotal below, even though the
  // server-computed `total_points` (used for `xiTotal`/`pts`) already
  // excludes them. Default to built-in rules if the tournament can't be
  // resolved, matching the server-side default.
  const tournamentIds = [...new Set((matchRows || []).map((m: any) => m.tournament_id).filter(Boolean))];
  const dotBallEnabledByTournament: Record<string, boolean> = {};
  const scoringRulesByTournament: Record<string, any> = {};
  if (tournamentIds.length) {
    const { data: tRows } = await supabase
      .from('tournaments').select('id, scoring_rules, dot_ball_enabled').in('id', tournamentIds);
    (tRows || []).forEach((t: any) => {
      dotBallEnabledByTournament[t.id] = !!t.dot_ball_enabled;
      scoringRulesByTournament[t.id] = t.scoring_rules ?? null;
    });
  }
  const tournamentIdByMatch: Record<string, string> = {};
  (matchRows || []).forEach((m: any) => { tournamentIdByMatch[m.id] = m.tournament_id; });

  // Season Long squads sit inside a private-league contest, which CAN have
  // its own custom scoring_rules overriding the tournament's — same as
  // admin.js's computeAndSaveSLScoresForMatch (the source of the real
  // persisted totals). Without this, a squad in a custom-rules league would
  // see a "My Team" breakdown computed against the tournament's default
  // rules instead of the contest's, even though the server-side total
  // already correctly used the contest's rules.
  const { data: squadRow } = await supabase
    .from('user_squads').select('contest_id').eq('id', squadId).maybeSingle();
  let contestScoringRules: any = null;
  // Transfer/booster budget config for the "as of this matchweek" running
  // totals below (mirrors leaderboardStore's contestRow fetch) — undefined
  // fields all fall back to "no cap configured" so daily-shaped/legacy
  // contests without these columns still render sane (unlimited) tiles.
  let seasonXferAllowedFlat: number | null = null;
  let startMatchNumber:      number | null = null;
  let playoffStartMN:        number | null = null;
  let playoffXferAllowed:    number | null = null;
  let playoffFirstMatchUnlimited = false;
  let seasonBoosterAllowed = 0;
  let tournamentMatches: MatchLite[] = [];
  if (squadRow?.contest_id) {
    // scoring_rules stays a direct, un-fallback-ed read of THIS contest's own
    // row — a custom-rules league's own rules must win here, unlike the
    // budget fields below. (A shared league's own scoring_rules is always
    // null by construction, so contestScoringRules correctly stays null for
    // those too, falling through to the tournament default further down.)
    const { data: rulesRow } = await supabase
      .from('contests').select('scoring_rules').eq('id', squadRow.contest_id).maybeSingle();
    contestScoringRules = rulesRow?.scoring_rules ?? null;

    // Booster/transfer budget — falls back to the main SL contest's own
    // budget when this is a shared/standard private league that never had
    // its own budget columns configured (see resolveContestBudgetConfig's
    // doc comment) — without this, a shared league's season stat tiles
    // showed "unlimited transfers" (∞) / no booster budget (—) instead of
    // the real, shared SL figures.
    const contestRow = await resolveContestBudgetConfig(squadRow.contest_id);
    seasonXferAllowedFlat     = contestRow.total_transfers_allowed;
    startMatchNumber          = contestRow.start_match_number;
    playoffStartMN            = contestRow.playoff_start_match_number;
    playoffXferAllowed        = contestRow.playoff_transfers_allowed;
    playoffFirstMatchUnlimited = contestRow.playoff_first_match_unlimited;
    seasonBoosterAllowed = contestRow.available_boosters
      ? Object.values(contestRow.available_boosters)
          .reduce((sum: number, n) => sum + Number(n || 0), 0)
      : 0;
    if (contestRow.tournament_id) {
      const { data: tMatches } = await supabase
        .from('matches').select('id, match_number, status').eq('tournament_id', contestRow.tournament_id);
      tournamentMatches = (tMatches || []) as MatchLite[];
    }
  }

  // Real role from `players`, not the role stored on user_match_xi (which was
  // historically hardcoded to 'bat' for every player — see db.js's
  // getSquadSeason for the same caveat/fix).
  const roleById: Record<string, PlayerRole> = {};
  (roleRows || []).forEach((p: any) => { roleById[p.id] = p.role; });

  const statIdx: Record<string, Record<string, any>> = {};
  (statRows || []).forEach((s: any) => {
    (statIdx[s.match_id] ??= {})[s.player_id] = s;
  });

  const formatById: Record<string, MatchFormat> = {};
  (matchRows || []).forEach((m: any) => { formatById[m.id] = (m.format ?? 'T20') as MatchFormat; });

  // Don't show a match in history until it has actually been played — a
  // squad may have a saved/pre-picked XI for an upcoming match (carry-forward
  // etc.), but that match hasn't happened yet so it shouldn't appear as a
  // completed matchweek. Gate on match status (mirrors web's own filter),
  // NOT lock_time/start_time — most matches never get those populated, which
  // would otherwise make every match disappear from history.
  const playedMatchIds = new Set(
    (matchRows || []).filter(isMatchPlayed).map((m: any) => m.id),
  );

  const penaltyByMatch: Record<string, number> = {};
  const xferCountByMatch: Record<string, number> = {};
  (xferRows || []).forEach((t: any) => {
    penaltyByMatch[t.match_id] = (penaltyByMatch[t.match_id] ?? 0) + Number(t.points_deducted ?? 0);
    xferCountByMatch[t.match_id] = (xferCountByMatch[t.match_id] ?? 0) + 1;
  });

  const boosterByMatch: Record<string, string[]> = {};
  (boosterRows || []).forEach((b: any) => {
    (boosterByMatch[b.match_id] ??= []).push(b.booster);
  });

  type Group = {
    match_id: string; match_number: number; played_on: string | null;
    home_team_id: string | null; away_team_id: string | null;
    xiTotal: number; rows: any[];
  };
  const byMatch: Record<string, Group> = {};
  xiRows.forEach((r: any) => {
    if (!byMatch[r.match_id]) {
      byMatch[r.match_id] = {
        match_id: r.match_id, match_number: r.match_number, played_on: r.played_on,
        home_team_id: r.home_team_id, away_team_id: r.away_team_id,
        xiTotal: 0, rows: [],
      };
    }
    byMatch[r.match_id].rows.push(r);
    byMatch[r.match_id].xiTotal += Number(r.total_points ?? 0);
  });

  // Ascending by match number — tabs read left-to-right, oldest first, and
  // the screen defaults to the LAST (most recent) tab on open. Not-yet-played
  // matches are excluded — see playedMatchIds above.
  const groups = Object.values(byMatch)
    .filter(g => playedMatchIds.has(g.match_id))
    .sort((a, b) => (a.match_number ?? 0) - (b.match_number ?? 0));

  // "As of this matchweek" transfer budget — recomputed per match so tabs
  // show a genuine running tally instead of today's single season figure
  // repeated on every tab. phaseIds partitions the season into independent
  // pools (regular vs playoff, mirrors resolveBudgetWindow/leaderboardStore)
  // — a match's "used" only sums transfers from matches in its OWN pool, up
  // to and including itself, so crossing into the playoff phase correctly
  // starts that pool's count fresh instead of carrying the regular tally over.
  const matchNumberById: Record<string, number> = {};
  tournamentMatches.forEach(m => { matchNumberById[m.id] = m.match_number ?? 0; });
  function seasonXferAsOf(matchId: string, matchNumber: number): { used: number; allowed: number | null } {
    const { activeCap, phaseIds } = resolveBudgetWindow(
      matchNumber, tournamentMatches, startMatchNumber, playoffStartMN,
      seasonXferAllowedFlat, playoffXferAllowed, playoffFirstMatchUnlimited,
    );
    const used = phaseIds
      ? [...phaseIds]
          .filter(mid => (matchNumberById[mid] ?? Infinity) <= matchNumber)
          .reduce((sum, mid) => sum + (xferCountByMatch[mid] ?? 0), 0)
      : groups
          .filter(gr => (gr.match_number ?? 0) <= matchNumber)
          .reduce((sum, gr) => sum + (xferCountByMatch[gr.match_id] ?? 0), 0);
    return { used, allowed: activeCap };
  }
  // Boosters aren't phase-pooled — just a flat per-season allotment — so the
  // running count is a simple sum over every match up to and including this one.
  function seasonBoosterUsedAsOf(matchNumber: number): number {
    return groups
      .filter(gr => (gr.match_number ?? 0) <= matchNumber)
      .reduce((sum, gr) => sum + (boosterByMatch[gr.match_id]?.length ?? 0), 0);
  }

  const matchWeeks: MatchWeek[] = groups.map(g => ({
    id:    g.match_id,
    label: `M${g.match_number ?? '?'}`,
    match: `${g.home_team_id ?? '?'} vs ${g.away_team_id ?? '?'}`,
    date:  g.played_on
      ? new Date(g.played_on).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
      : '',
  }));

  const history: MatchTeam[] = groups.map(g => {
    const fmt   = formatById[g.match_id] ?? 'T20';
    const stats = statIdx[g.match_id] || {};
    const net   = g.xiTotal - (penaltyByMatch[g.match_id] ?? 0);
    // Effective rules for THIS match: tournament override, then this
    // squad's contest override on top, then the dot-ball gate — same
    // precedence as resolveEffectiveRules/computeAndSaveSLScoresForMatch.
    // Applied consistently to batting/bowling/fielding (previously only
    // bowling honored any override at all).
    const tournamentId = tournamentIdByMatch[g.match_id];
    const dotBallOn = dotBallEnabledByTournament[tournamentId] ?? false;
    const rules = resolveEffectiveRules(
      fmt, scoringRulesByTournament[tournamentId], contestScoringRules, dotBallOn,
    );

    const players: MatchPlayer[] = g.rows.map((r: any) => {
      const st = stats[r.player_id];
      const role = (roleById[r.player_id] || r.role || 'bat') as PlayerRole;
      let bat = 0, bowl = 0, field = 0, bonus = 0;
      let batBd: Record<string, number> | undefined;
      let bowlBd: Record<string, number> | undefined;
      let fieldBd: Record<string, number> | undefined;

      if (st?.batting) {
        batBd = calcBattingPoints({ ...st.batting, role }, fmt, rules).breakdown;
        bat   += (batBd.runs ?? 0) + (batBd.boundary4 ?? 0) + (batBd.boundary6 ?? 0);
        bonus += (batBd.century ?? 0) + (batBd.half_century ?? 0)
               + (batBd.duck ?? 0) + (batBd.strikeRateBonus ?? 0);
      }
      if (st?.bowling) {
        bowlBd = calcBowlingPoints(st.bowling, fmt, rules).breakdown;
        bowl  += (bowlBd.wickets ?? 0) + (bowlBd.maidens ?? 0) + (bowlBd.dotBalls ?? 0);
        bonus += (bowlBd.lbwBowledBonus ?? 0) + (bowlBd.fiveWicket ?? 0) + (bowlBd.fourWicket ?? 0)
               + (bowlBd.economyBonus ?? 0) + (bowlBd.noBalls ?? 0) + (bowlBd.wides ?? 0)
               + (bowlBd.hattrick ?? 0);
      }
      if (st?.fielding) {
        const fieldRes = calcFieldingPoints(st.fielding, fmt, rules);
        fieldBd = fieldRes.breakdown;
        field += fieldRes.points;
      }

      const { lines: breakdown, statLine } = buildBreakdownLines(st, rules, batBd, bowlBd, fieldBd);
      const captaincy: CaptaincyRole = r.is_captain ? 'captain' : r.is_vc ? 'vice_captain' : 'normal';

      return {
        name: r.player_name, team: r.team_id || '', role, captaincy,
        bat, bowl, field, bonus,
        multiplier: Number(r.multiplier ?? 1),
        breakdown, statLine,
      };
    });

    const boosters = (boosterByMatch[g.match_id] || []).map(id => {
      const meta = getBoosterMeta(id);
      return meta ? { id, icon: meta.icon, name: meta.name } : { id, icon: '🎯', name: id };
    });

    const xferAsOf = seasonXferAsOf(g.match_id, g.match_number ?? 0);

    return {
      mwId: g.match_id,
      pts: Math.round(net * 10) / 10,
      boosters,
      players,
      xferCount:            xferCountByMatch[g.match_id] ?? 0,
      seasonXferUsed:       xferAsOf.used,
      seasonXferAllowed:    xferAsOf.allowed,
      seasonBoosterUsed:    seasonBoosterUsedAsOf(g.match_number ?? 0),
      seasonBoosterAllowed: seasonBoosterAllowed,
    };
  });

  return { matchWeeks, history };
}
