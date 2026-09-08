/**
 * Team Store — Zustand
 * Central state: players list, selected XI, captain/VC, format, validation.
 *
 * Supabase integration (real schema):
 *   loadTournamentContext() — finds active tournament + upcoming match
 *   loadPlayers()           — queries tournament_players JOIN players
 *   saveXI()                — upserts user_squads, then writes user_match_xi rows
 */

import { create } from 'zustand';
import {
  Player,
  SelectedPlayer,
  MatchFormat,
  PlayerRole,
  CaptaincyRole,
  ValidationResult,
  SelectionRules,
} from '../types';
import { MOCK_PLAYERS } from '../data/mockPlayers';
import { supabase } from '../lib/supabase';
import { isMatchLocked, findNextUnlockedMatch } from '../lib/matchLock';
import { getRecentFormForPlayers } from '../lib/playerHistory';
import {
  fetchContestTransferConfig,
  fetchTournamentMatches,
  getPreviousMatchXI,
  computeIsFirstActiveLock,
  checkAndLogTransfers,
} from '../lib/transferCap';
import { useBoosterStore } from './boosterStore';
import { perfStart, perfMark } from '../lib/perf';

// ─── Rules (defaults; maxOverseas overridden per-tournament from DB) ──────────

const RULES: SelectionRules = {
  total:      11,
  budget:     100,
  role:       { wk: [1, 4], bat: [3, 6], ar: [1, 4], bowl: [3, 6] },
  maxPerTeam: 7,
  maxOverseas: { T20: 4, ODI: 11, TEST: 11 },
  domesticLabel: null,
  domesticIcon: null,
  showPlayerPhotos: true,
};

/** Display label for the active tournament's "non-overseas" bucket (e.g. 'US', 'Indian'). */
function getDomesticLabel(): string {
  return RULES.domesticLabel ?? 'Domestic';
}

/** Icon for the active tournament's domestic-double booster — emoji or data:image/... URI. */
function getDomesticIcon(): string | null {
  return RULES.domesticIcon ?? null;
}

/**
 * Whether Jersey should render player photos for the active tournament
 * (migration_v46 kill switch). PlayerCard/CricketPitch read this before
 * passing photoUrl down to Jersey, rather than Jersey checking it itself —
 * keeps Jersey a dumb renderer of whatever prop it's given.
 */
function getShowPlayerPhotos(): boolean {
  return RULES.showPlayerPhotos;
}

// ─── Validation ───────────────────────────────────────────────────────────────

// budgetCapSuspended: true while Free Hit is the effective booster for the
// match being drafted — mirrors web's slBudgetCapSuspended(). Free Hit's
// squad reverts after the match, so a one-match over-budget pick never
// carries forward as the squad's permanent baseline. Wildcard does NOT
// suspend this (its pick is permanent), only Free Hit does.
function validate(selected: SelectedPlayer[], format: MatchFormat, budgetCapSuspended = false): ValidationResult {
  const errors: string[]   = [];
  const warnings: string[] = [];

  if (selected.length > RULES.total)
    errors.push(`Max ${RULES.total} players allowed`);

  const spent = selected.reduce((s, p) => s + p.credits, 0);
  if (!budgetCapSuspended && spent > RULES.budget)
    errors.push(`Over budget by ${(spent - RULES.budget).toFixed(1)} credits`);

  for (const role of Object.keys(RULES.role) as PlayerRole[]) {
    const count      = selected.filter(p => p.role === role).length;
    const [min, max] = RULES.role[role];
    if (count > max) errors.push(`Too many ${role.toUpperCase()}s (max ${max})`);
    if (selected.length === RULES.total && count < min)
      errors.push(`Need at least ${min} ${role.toUpperCase()} (have ${count})`);
  }

  const teamCounts: Record<string, number> = {};
  selected.forEach(p => { teamCounts[p.team] = (teamCounts[p.team] ?? 0) + 1; });
  for (const [team, count] of Object.entries(teamCounts)) {
    if (count > RULES.maxPerTeam)
      errors.push(`Max ${RULES.maxPerTeam} players from one team (${team}: ${count})`);
  }

  const maxOS         = RULES.maxOverseas[format];
  const overseasCount = selected.filter(p => p.overseas).length;
  if (overseasCount > maxOS)
    errors.push(`Too many overseas players for ${format} (max ${maxOS})`);

  const hasCap = selected.some(p => p.captaincy === 'captain');
  const hasVC  = selected.some(p => p.captaincy === 'vice_captain');
  if (selected.length === RULES.total) {
    if (!hasCap) warnings.push('No captain set (2× multiplier not applied)');
    if (!hasVC)  warnings.push('No vice-captain set (1.5× multiplier not applied)');
  }

  return { valid: errors.length === 0 && selected.length === RULES.total, errors, warnings };
}

