/**
 * Team Stats — how each of THIS squad's own players scored while they were
 * actually in the XI, ranked by points earned (not their raw season-wide
 * stats). Powers the Leaderboard screen's Table/Progress/Team Stats toggle.
 *
 * Ported from db.js's getSquadTeamStats(squadId) (web) — same query shape
 * (v_match_xi_with_scores, tournament-scoped via squad_id, already
 * booster-aware total_points), the same "boosted" rule (compare the actual
 * multiplier against the plain captain/VC rate) so a player is only ever
 * tagged with a booster when it actually changed their score, and — per
 * the reviewed prototype's match-by-match drilldown, which shows a
 * batting/bowling/fielding breakdown per appearance, not just points — the
 * same extra join against `player_match_stats` web's version already got
 * for free via getSquadSeason(). This is still an independent,
 * self-contained query rather than a reuse of getSquadSeasonHistory() in
 * this same directory: that function additionally recomputes bat/bowl/
 * field/bonus POINT subtotals client-side (for the existing matchweek
 * screen's per-category numbers) which Team Stats doesn't need — it only
 * needs the raw stat line to format, not to re-derive points from.
 *
 * NOTE on cross-platform sharing: this logic is intentionally duplicated
 * here rather than imported from a shared file. Despite scoringEngine.shared.js's
 * own docstring claiming mobile usage via Metro, nothing under app/src
 * actually imports it — the app's real convention (see
 * app/src/engine/cricketScoringEngine.ts) is to hand-port scoring-adjacent
 * logic per platform, not share a literal file. This function follows that
 * convention.
 */

import { supabase } from './supabase';
import { PlayerRole, BattingInnings, BowlingSpell, FieldingStats } from '../types';

export type TeamStatsLogEntry = {
  matchId: string;
  matchNumber: number | null;
  playedOn: string | null;
  homeTeamId: string | null;
  awayTeamId: string | null;
  isCaptain: boolean;
  isVc: boolean;
  basePoints: number | null;
  multiplier: number;
  totalPoints: number;
  /** True only when the actual multiplier differs from the plain
   * captain(2x)/VC(1.5x)/normal(1x) rate — i.e. a booster genuinely changed
   * this player's score, not just "some booster was active that match". */
  boosted: boolean;
  /** Booster key active this match (e.g. 'triple_captain', 'team_double') —
   * only set when `boosted` is true. Look up display metadata via
   * getBoosterMeta() from '../store/boosterStore'. */
  booster: string | null;
  /** Raw batting/bowling/fielding stat lines for this appearance — format
   * with formatBattingLine/formatBowlingLine/formatFieldingLine from
   * '../lib/playerHistory' (same formatters PlayerStatsModal uses) for the
   * drilldown's Performance column. undefined when this player has no
   * player_match_stats row for the match (DNP). */
  batting?: BattingInnings;
  bowling?: BowlingSpell;
  fielding?: FieldingStats;
};

export type TeamStatsPlayer = {
  playerId: string;
  name: string;
  role: PlayerRole;
  teamId: string | null;
  matchesInXi: number;
  pointsForTeam: number;
  timesCaptain: number;
  timesVc: number;
  log: TeamStatsLogEntry[];
};

export type SquadTeamStats = {
  seasonTotal: number;
  matchesPlayed: number;
  playersUsed: number;
  leaderboard: TeamStatsPlayer[];
};

