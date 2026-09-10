/**
 * Daily contest leaderboard + personal history — PER-MATCH model.
 *
 * Daily is architecturally different from SL/private leagues: there's no
 * persistent "squad" for Daily — every match gets its own fresh `user_teams`
 * row (contest_id, user_id, match_id, squad_id IS NULL — see schema.sql's
 * `user_teams_one_per_match_idx` unique constraint). So "the Daily leaderboard"
 * is inherently scoped to ONE match at a time: only the people who actually
 * picked a team for that specific match show up, and rankings start fresh
 * each match-day. This mirrors web's db.js:
 *   - getLeaderboardDaily(matchId)   → ranked entries for one match
 *   - getMatchHistoryDetailed(ids)   → one user's picks across every match
 *
 * (Contrast with SL/private, which DO have a persistent squad accumulating
 * points across the whole season — see leaderboardStore.ts / seasonHistory.ts.
 * Don't reuse this file's functions for those contest types.)
 */

import { supabase } from './supabase';
import {
  calcBattingPoints,
  calcBowlingPoints,
  calcFieldingPoints,
} from '../engine/cricketScoringEngine';
import { MatchFormat, PlayerRole, CaptaincyRole } from '../types';
import { isMatchPlayed } from './matchLock';
import { MatchWeek, MatchPlayer, MatchTeam, buildBreakdownLines } from './seasonHistory';
import { resolveDisplayName } from './profileUtils';
import { resolveEffectiveRules } from './scoringUtils';

// ─── Match picker (for the main ranked list) ──────────────────────────────────

export type DailyMatchOption = { id: string; label: string; matchNumber: number; date: string };

/**
 * Every played match (completed/in_progress) in this contest's tournament,
 * newest first — mirrors web's own Daily match-picker exactly (index.html's
 * `scoredMatches`), which lists ALL played matches regardless of whether
 * anyone's saved a team for them yet (the per-match leaderboard handles the
 * "no teams saved" empty case separately).
 *
 * IMPORTANT: this does NOT filter `user_teams` by `contest_id`. Web's own
 * saveUserTeam() never writes contest_id on the row it inserts (see db.js) —
 * it's effectively always null for Daily picks — so any query that filters
 * user_teams.contest_id will always return zero rows. Scope by tournament
 * (via this contest's tournament_id → matches) instead, same as web does.
 */
export async function getDailyMatchOptions(contestId: string): Promise<DailyMatchOption[]> {
  if (!contestId) return [];

  const { data: contestRow, error: e0 } = await supabase
    .from('contests')
    .select('tournament_id')
    .eq('id', contestId)
    .maybeSingle();
  if (e0) throw e0;
  const tournamentId = contestRow?.tournament_id;
  if (!tournamentId) return [];

  const { data: matches, error: e1 } = await supabase
    .from('matches')
    .select('id, match_number, played_on, status')
    .eq('tournament_id', tournamentId);
  if (e1) throw e1;

  // Ascending (oldest → newest) so the chip row reads left-to-right like a
  // timeline, with the most recent match as the last/rightmost tile —
  // LeaderboardScreen scrolls the row to the end and selects this last tile
  // by default, so "scroll left to see earlier matches" feels natural.
  return (matches || [])
    .filter(isMatchPlayed)
    .sort((a: any, b: any) => (a.match_number ?? 0) - (b.match_number ?? 0))
    .map((m: any) => ({
      id:          m.id,
      matchNumber: m.match_number ?? 0,
      label:       `M${m.match_number ?? '?'}`,
      date:        m.played_on
        ? new Date(m.played_on).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
        : '',
    }));
}

// ─── Ranked entries for one match ─────────────────────────────────────────────

export type DailyEntry = {
  rank:          number;
  userId:        string;
  teamId:        string;
  displayName:   string;
  teamName:      string;
  points:        number;
  isCurrentUser: boolean;
};

/** Mirrors web's db.getLeaderboardDaily(matchId). */
export async function loadDailyLeaderboard(matchId: string, currentUserId: string | null): Promise<DailyEntry[]> {
  if (!matchId) return [];

  const { data, error } = await supabase
    .from('user_teams')
    .select('id, name, user_id, user_team_match_scores(total_points)')
    .eq('match_id', matchId)
    .is('squad_id', null);
  if (error) throw error;
  if (!data?.length) return [];

  const userIds = [...new Set(data.map((t: any) => t.user_id))];
  const { data: profiles } = await supabase
    .from('profiles')
    .select('id, display_name, team_name')
    .in('id', userIds);
  const nameById: Record<string, string> = {};
  (profiles || []).forEach((p: any) => { nameById[p.id] = resolveDisplayName(p); });

  const unsorted = data.map((t: any) => ({
    userId:        t.user_id,
    teamId:        t.id,
    displayName:   nameById[t.user_id] ?? 'Player',
    teamName:      t.name ?? 'My XI',
    points:        Number(t.user_team_match_scores?.[0]?.total_points ?? 0),
    isCurrentUser: t.user_id === currentUserId,
  }));

  return unsorted
    .sort((a, b) => b.points - a.points)
    .map((e, i) => ({ ...e, rank: i + 1 }));
}