// ─── Pick-time eligibility (mirrors web's canAddToSlXi in index.html) ────────
//
// validate() above only ever runs AFTER the fact — it flags problems in a
// completed/in-progress XI but nothing consults it before Save (Save XI has
// no role-count gate at all, on web or mobile). Web never needs one in
// practice: its pool blocks you from EVER completing an invalid XI in the
// first place — canAddToSlXi/slTogglePlayer refuse to add a player if doing
// so would burn a slot a role minimum still needs, so "11 picked but only 1
// BAT of the required 3" simply can't be built through the UI. Mobile's
// togglePlayer had no equivalent — only a total-count and overseas-cap
// check — so it let you freely complete exactly that invalid XI, which then
// showed as a red "error" message that never actually blocked anything.
// This closes the gap by construction, matching web, instead of trying to
// police it after the fact.
export function canAddPlayer(
  selected: SelectedPlayer[],
  player: Player,
  format: MatchFormat,
  budgetCapSuspended = false,
): boolean {
  if (selected.length >= RULES.total) return false;

  // Budget — suspended while Free Hit is active, same as web's slBudgetCapSuspended.
  if (!budgetCapSuspended) {
    const used = selected.reduce((s, p) => s + p.credits, 0);
    if (used + player.credits > RULES.budget) return false;
  }

  const roleLimits = RULES.role[player.role];
  if (roleLimits) {
    const counts: Record<PlayerRole, number> = { wk: 0, bat: 0, ar: 0, bowl: 0 };
    selected.forEach(p => { counts[p.role] = (counts[p.role] ?? 0) + 1; });

    // Role cap
    if ((counts[player.role] ?? 0) >= roleLimits[1]) return false;

    // Reachability: if every remaining slot is needed just to satisfy the
    // roles still below their minimum, refuse to spend one on a role that's
    // already met its minimum — otherwise the XI could fill up to 11 while
    // leaving another role permanently short.
    const slotsLeft = RULES.total - selected.length;
    const totalDeficit = (Object.keys(RULES.role) as PlayerRole[])
      .reduce((s, r) => s + Math.max(0, RULES.role[r][0] - (counts[r] ?? 0)), 0);
    const thisRoleDeficit = Math.max(0, roleLimits[0] - (counts[player.role] ?? 0));
    if (totalDeficit >= slotsLeft && thisRoleDeficit === 0) return false;
  }

  // Max per real team
  const teamCount = selected.filter(p => p.team === player.team).length;
  if (teamCount >= RULES.maxPerTeam) return false;

  // Overseas cap
  if (player.overseas) {
    const maxOS = RULES.maxOverseas[format] ?? 11;
    if (selected.filter(p => p.overseas).length >= maxOS) return false;
  }

  return true;
}

// ─── Derived stats ────────────────────────────────────────────────────────────

function deriveStats(selected: SelectedPlayer[], format: MatchFormat, budgetCapSuspended = false) {
  const creditsSpent = selected.reduce((s, p) => s + p.credits, 0);
  const roleCounts   = { wk: 0, bat: 0, ar: 0, bowl: 0 } as Record<PlayerRole, number>;
  const teamCounts: Record<string, number> = {};

  selected.forEach(p => {
    roleCounts[p.role]  = (roleCounts[p.role]  ?? 0) + 1;
    teamCounts[p.team]  = (teamCounts[p.team]  ?? 0) + 1;
  });

  return {
    creditsSpent,
    creditsLeft: RULES.budget - creditsSpent,
    roleCounts,
    teamCounts,
    validation: validate(selected, format, budgetCapSuspended),
  };
}

// ─── Store interface ──────────────────────────────────────────────────────────

interface TeamState {
  // Data
  players:        Player[];
  selected:       SelectedPlayer[];
  format:         MatchFormat;
  playersLoading: boolean;
  saveError:      string | null;

  // playerId -> last-3 raw_points, newest first (null = no data for that slot).
  // Populated in one batched query after players load — see loadRecentForm.
  recentForm:     Record<string, (number | null)[]>;

  // Tournament / match context (loaded on sign-in)
  tournamentId:    string | null;
  currentMatchId:    string | null;
  currentMatchLabel: string | null;  // e.g. "M25 · MNY vs SO"
  nextMatchTime:     string | null;  // effective lock time of next match (lock_time ?? start_time, for countdown)
  isFirstMatch:      boolean;        // true until the first match of the season locks

  // True while Free Hit is the effective (staged-or-committed) booster for
  // the match being drafted — suspends the 100cr budget cap. Set by
  // MyXIScreen from boosterStore's effective pick (mirrors web's
  // slBudgetCapSuspended). Daily contests never set this.
  budgetCapSuspended: boolean;
  setBudgetCapSuspended: (suspended: boolean) => void;

  // Derived
  creditsSpent: number;
  creditsLeft:  number;
  roleCounts:   Record<PlayerRole, number>;
  teamCounts:   Record<string, number>;
  validation:   ValidationResult;

  // Actions
  loadTournamentContext: () => Promise<void>;
  loadPlayers:    () => Promise<void>;
  loadRecentForm: () => Promise<void>;
  setPlayers:    (players: Player[]) => void;
  setFormat:     (format: MatchFormat) => void;
  togglePlayer:  (player: Player) => void;
  setCaptaincy:  (playerId: string, role: CaptaincyRole) => void;
  removePlayer:  (playerId: string) => void;
  resetXI:       () => void;
  restoreXI:     (players: SelectedPlayer[]) => void;
  loadSavedXI:   (matchId: string, contestId: string, contestType?: 'daily' | 'sl' | 'private') => Promise<string | null>;
  saveXI:        (opts: SaveXIOpts) => Promise<SaveXIResult>;
  ensureSquad:   (contestId: string, name?: string | null, knownUserId?: string) => Promise<string | null>;
}

interface SaveXIOpts {
  matchId:     string;  // matches.id UUID
  contestId:   string;  // contests.id UUID
  contestType: 'daily' | 'sl' | 'private';
}

/**
 * squadId/matchId here are the REAL values saveXI ended up using — after any
 * internal redirect (matchId can move to the next unlocked match if the
 * originally-requested one already locked) or squad creation (first-ever
 * save for a contest). Callers that need to act on "whatever was just
 * actually saved" (e.g. committing a staged booster pick) MUST use these,
 * not a separately-cached matchId/squadId from elsewhere — trusting a
 * decoupled, possibly-stale value here is exactly what silently dropped
 * ShooterXI's Team Double booster: saveXI redirected to a different match
 * internally, but nothing communicated that back out, so the booster commit
 * that ran right after used the wrong (original, pre-redirect) match id.
 */
interface SaveXIResult {
  error:   string | null;
  squadId: string | null;
  matchId: string | null;
}