export async function getSquadTeamStats(squadId: string): Promise<SquadTeamStats> {
  const empty: SquadTeamStats = { seasonTotal: 0, matchesPlayed: 0, playersUsed: 0, leaderboard: [] };
  if (!squadId) return empty;

  const { data: xiRows, error: e1 } = await supabase
    .from('v_match_xi_with_scores')
    .select('*')
    .eq('squad_id', squadId)
    .order('match_number');
  if (e1) throw e1;
  if (!xiRows?.length) return empty;

  const playerIds = [...new Set(xiRows.map((r: any) => r.player_id))];
  const matchIds  = [...new Set(xiRows.map((r: any) => r.match_id))];

  // Real role from `players`, not the (possibly hardcoded-'bat') value stored
  // on user_match_xi — same caveat/fix as db.js's getSquadSeason and mobile's
  // getSquadSeasonHistory in this directory.
  const roleById: Record<string, PlayerRole> = {};
  if (playerIds.length) {
    const { data: roleRows, error: e2 } = await supabase
      .from('players')
      .select('id, role')
      .in('id', playerIds);
    if (e2) throw e2;
    (roleRows || []).forEach((p: any) => { roleById[p.id] = p.role; });
  }

  // Itemized batting/bowling/fielding for every match/player combo in this
  // squad's season — same join getSquadSeason() does on web, needed here for
  // the drilldown's Performance column (see the reviewed prototype).
  const statIdx: Record<string, Record<string, any>> = {};
  if (matchIds.length && playerIds.length) {
    const { data: statRows, error: e4 } = await supabase
      .from('player_match_stats')
      .select('match_id, player_id, batting, bowling, fielding')
      .in('match_id', matchIds)
      .in('player_id', playerIds);
    if (e4) throw e4;
    (statRows || []).forEach((s: any) => {
      (statIdx[s.match_id] ??= {})[s.player_id] = s;
    });
  }

  const { data: boosterRows, error: e3 } = await supabase
    .from('user_booster_activations')
    .select('match_id, booster')
    .eq('squad_id', squadId);
  if (e3) throw e3;
  const boosterByMatch: Record<string, string> = {};
  (boosterRows || []).forEach((b: any) => { boosterByMatch[b.match_id] = b.booster; });

  const byMatchTotals: Record<string, number> = {};
  const byPlayer: Record<string, TeamStatsPlayer> = {};

  xiRows.forEach((r: any) => {
    byMatchTotals[r.match_id] = (byMatchTotals[r.match_id] || 0) + Number(r.total_points ?? 0);

    if (!byPlayer[r.player_id]) {
      byPlayer[r.player_id] = {
        playerId: r.player_id,
        name: r.player_name,
        role: roleById[r.player_id] || r.role,
        teamId: r.team_id,
        matchesInXi: 0,
        pointsForTeam: 0,
        timesCaptain: 0,
        timesVc: 0,
        log: [],
      };
    }
    const rec = byPlayer[r.player_id];
    rec.matchesInXi += 1;
    rec.pointsForTeam += Number(r.total_points ?? 0);
    if (r.is_captain) rec.timesCaptain += 1;
    if (r.is_vc) rec.timesVc += 1;

    const mult = Number(r.multiplier ?? 1);
    const plainMult = r.is_captain ? 2 : (r.is_vc ? 1.5 : 1);
    const boosted = Math.abs(mult - plainMult) > 0.01;
    const st = statIdx[r.match_id]?.[r.player_id];

    rec.log.push({
      matchId: r.match_id,
      matchNumber: r.match_number,
      playedOn: r.played_on,
      homeTeamId: r.home_team_id,
      awayTeamId: r.away_team_id,
      isCaptain: !!r.is_captain,
      isVc: !!r.is_vc,
      basePoints: r.base_points ?? null,
      multiplier: mult,
      totalPoints: Number(r.total_points ?? 0),
      boosted,
      booster: boosted ? (boosterByMatch[r.match_id] || null) : null,
      batting: st?.batting ?? undefined,
      bowling: st?.bowling ?? undefined,
      fielding: st?.fielding ?? undefined,
    });
  });

  const leaderboard = Object.values(byPlayer)
    .map(p => ({ ...p, pointsForTeam: +p.pointsForTeam.toFixed(1) }))
    .sort((a, b) => b.pointsForTeam - a.pointsForTeam);

  const seasonTotal = +Object.values(byMatchTotals)
    .reduce((sum, v) => sum + v, 0)
    .toFixed(1);

  return {
    seasonTotal,
    matchesPlayed: Object.keys(byMatchTotals).length,
    playersUsed: leaderboard.length,
    leaderboard,
  };
}