// ─── One user's personal history across every match ──────────────────────────

/**
 * One user's full Daily pick history across every match they've played in
 * this contest's tournament. Mirrors web's renderHistory()/getMatchHistoryDetailed,
 * reshaped into the same MatchWeek/MatchTeam/MatchPlayer types seasonHistory.ts
 * uses so the existing TeamDetailModal UI can render either source interchangeably.
 *
 * Same caveat as getDailyMatchOptions: user_teams.contest_id is never
 * populated by web's saveUserTeam(), so we can't filter user_teams by it.
 * Instead pull ALL of this user's Daily (squad_id IS NULL) teams, then keep
 * only the ones whose match belongs to this contest's tournament — mirrors
 * web's `activeTournamentMatchIds` filter in renderHistory().
 */
export async function getDailyUserHistory(contestId: string, userId: string): Promise<{
  matchWeeks: MatchWeek[];
  history: MatchTeam[];
}> {
  if (!contestId || !userId) return { matchWeeks: [], history: [] };

  const { data: contestRow, error: e0 } = await supabase
    .from('contests')
    .select('tournament_id')
    .eq('id', contestId)
    .maybeSingle();
  if (e0) throw e0;
  const tournamentId = contestRow?.tournament_id;
  if (!tournamentId) return { matchWeeks: [], history: [] };

  // Tournament-level scoring rules + dot_ball_enabled (migration_v30) — whole
  // contest is scoped to one tournament here, so a single lookup resolves
  // the effective rules for every matchweek below. Daily contests never get
  // per-contest overrides (only Season Long/private leagues do — see
  // resolveEffectiveRules's header), so tournament-level is the full answer
  // here. Default to built-in rules if it can't be resolved, matching the
  // server's own fallback.
  const { data: tRow } = await supabase
    .from('tournaments').select('scoring_rules, dot_ball_enabled').eq('id', tournamentId).maybeSingle();
  const dotBallOn = !!tRow?.dot_ball_enabled;
  const tournamentScoringRules = tRow?.scoring_rules ?? null;

  const { data: tMatches, error: e1 } = await supabase
    .from('matches')
    .select('id, match_number, played_on, home_team_id, away_team_id, format, status')
    .eq('tournament_id', tournamentId);
  if (e1) throw e1;
  const matchById: Record<string, any> = {};
  (tMatches || []).forEach((m: any) => { matchById[m.id] = m; });
  const tournamentMatchIds = new Set(Object.keys(matchById));

  const { data: allTeams, error: e2 } = await supabase
    .from('user_teams')
    .select('id, match_id, captain_id, vice_captain_id')
    .eq('user_id', userId)
    .is('squad_id', null)
    .not('match_id', 'is', null);
  if (e2) throw e2;

  const teams = (allTeams || []).filter((t: any) => tournamentMatchIds.has(t.match_id));
  if (!teams.length) return { matchWeeks: [], history: [] };

  const teamIds  = teams.map((t: any) => t.id);
  const matchIds = [...new Set(teams.map((t: any) => t.match_id))];

  const [{ data: scores }, { data: teamPlayers }] = await Promise.all([
    supabase.from('user_team_match_scores').select('user_team_id, total_points').in('user_team_id', teamIds),
    supabase.from('user_team_players').select('user_team_id, player_id').in('user_team_id', teamIds),
  ]);

  // Status-gated, not lock_time/start_time — see getDailyMatchOptions above.
  const playedMatchIds = new Set((tMatches || []).filter(isMatchPlayed).map((m: any) => m.id));

  const playerIdsByTeam: Record<string, string[]> = {};
  (teamPlayers || []).forEach((tp: any) => {
    (playerIdsByTeam[tp.user_team_id] ??= []).push(tp.player_id);
  });

  const allPlayerIds = [...new Set((teamPlayers || []).map((tp: any) => tp.player_id))];
  const [{ data: playerMeta }, { data: statRows }, { data: tpTeamRows }] = await Promise.all([
    supabase.from('players').select('id, name, team_id, role').in('id', allPlayerIds),
    supabase.from('player_match_stats')
      .select('match_id, player_id, batting, bowling, fielding')
      .in('match_id', matchIds).in('player_id', allPlayerIds),
    // Tournament-scoped team assignment (migration_v43: team_id/credits/
    // is_overseas are authoritative on tournament_players, not the global
    // players row — that's just the bootstrap default). Mirrors web's
    // getMatchHistoryDetailed fix — without this, a mid-tournament team
    // correction (fixed on tournament_players, same place the pick-squad
    // screen reads from) never showed up here, and this history kept
    // reading the stale global players.team_id.
    allPlayerIds.length
      ? supabase.from('tournament_players').select('player_id, team_id').eq('tournament_id', tournamentId).in('player_id', allPlayerIds)
      : Promise.resolve({ data: [] as any[] }),
  ]);
  const metaById: Record<string, any> = {};
  (playerMeta || []).forEach((p: any) => { metaById[p.id] = p; });
  const statIdx: Record<string, Record<string, any>> = {};
  (statRows || []).forEach((s: any) => { (statIdx[s.match_id] ??= {})[s.player_id] = s; });
  const tpTeamById: Record<string, string> = {};
  (tpTeamRows || []).forEach((r: any) => { tpTeamById[r.player_id] = r.team_id; });

  const scoreByTeam: Record<string, number> = {};
  (scores || []).forEach((s: any) => { scoreByTeam[s.user_team_id] = Number(s.total_points ?? 0); });

  // Only matches actually played, oldest first (tabs read left-to-right;
  // screen defaults to the most recent tab, same convention as seasonHistory.ts).
  const groups = teams
    .filter((t: any) => t.match_id && playedMatchIds.has(t.match_id) && matchById[t.match_id])
    .map((t: any) => ({ team: t, match: matchById[t.match_id] }))
    .sort((a: any, b: any) => (a.match.match_number ?? 0) - (b.match.match_number ?? 0));

  const matchWeeks: MatchWeek[] = groups.map(({ match }: any) => ({
    id:    match.id,
    label: `M${match.match_number ?? '?'}`,
    match: `${match.home_team_id ?? '?'} vs ${match.away_team_id ?? '?'}`,
    date:  match.played_on
      ? new Date(match.played_on).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
      : '',
  }));

  const history: MatchTeam[] = groups.map(({ team, match }: any) => {
    const fmt   = (match.format ?? 'T20') as MatchFormat;
    const stats = statIdx[match.id] || {};
    const pids  = playerIdsByTeam[team.id] || [];
    // Same effective rules (tournament overrides + dot-ball gate) for
    // batting, bowling AND fielding — previously only bowling honored
    // tournament-level scoring_rules, so a tournament running non-default
    // batting/fielding rules would show a "My Team" breakdown that silently
    // disagreed with the real persisted total.
    const rules = resolveEffectiveRules(fmt, tournamentScoringRules, null, dotBallOn);

    const players: MatchPlayer[] = pids.map(pid => {
      const st   = stats[pid];
      const meta = metaById[pid] || {};
      const role = (meta.role || 'bat') as PlayerRole;
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

      // Old Daily picks have no per-row multiplier column (no booster system
      // existed) — derive straight from captain_id/vice_captain_id, same
      // doubling rule web's getTeamMatchPlayers/scoreDailyTeamsForMatch use.
      const isCap = pid === team.captain_id;
      const isVc  = pid === team.vice_captain_id;
      const captaincy: CaptaincyRole = isCap ? 'captain' : isVc ? 'vice_captain' : 'normal';

      return {
        // Tournament-scoped team wins when we have one; falls back to the
        // global players.team_id only for players with no tournament_players
        // row yet (see tpTeamById fetch above).
        name: meta.name || pid, team: tpTeamById[pid] ?? meta.team_id ?? '', role, captaincy,
        bat, bowl, field, bonus,
        multiplier: isCap ? 2 : isVc ? 1.5 : 1,
        breakdown, statLine,
      };
    });

    return {
      mwId:      match.id,
      pts:       scoreByTeam[team.id] ?? 0,
      boosters:  [],   // Daily has no booster system
      players,
      xferCount:            0,     // Daily has no transfer system
      seasonXferUsed:       0,
      seasonXferAllowed:    null,
      seasonBoosterUsed:    0,
      seasonBoosterAllowed: 0,
    };
  });

  return { matchWeeks, history };
}