// ── Mirror a saved XI into user_teams + user_team_players ─────────────────
// Web's display/scoring reads (db.js getUserTeamForMatch, getAllDailyTeamsForMatch,
// listUserTeams) read user_teams FIRST and only fall back to user_match_xi if no
// complete (11-player) user_teams row exists. Without this mirror, a save made on
// mobile (which only writes user_squads/user_match_xi) is invisible to those reads —
// web keeps showing whatever team was last saved there ("old team"). This mirrors,
// in the opposite direction, the same dual-write web already does for itself
// (saveUserTeam's user_match_xi mirror; the SL lock flow's upsertSlTeam call).
// Best-effort: a failure here must not fail the primary save.
async function mirrorToUserTeams(opts: {
  contestType:   'daily' | 'sl' | 'private';
  squadId:       string;
  matchId:       string;
  userId:        string;
  playerIds:     string[];
  captainId:     string;
  viceCaptainId: string;
  format:        MatchFormat;
}) {
  const { contestType, squadId, matchId, userId, playerIds, captainId, viceCaptainId, format } = opts;
  const isDaily = contestType === 'daily';
  let teamId: string | null = null;
  const __mirrorT0 = perfStart();

  if (isDaily) {
    // One daily team per (user, match) — squad_id IS NULL distinguishes it from
    // SL rows (see migration_v6's partial unique indexes). Clear any existing
    // row first so re-saves don't collide with that constraint.
    let __t = perfStart();
    await supabase.from('user_teams').delete()
      .eq('match_id', matchId).eq('user_id', userId).is('squad_id', null);
    __t = perfMark('    [teamStore] mirrorToUserTeams: delete existing daily row', __t);

    // Match web's own default name exactly (index.html's autoXIName():
    // `M{number} · {home} vs {away}`) — previously this hardcoded 'My XI'
    // for every match, so a mobile-saved row and a web-saved row for the
    // same contest showed mismatched, inconsistent-looking team names side
    // by side on web's Daily leaderboard.
    const { data: m } = await supabase
      .from('matches')
      .select('match_number, home_team_id, away_team_id')
      .eq('id', matchId)
      .maybeSingle();
    __t = perfMark('    [teamStore] mirrorToUserTeams: match name lookup', __t);
    const name = m
      ? `M${m.match_number ?? '?'} · ${m.home_team_id || '—'} vs ${m.away_team_id || '—'}`
      : 'My XI';

    const { data: ut, error } = await supabase.from('user_teams').insert({
      name, format,
      captain_id: captainId, vice_captain_id: viceCaptainId,
      match_id: matchId, squad_id: null, user_id: userId,
    }).select('id').single();
    perfMark('    [teamStore] mirrorToUserTeams: insert daily user_teams row', __t);
    if (error) throw error;
    teamId = ut?.id ?? null;
  } else {
    // One SL team per (squad, match) — update in place if it already exists
    // (mirrors db.js's upsertSlTeam exactly).
    let __t = perfStart();
    const { data: existing } = await supabase.from('user_teams')
      .select('id').eq('squad_id', squadId).eq('match_id', matchId).limit(1);
    __t = perfMark('    [teamStore] mirrorToUserTeams: lookup existing sl row', __t);

    if (existing?.length) {
      teamId = existing[0].id;
      const { error: updErr } = await supabase.from('user_teams')
        .update({ captain_id: captainId, vice_captain_id: viceCaptainId })
        .eq('id', teamId);
      __t = perfMark('    [teamStore] mirrorToUserTeams: update sl user_teams row', __t);
      if (updErr) throw updErr;
      const { error: delErr } = await supabase.from('user_team_players')
        .delete().eq('user_team_id', teamId);
      perfMark('    [teamStore] mirrorToUserTeams: delete old sl players', __t);
      if (delErr) throw delErr;
    } else {
      const { data: ut, error } = await supabase.from('user_teams').insert({
        name: 'SL XI', format,
        captain_id: captainId, vice_captain_id: viceCaptainId,
        match_id: matchId, squad_id: squadId, user_id: userId,
      }).select('id').single();
      perfMark('    [teamStore] mirrorToUserTeams: insert sl user_teams row', __t);
      if (error) throw error;
      teamId = ut?.id ?? null;
    }
  }

  if (!teamId) return;
  const __insPlayersT0 = perfStart();
  const rows = playerIds.map(pid => ({ user_team_id: teamId as string, player_id: pid }));
  const { error: insErr } = await supabase.from('user_team_players').insert(rows);
  perfMark('    [teamStore] mirrorToUserTeams: insert user_team_players', __insPlayersT0);
  if (insErr) throw insErr;
  perfMark('  [teamStore] mirrorToUserTeams TOTAL', __mirrorT0);
}

// ─── Store ────────────────────────────────────────────────────────────────────

export const useTeamStore = create<TeamState>((set, get) => ({
  players:        MOCK_PLAYERS,
  selected:       [],
  format:         'T20',
  playersLoading: false,
  saveError:      null,
  recentForm:     {},
  tournamentId:   null,
  currentMatchId:    null,
  currentMatchLabel: null,
  nextMatchTime:  null,
  isFirstMatch:   true,
  budgetCapSuspended: false,
  setBudgetCapSuspended: (suspended: boolean) => {
    if (get().budgetCapSuspended === suspended) return;
    const { selected, format } = get();
    set({ budgetCapSuspended: suspended, ...deriveStats(selected, format, suspended) });
  },
  creditsSpent:   0,
  creditsLeft:    RULES.budget,
  roleCounts:     { wk: 0, bat: 0, ar: 0, bowl: 0 },
  teamCounts:     {},
  validation:     { valid: false, errors: [], warnings: [] },

  // ── 1. Load context for the user-selected tournament ─────────────────────
  // Reads selectedTournamentId from tournamentStore (persisted in AsyncStorage)
  // rather than auto-detecting by date — supports multiple simultaneous tournaments.
  loadTournamentContext: async () => {
    try {
      const { useTournamentStore } = require('./tournamentStore');
      const tournamentId: string | null =
        useTournamentStore.getState().selectedTournamentId;

      if (!tournamentId) {
        console.warn('[teamStore] loadTournamentContext: no tournament selected');
        return;
      }

      // Load tournament config: format + overseas cap + non-overseas label
      const { data: tData } = await supabase
        .from('tournaments')
        .select('format, max_overseas_in_xi, domestic_label, domestic_icon, show_player_photos')
        .eq('id', tournamentId)
        .single();

      if (tData) {
        const fmt = (tData.format ?? 'T20') as MatchFormat;
        // Apply tournament-specific overseas cap (overrides the static default)
        const cap = tData.max_overseas_in_xi;
        if (typeof cap === 'number') {
          RULES.maxOverseas[fmt] = cap;
        }
        RULES.domesticLabel = tData.domestic_label ?? null;
        RULES.domesticIcon  = (tData as { domestic_icon?: string | null }).domestic_icon ?? null;
        // migration_v46 kill switch — defaults true if the column is somehow
        // missing (pre-migration) or null, same "on unless explicitly off"
        // default as the DB column itself.
        const showPhotos = (tData as { show_player_photos?: boolean | null }).show_player_photos;
        RULES.showPlayerPhotos = showPhotos !== false;
      }

      // Next upcoming match — i.e. the next one to actually pick/edit an XI for.
      // Must exclude matches that have already locked (gone live), not just
      // 'completed' ones — otherwise this keeps resolving to a live match
      // whose XI is now read-only, instead of advancing to the next match the
      // user is meant to be picking (mirrors web's findNextScheduledMatch()).
      const { data: candidateMatches } = await supabase
        .from('matches')
        .select('id, start_time, lock_time, match_number, home_team_id, away_team_id, status')
        .eq('tournament_id', tournamentId)
        .neq('status', 'completed');

      const nextMatch = findNextUnlockedMatch(candidateMatches ?? []);
      const currentMatchId:    string | null = nextMatch?.id ?? null;
      // Countdown/lock-badge deadline must match the actual lock gate
      // (isMatchLocked: lock_time ?? start_time), not start_time alone —
      // otherwise a match whose lock_time was pushed forward (e.g. a
      // schedule correction) still shows "Locked" on mobile once its
      // stale start_time passes, even though the match is genuinely still
      // editable. See matchLock.ts isMatchLocked().
      const nextMatchTime:     string | null = nextMatch?.lock_time ?? nextMatch?.start_time ?? null;
      const currentMatchLabel: string | null = nextMatch
        ? `M${nextMatch.match_number ?? '?'} · ${nextMatch.home_team_id || '—'} vs ${nextMatch.away_team_id || '—'}`
        : null;

      // Determine if any match has already locked (first match played = not isFirstMatch)
      const { count } = await supabase
        .from('matches')
        .select('id', { count: 'exact', head: true })
        .eq('tournament_id', tournamentId)
        .in('status', ['live', 'in_progress', 'completed']);

      const isFirstMatch = (count ?? 0) === 0;

      // Clear the selected XI when switching to a different tournament so
      // the previous tournament's picks don't bleed into the new context.
      const prevTournamentId = get().tournamentId;
      const tournamentChanged = prevTournamentId !== null && prevTournamentId !== tournamentId;

      set({
        tournamentId,
        currentMatchId,
        currentMatchLabel,
        nextMatchTime,
        isFirstMatch,
        // Clear the picked XI when switching tournaments so the previous
        // tournament's selection doesn't bleed into the new context.
        ...(tournamentChanged ? {
          selected:    [],
          validation:  { valid: false, errors: [], warnings: [] },
          creditsSpent: 0,
          creditsLeft:  RULES.budget,
          roleCounts:   { wk: 0, bat: 0, ar: 0, bowl: 0 },
          teamCounts:   {},
        } : {}),
      });

      // Auto-load players for this tournament
      get().loadPlayers();
    } catch (err) {
      console.warn('[teamStore] loadTournamentContext failed:', err);
    }
  },

  // ── 2. Load players via tournament_players JOIN players ───────────────────
  loadPlayers: async () => {
    set({ playersLoading: true });
    try {
      const { tournamentId } = get();
      if (!tournamentId) {
        console.warn('[teamStore] loadPlayers: tournamentId not set, using mock');
        return;
      }

      const { data, error } = await supabase
        .from('tournament_players')
        .select(`
          player_id,
          team_id,
          credit_value,
          is_active,
          players!inner (
            id,
            name,
            role,
            is_overseas,
            photo_url
          ),
          teams (
            id,
            color,
            color2,
            jersey_svg
          )
        `)
        .eq('tournament_id', tournamentId)
        .eq('is_active', true)
        .order('credit_value', { ascending: false });

      if (error) throw error;

      if (data && data.length > 0) {
        const players: Player[] = data.map((tp: any) => ({
          id:        tp.players.id,
          name:      tp.players.name,
          team:      tp.team_id,             // teams.id is the text short-code (e.g. 'CSK')
          role:      tp.players.role as PlayerRole,
          credits:   Number(tp.credit_value),
          overseas:  Boolean(tp.players.is_overseas),
          teamColor:  tp.teams?.color ?? null,
          teamColor2: tp.teams?.color2 ?? null,
          teamJerseySvg: tp.teams?.jersey_svg ?? null,
          // Gated here, once, rather than in every Jersey call site — by the
          // time loadPlayers() runs, loadTournamentContext() has already set
          // RULES.showPlayerPhotos from the active tournament (it calls
          // loadPlayers() as its last step, see below). So when the kill
          // switch is off, player.photoUrl is simply null everywhere in the
          // app, and PlayerCard/CricketPitch don't need their own check.
          photoUrl: RULES.showPlayerPhotos ? (tp.players.photo_url ?? null) : null,
        }));
        set({ players });
      }
      // If empty, keep MOCK_PLAYERS as fallback
    } catch (err) {
      console.warn('[teamStore] loadPlayers failed, using mock data:', err);
    } finally {
      set({ playersLoading: false });
      // Fire-and-forget — form strip fills in once it resolves, doesn't block the pool.
      get().loadRecentForm().catch(() => {});
    }
  },

  // ── Batched "last 3 scores" lookup for every loaded player ────────────────
  // One round trip for the whole pool (see getRecentFormForPlayers) instead of
  // a query per card. Re-run whenever the player list or tournament changes.
  loadRecentForm: async () => {
    const { players, tournamentId } = get();
    if (!players.length) return;
    try {
      // Team codes for each player, so the form strip aligns to each
      // player's own team's last matches (not just the player's own stats
      // rows) — a match his team played but he sat out still claims a slot,
      // rendered as '-' instead of being skipped over.
      const teamByPlayerId = Object.fromEntries(players.map(p => [p.id, p.team]));
      const form = await getRecentFormForPlayers(players.map(p => p.id), 3, tournamentId, teamByPlayerId);
      set({ recentForm: form });
    } catch (err) {
      console.warn('[teamStore] loadRecentForm failed:', err);
    }
  },

  setPlayers: (players) => set({ players }),

  setFormat: (format) => {
    const { selected, budgetCapSuspended } = get();
    set({ format, ...deriveStats(selected, format, budgetCapSuspended) });
  },

  togglePlayer: (player) => {
    const { selected, format, budgetCapSuspended } = get();
    const alreadyIn = selected.some(p => p.id === player.id);

    if (alreadyIn) {
      const next = selected.filter(p => p.id !== player.id);
      set({ selected: next, ...deriveStats(next, format, budgetCapSuspended) });
      return;
    }

    if (!canAddPlayer(selected, player, format, budgetCapSuspended)) return;

    const next: SelectedPlayer[] = [...selected, { ...player, captaincy: 'normal' }];
    set({ selected: next, ...deriveStats(next, format, budgetCapSuspended) });
  },

  setCaptaincy: (playerId, role) => {
    const { selected, format, budgetCapSuspended } = get();
    const next = selected.map(p => {
      if (p.captaincy === role && p.id !== playerId) return { ...p, captaincy: 'normal' as CaptaincyRole };
      if (p.id === playerId) return { ...p, captaincy: p.captaincy === role ? 'normal' as CaptaincyRole : role };
      return p;
    });
    set({ selected: next, ...deriveStats(next, format, budgetCapSuspended) });
  },

  removePlayer: (playerId) => {
    const { selected, format, budgetCapSuspended } = get();
    const next = selected.filter(p => p.id !== playerId);
    set({ selected: next, ...deriveStats(next, format, budgetCapSuspended) });
  },

  resetXI: () => {
    const { format, budgetCapSuspended } = get();
    set({ selected: [], ...deriveStats([], format, budgetCapSuspended) });
  },

  restoreXI: (players) => {
    const { format, budgetCapSuspended } = get();
    set({ selected: players, ...deriveStats(players, format, budgetCapSuspended) });
  },

  // ── 3. Load last saved XI (user_match_xi primary, user_teams fallback) ────────
  //  user_match_xi  = mobile saves + web-mirrored saves (v116+)
  //  user_teams     = web daily saves made before the mirror was added
  loadSavedXI: async (matchId, contestId, contestType) => {
    const { players, format, budgetCapSuspended } = get();

    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return 'Not signed in';

    try {
      // ── Path A: user_match_xi (mobile / web-mirrored) ──────────────────────
      const { data: squad } = await supabase
        .from('user_squads')
        .select('id')
        .eq('contest_id', contestId)
        .eq('user_id', user.id)
        .maybeSingle();

      if (squad?.id) {
        // ── Path A0: squad_draft_xi (web's decoupled "current pick" draft) ────
        // Web's Save XI button (saveSlXiHandler in index.html) only writes to
        // squad_draft_xi — it does NOT touch user_match_xi until an auto-lock
        // copies the draft over at the match's start_time. So a web save made
        // before lock time is otherwise invisible to mobile. Mirrors web's own
        // load precedence in slLoadDraft: draft > lastLocked > mobile XI.
        if (contestType !== 'daily') {
          const { data: draftRow } = await supabase
            .from('squad_draft_xi')
            .select('player_ids, captain_id, vc_id')
            .eq('squad_id', squad.id)
            .maybeSingle();

          if (draftRow?.player_ids?.length === 11) {
            const restored: SelectedPlayer[] = draftRow.player_ids
              .map((pid: string) => {
                const player = players.find(p => p.id === pid);
                if (!player) return null;
                const captaincy: CaptaincyRole =
                  pid === draftRow.captain_id ? 'captain'
                  : pid === draftRow.vc_id ? 'vice_captain'
                  : 'normal';
                return { ...player, captaincy };
              })
              .filter(Boolean) as SelectedPlayer[];

            if (restored.length > 0) {
              set({ selected: restored, ...deriveStats(restored, format, budgetCapSuspended) });
              console.log(`[teamStore] loadSavedXI: restored ${restored.length} players from squad_draft_xi (web draft)`);
              return null; // success
            }
          }
        }

        const { data: xiRows, error: xiErr } = await supabase
          .from('user_match_xi')
          .select('player_id, is_captain, is_vc, role')
          .eq('squad_id', squad.id)
          .eq('match_id', matchId);

        if (xiErr) throw xiErr;

        if (xiRows && xiRows.length > 0) {
          const restored: SelectedPlayer[] = xiRows
            .map((row: any) => {
              const player = players.find(p => p.id === row.player_id);
              if (!player) return null;
              const captaincy: CaptaincyRole =
                row.is_captain ? 'captain' : row.is_vc ? 'vice_captain' : 'normal';
              return { ...player, captaincy };
            })
            .filter(Boolean) as SelectedPlayer[];

          if (restored.length > 0) {
            set({ selected: restored, ...deriveStats(restored, format, budgetCapSuspended) });
            console.log(`[teamStore] loadSavedXI: restored ${restored.length} players from user_match_xi`);
            return null; // success
          }
        }

        // ── Path A2: SL/private carry-forward ────────────────────────────────
        // SL squads don't re-save every match — the XI from the most recently
        // saved match stays "current" until the user makes a transfer. If there's
        // no row for the exact upcoming matchId yet, fall back to the squad's
        // most recently saved match (mirrors web's getLatestSavedSlMatchId /
        // getPreviousMatchXI carry-forward model in db.js). Daily skips this —
        // each day's match is independent, so no saved row truly means "pick 11".
        if (contestType !== 'daily') {
          const { data: allXi, error: allXiErr } = await supabase
            .from('user_match_xi')
            .select('player_id, is_captain, is_vc, match_id')
            .eq('squad_id', squad.id);

          if (allXiErr) throw allXiErr;

          if (allXi && allXi.length > 0) {
            const matchIds = [...new Set(allXi.map((r: any) => r.match_id))];
            const { data: matchRows } = await supabase
              .from('matches')
              .select('id, match_number')
              .in('id', matchIds);

            const numOf = (id: string) =>
              matchRows?.find((m: any) => m.id === id)?.match_number ?? 0;
            const latestMatchId = matchIds.reduce(
              (best: string | null, id: string) => (!best || numOf(id) > numOf(best) ? id : best),
              null as string | null,
            );

            const latestRows = allXi.filter((r: any) => r.match_id === latestMatchId);
            const restored: SelectedPlayer[] = latestRows
              .map((row: any) => {
                const player = players.find(p => p.id === row.player_id);
                if (!player) return null;
                const captaincy: CaptaincyRole =
                  row.is_captain ? 'captain' : row.is_vc ? 'vice_captain' : 'normal';
                return { ...player, captaincy };
              })
              .filter(Boolean) as SelectedPlayer[];

            if (restored.length > 0) {
              set({ selected: restored, ...deriveStats(restored, format, budgetCapSuspended) });
              console.log(`[teamStore] loadSavedXI: carried forward ${restored.length} players from squad's most recently saved match`);
              return null; // success
            }
          }
        }
      }

      // ── Path B: user_teams fallback (web daily saves pre-mirror) ───────────
      const { data: teamRows, error: teamErr } = await supabase
        .from('user_teams')
        .select('id, captain_id, vice_captain_id, user_team_players(player_id)')
        .eq('match_id', matchId)
        .eq('user_id', user.id)
        .is('squad_id', null)
        .order('created_at', { ascending: false })
        .limit(1);

      if (teamErr) throw teamErr;

      const team = (teamRows ?? [])[0];
      if (team) {
        const playerIds: string[] = (team.user_team_players ?? []).map((r: any) => r.player_id);
        const restored: SelectedPlayer[] = playerIds
          .map(pid => {
            const player = players.find(p => p.id === pid);
            if (!player) return null;
            const captaincy: CaptaincyRole =
              pid === team.captain_id ? 'captain'
              : pid === team.vice_captain_id ? 'vice_captain'
              : 'normal';
            return { ...player, captaincy };
          })
          .filter(Boolean) as SelectedPlayer[];

        if (restored.length > 0) {
          set({ selected: restored, ...deriveStats(restored, format, budgetCapSuspended) });
          console.log(`[teamStore] loadSavedXI: restored ${restored.length} players from user_teams (web fallback)`);
          return null; // success
        }
      }

      return 'No saved XI found for this match';
    } catch (err: any) {
      console.error('[teamStore] loadSavedXI error:', err);
      return err?.message ?? 'Failed to load saved XI';
    }
  },

  // Get-or-create the caller's user_squads row for a contest. `name` is only
  // used on the INSERT path (a squad, once created, keeps whatever name it
  // was given — this never overwrites an existing squad's name). Falls back
  // to the literal 'My Squad' if no name is supplied, which only happens for
  // a save that somehow bypassed the "name your squad" prompt shown right
  // after picking a contest.
  //
  // `knownUserId` lets a caller that has *already* resolved the current user
  // (e.g. saveXI, which needs it for other steps anyway) skip re-fetching it
  // here — auth.getUser() is a real network round trip, not a cache read, so
  // calling it twice per save was pure waste. Callers that don't already have
  // it (e.g. MyXIScreen's "name your squad" flow) just omit it and this
  // fetches it itself exactly as before.
  ensureSquad: async (contestId, name, knownUserId) => {
    const __ensureT0 = perfStart();
    let __t = perfStart();
    let userId = knownUserId;
    if (!userId) {
      const { data: { user } } = await supabase.auth.getUser();
      __t = perfMark('  [teamStore] ensureSquad: auth.getUser', __t);
      if (!user) return null;
      userId = user.id;
    } else {
      perfMark('  [teamStore] ensureSquad: auth.getUser SKIPPED (caller already had it)', __t);
    }

    const { data: existing } = await supabase
      .from('user_squads')
      .select('id')
      .eq('contest_id', contestId)
      .eq('user_id',    userId)
      .maybeSingle();
    __t = perfMark('  [teamStore] ensureSquad: lookup existing squad', __t);

    if (existing?.id) {
      perfMark('  [teamStore] ensureSquad TOTAL', __ensureT0);
      return existing.id;
    }

    const { data: newSquad, error: insertErr } = await supabase
      .from('user_squads')
      .insert({
        contest_id:               contestId,
        user_id:                  userId,
        name:                     name?.trim() || 'My Squad',
        budget_remaining:         RULES.budget,
        free_transfers_available: 1,
      })
      .select('id')
      .single();
    perfMark('  [teamStore] ensureSquad: insert new squad', __t);
    perfMark('  [teamStore] ensureSquad TOTAL', __ensureT0);

    if (insertErr) {
      console.warn('[teamStore] ensureSquad insert failed:', insertErr);
      return null;
    }
    return newSquad?.id ?? null;
  },

  // ── 4. Save XI → user_squads + user_match_xi (one row per player) ─────────
  saveXI: async ({ matchId, contestId, contestType }) => {
    const { selected } = get();
    set({ saveError: null });

    const __saveStart = perfStart();
    let __t = __saveStart;
    console.log(`[PERF] ===== saveXI START (contestType=${contestType}) =====`);

    const { data: { user } } = await supabase.auth.getUser();
    __t = perfMark('saveXI: auth.getUser', __t);
    if (!user) return { error: 'Not signed in', squadId: null, matchId: null };

    try {
      const isDailyContest = contestType === 'daily';

      // 0/3a, run concurrently — none of these three actually depend on each
      // other's result, they were just written sequentially before:
      //  - 0a. contestTournamentId (+ full transfer-cap config for sl/private,
      //    fetched once HERE and reused below instead of being fetched again
      //    inside the transfer-cap block — that used to be two separate
      //    round trips to the same `contests` row).
      //  - 0b's own lookup: the target match's lock/tournament state.
      //  - 3a. ensureSquad — it only ever reads/writes by contestId, never
      //    touches matchId, so it has no real dependency on the match-lock
      //    guard below and can safely run alongside it. (In the rare case
      //    the guard below can't find any match to redirect to and the save
      //    fails outright, this may have already get-or-created an empty
      //    squad row — harmless; that's the same row the "name your squad"
      //    prompt would create on the next attempt anyway.)
      const __parallelT0 = perfStart();
      const [contestInfo, targetMatch, squadId] = await Promise.all([
        isDailyContest
          ? supabase.from('contests').select('tournament_id').eq('id', contestId).maybeSingle()
              .then(({ data }) => ({ tournamentId: (data?.tournament_id as string | undefined) ?? null, config: null as Awaited<ReturnType<typeof fetchContestTransferConfig>>['config'] | null }))
          : fetchContestTransferConfig(contestId).then(({ config, tournamentId }) => ({ tournamentId, config })),
        supabase.from('matches')
          .select('id, tournament_id, lock_time, start_time, status')
          .eq('id', matchId)
          .maybeSingle()
          .then(({ data }) => data ?? null),
        get().ensureSquad(contestId, undefined, user.id),
      ]);
      __t = perfMark('saveXI: 0/3a parallel — contest+config, match lookup, ensureSquad', __t);

      const contestTournamentId = contestInfo.tournamentId;

      if (!squadId) return { error: 'Could not create squad', squadId: null, matchId: null };

      // 0a/0b guard against matchId/contestId pointing at two different
      // tournaments, or at an already-locked match. matchId here comes from
      // teamStore.currentMatchId, which is set by loadTournamentContext(tournamentId)
      // for whichever tournament was *globally* selected at that time — it
      // isn't re-derived from the contestId this save actually targets. If
      // the user switches the tournament picker while activeContext still
      // references a contest from the previous tournament (e.g. opening
      // MyXI for a season-long contest right as the Home tournament selector
      // flips to a different tournament), this function used to trust
      // matchId blindly and write a real user_match_xi row for the wrong
      // contest's squad against a match from a completely unrelated
      // tournament — confirmed in production data: a season-long squad ended
      // up with a full saved XI for an ENG-W vs SL-W (Women's T20 WC) match
      // even though its contest belongs to a different tournament entirely.
      // Re-resolve matchId against the contest's OWN tournament_id before
      // trusting it for anything.
      //
      // Unlike web's saveTargetMatch() (index.html), this save path had no
      // lock-time check at all — a stale screen (e.g. currentMatchId loaded
      // before this match's lock_time passed) could silently write a real
      // user_teams/user_match_xi row straight into an already-started match.
      // Mirror web's behavior: redirect to the next not-yet-started match in
      // the same tournament instead of writing into the locked one.
      const wrongTournament = Boolean(
        contestTournamentId && targetMatch?.tournament_id &&
        targetMatch.tournament_id !== contestTournamentId
      );

      if (!targetMatch || wrongTournament || isMatchLocked(targetMatch)) {
        const tournamentId = contestTournamentId ?? targetMatch?.tournament_id ?? get().tournamentId;
        let nextMatchId: string | null = null;

        if (tournamentId) {
          const { data: candidates } = await supabase
            .from('matches')
            .select('id, match_number, lock_time, start_time, status')
            .eq('tournament_id', tournamentId)
            .neq('status', 'completed');
          __t = perfMark('saveXI: 0b redirect — candidate matches lookup', __t);

          nextMatchId = findNextUnlockedMatch(candidates ?? [])?.id ?? null;
        }

        if (!nextMatchId) {
          return {
            error: wrongTournament
              ? 'Could not match this save to the right tournament. Please reopen Pick XI and try again.'
              : 'This match has already locked and there is no upcoming match to save against.',
            squadId: null, matchId: null,
          };
        }
        matchId = nextMatchId;
      }

      // 3a-bis. Season transfer-cap check (sl/private only). Mobile has no
      // separate draft/lock step — this save IS the lock — so the cap must be
      // checked here, before any row is written, rather than at a later
      // "lock time" the way web's lockMatchXI does (it's only ever called
      // from web's unattended auto-lock cron, which swallows the throw after
      // user_match_xi has already been written — fine there, wrong order to
      // copy for a path the user's Save button calls directly).
      if (!isDailyContest && contestInfo.config) {
        const __capT0 = perfStart();
        try {
          const config = contestInfo.config;
          const allMatches = contestTournamentId ? await fetchTournamentMatches(contestTournamentId) : [];
          const prev = await getPreviousMatchXI(squadId, matchId, allMatches, config.start_match_number);
          const isFirstActiveLock = await computeIsFirstActiveLock(squadId, prev, allMatches);
          const baselinePlayerIds = isFirstActiveLock ? [] : prev.playerIds;

          // Wildcard or Free Hit staged/active for this match bypasses the
          // cap entirely (mirrors web's bypassTransfers) — read whichever is
          // currently effective (staged-or-committed) for this exact match.
          const bs = useBoosterStore.getState();
          const effectiveBooster = bs._matchId === matchId ? bs._pendingId : null;
          const bypassTransfers = effectiveBooster === 'wildcard' || effectiveBooster === 'free_hit';

          await checkAndLogTransfers({
            squadId,
            matchId,
            playerIds: selected.map(p => p.id),
            previousPlayerIds: baselinePlayerIds,
            config,
            allMatches,
            bypassTransfers,
          });
        } catch (capErr: any) {
          const msg = capErr?.message ?? 'Transfer limit check failed';
          set({ saveError: msg });
          return { error: msg, squadId: null, matchId: null };
        }
        __t = perfMark('saveXI: 3a-bis transfer-cap block (total, see breakdown above)', __capT0);
      }

      // 3b. Delete this match's existing XI rows then re-insert
      const { error: delErr } = await supabase
        .from('user_match_xi')
        .delete()
        .eq('squad_id', squadId)
        .eq('match_id', matchId);
      __t = perfMark('saveXI: 3b delete existing XI rows', __t);

      if (delErr) throw delErr;

      // 3c. Insert one row per selected player
      const rows = selected.map(p => ({
        squad_id:   squadId as string,
        match_id:   matchId,
        player_id:  p.id,
        is_captain: p.captaincy === 'captain',
        is_vc:      p.captaincy === 'vice_captain',
        role:       p.role,
        user_id:    user.id,
      }));

      const { error: insertErr } = await supabase
        .from('user_match_xi')
        .insert(rows);
      __t = perfMark('saveXI: 3c insert new XI rows', __t);

      if (insertErr) throw insertErr;

      // 3d + 3e. Two independent best-effort mirrors, run concurrently. Both
      // run only AFTER 3b/3c's real user_match_xi write has already
      // succeeded (never in parallel WITH it) — each is already individually
      // tolerant of its own failure (caught below, save still succeeds), but
      // if the real write itself failed partway through while a mirror had
      // already gone out, web would show a "saved" team with no actual saved
      // XI behind it. Once the real write is done, though, these two don't
      // depend on each other or on anything else, so there's no reason to
      // make one wait on the other.
      //
      // 3d. Mirror into user_teams + user_team_players. Web's "my team" reads
      // (db.js getUserTeamForMatch/getAllDailyTeamsForMatch/listUserTeams) check
      // user_teams FIRST and only fall back to user_match_xi if no complete row
      // exists there — without this, a mobile-only save is invisible to web and
      // it keeps showing the last team saved there. Best-effort: a failure here
      // must not fail the save the user actually asked for.
      //
      // 3e. Mirror into squad_draft_xi (sl/private only) — keeps web's draft
      // table in sync with a mobile save, mirroring db.js's saveDraft exactly.
      // Without this, web's slLoadDraft (draft > lastLocked > mobile XI) could
      // keep showing an older draft instead of what was just saved here.
      // target_match_id = matchId (the REAL, post-redirect match this XI was
      // just written for) — since this row came straight from a real,
      // already-completed lock (mobile's save IS the lock), it's fully
      // confirmed; tagging it lets web's lockMatchXI guarantee check (see
      // migration_v35) trust it outright instead of falling back to
      // carry-forward. Best-effort: a failure here must not fail the save
      // the user asked for.
      const captainId     = selected.find(p => p.captaincy === 'captain')?.id;
      const viceCaptainId = selected.find(p => p.captaincy === 'vice_captain')?.id;
      const __mirrorsT0 = perfStart();
      const mirrorTasks: Promise<void>[] = [];

      if (selected.length === 11 && captainId && viceCaptainId) {
        mirrorTasks.push(
          mirrorToUserTeams({
            contestType, squadId, matchId, userId: user.id,
            playerIds: selected.map(p => p.id),
            captainId, viceCaptainId,
            format: get().format,
          }).catch(mirrorErr => {
            console.warn('[teamStore] user_teams mirror failed (non-fatal, web may show a stale team):', mirrorErr);
          }),
        );
      } else {
        console.warn('[teamStore] saveXI: skipped user_teams mirror (XI incomplete or missing C/VC)');
      }

      if (contestType !== 'daily' && captainId && viceCaptainId) {
        mirrorTasks.push(
          (async () => {
            try {
              await supabase.from('squad_draft_xi').upsert({
                squad_id:        squadId,
                player_ids:      selected.map(p => p.id),
                captain_id:      captainId,
                vc_id:           viceCaptainId,
                target_match_id: matchId,
                updated_at:      new Date().toISOString(),
              }, { onConflict: 'squad_id' });
            } catch (draftErr) {
              console.warn('[teamStore] squad_draft_xi mirror failed (non-fatal, web may show a stale draft):', draftErr);
            }
          })(),
        );
      }

      await Promise.all(mirrorTasks);
      __t = perfMark('saveXI: 3d+3e mirrors (parallel, total)', __mirrorsT0);

      perfMark(`===== saveXI TOTAL (contestType=${contestType}) =====`, __saveStart);
      return { error: null, squadId, matchId }; // success — REAL ids used, post-redirect/creation
    } catch (err: any) {
      perfMark(`===== saveXI TOTAL — FAILED (contestType=${contestType}) =====`, __saveStart);
      const msg = err?.message ?? 'Save failed';
      console.error('[teamStore] saveXI error:', err);
      set({ saveError: msg });
      return { error: msg, squadId: null, matchId: null };
    }
  },
}));

export { RULES, getDomesticLabel, getDomesticIcon, getShowPlayerPhotos };
