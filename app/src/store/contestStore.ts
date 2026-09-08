/**
 * Contest Store
 * Loads active contests from Supabase and tracks which contest the user
 * is currently picking their XI for. Also owns the private-league
 * create/join actions (Phase 4 of docs/PRIVATE_LEAGUES_DESIGN.md) — mirrors
 * db.js's createPrivateLeague/joinLeagueByCode/getContestByInviteCode, which
 * only ever existed on the web client until now.
 */

import { create } from 'zustand';
import { ContestContext, ContestType, PrivateLeague, LeagueRuleType } from '../types';
import { supabase } from '../lib/supabase';

// ─── Map DB contest_type → app ContestType ────────────────────────────────────

function mapContestType(dbType: string, isPrivate: boolean): ContestType {
  if (isPrivate) return 'private';
  const t = (dbType ?? '').toLowerCase();
  if (t === 'sl' || t.includes('season') || t.includes('long')) return 'sl';
  return 'daily';
}

// ─── Exported for LeaderboardScreen tab building ──────────────────────────────

export type RealContest = {
  id:          string;   // UUID
  name:        string;
  contestType: ContestType;
  isPrivate:   boolean;
  inviteCode:  string | null;
  deadline:    string;   // ISO string (start_time of first locked match)
  // Real derivation of the rules/sharing axes (migration_v13's isSharedXI
  // concept) — previously toContestContext() just hardcoded 'standard' for
  // everything, since this type didn't carry scoring_rules/available_boosters
  // at all. isShared === true means this league's squad mirrors the member's
  // own main SL squad (same as web's isSharedXI(contest)).
  hasCustomRules:    boolean;
  hasCustomBoosters: boolean;
  isShared:          boolean;
};

// ─── Fallback mock private leagues (used until real contests load) ─────────────

export const MOCK_PRIVATE_LEAGUES: PrivateLeague[] = [
  {
    id:       'pl01',
    name:     'Office Fantasy League',
    members:  8,
    rank:     3,
    ruleType: 'standard',
    deadline: '2026-06-01T14:30:00Z',
    isActive: true,
  },
  {
    id:       'pl02',
    name:     'Friends XI',
    members:  5,
    rank:     1,
    ruleType: 'standard',
    deadline: '2026-06-01T14:30:00Z',
    isActive: true,
  },
];

// ─── Store interface ──────────────────────────────────────────────────────────

// ─── Result shapes for the join/create actions ────────────────────────────────

export type JoinLeagueResult = {
  error:             string | null;
  contest?:          RealContest;
  isShared?:         boolean;
  backfilledMatches?: number;
  backfillError?:    string | null;
};

export type CreateLeagueResult = {
  error:    string | null;
  contest?: RealContest;
};

export type MyLeagueEntry = {
  squadId:       string;
  squadName:     string;
  isSharedSquad: boolean;  // this squad's own primary_squad_id is set
  contest:       RealContest;
};

interface ContestState {
  activeContext:   ContestContext | null;
  contests:        RealContest[];         // loaded from Supabase
  contestsLoading: boolean;

  setContext:    (ctx: ContestContext | null) => void;
  clearContext:  () => void;
  loadContests:  (tournamentId: string) => Promise<void>;

  // ── Private leagues (Phase 4 — mirrors db.js) ──────────────────────────────
  // Every contest the caller has a squad in, for "Your Leagues" browsing
  // (Phase 4 polish — mirrors index.html's renderSlLeaguesTab list). Mirrors
  // db.js's getUserSquads two-query shape (fetch squads, then fetch their
  // contests by id) rather than an embedded relational select — no
  // precedent for that syntax anywhere else in this codebase, on either
  // client, so not introducing it here either.
  getMyLeagues:         (tournamentId: string) => Promise<MyLeagueEntry[]>;
  // Find the caller's own main Season Long squad (public season_long contest,
  // not private) for a tournament — the source a standard/shared private
  // league mirrors. Returns null if the tournament has no public SL contest,
  // or the caller hasn't joined it yet.
  getMainSlSquad:       (tournamentId: string) => Promise<{ id: string; name: string } | null>;
  // Look up a private league by invite code without joining — used to decide
  // shared vs independent before asking for (or skipping) a team name.
  previewLeagueByCode:  (inviteCode: string) => Promise<{ error: string | null; contest?: RealContest }>;
  // Always creates a standard/shared league (no custom rules/boosters
  // exposed here — same restriction as index.html's user-facing create
  // form; custom-rules leagues stay admin-only). Fixed at 3 members, same
  // as web (migration_v48) — only an admin can raise it afterward.
  createPrivateLeague:  (tournamentId: string, leagueName: string) => Promise<CreateLeagueResult>;
  // squadName is ignored (server defaults to 'My Team') when primarySquadId
  // is set and the caller doesn't pass a real name — callers should resolve
  // the caller's main SL squad name via getMainSlSquad first for a shared
  // league, same as index.html does, rather than asking the user to type
  // one for "the same team" again.
  joinLeagueByCode:     (inviteCode: string, squadName: string | null, primarySquadId: string | null) => Promise<JoinLeagueResult>;
}

// ─── Store ────────────────────────────────────────────────────────────────────

export const useContestStore = create<ContestState>((set) => ({
  activeContext:   null,
  contests:        [],
  contestsLoading: false,

  setContext:  (ctx) => set({ activeContext: ctx }),
  clearContext: ()  => set({ activeContext: null }),

  loadContests: async (tournamentId) => {
    // Clear stale contests immediately so the UI never shows data from a previous tournament
    set({ contests: [], contestsLoading: true });
    try {
      const [{ data, error }, { data: nextMatches }] = await Promise.all([
        supabase
          .from('contests')
          .select('id, name, contest_type, is_private, invite_code, is_active, scoring_rules, available_boosters')
          .eq('tournament_id', tournamentId)
          .eq('is_active', true)
          .order('is_private', { ascending: true })   // public contests first
          .order('contest_type', { ascending: true }), // daily before season_long
        // Real deadline = kickoff of the next not-yet-completed match in this
        // tournament — same "next match" definition teamStore.loadTournamentContext
        // uses for nextMatchTime. Falls back to a far-future placeholder only if
        // every match is already completed (e.g. the season has ended).
        supabase
          .from('matches')
          .select('start_time, lock_time')
          .eq('tournament_id', tournamentId)
          .neq('status', 'completed')
          .order('match_number', { ascending: true })
          .limit(1),
      ]);

      if (error) throw error;

      // Prefer lock_time over start_time (mirrors isMatchLocked / teamStore's
      // nextMatchTime) — otherwise a match whose lock_time was pushed forward
      // independently of start_time (a schedule correction, a delay) shows
      // the wrong deadline here even though the actual lock gate is correct.
      const nextMatchTime =
        nextMatches?.[0]?.lock_time ?? nextMatches?.[0]?.start_time ?? '2099-01-01T00:00:00Z';

      const mapped: RealContest[] = (data ?? []).map((c: any) => mapRealContest(c, nextMatchTime));

      console.log('[contestStore] loaded', mapped.length, 'contests for tournament', tournamentId,
        mapped.map(c => `${c.name}(${c.contestType},private=${c.isPrivate},shared=${c.isShared})`));

      set({ contests: mapped });
    } catch (err) {
      console.warn('[contestStore] loadContests failed:', err);
    } finally {
      set({ contestsLoading: false });
    }
  },

  getMyLeagues: async (tournamentId) => {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return [];

    const { data: squads } = await supabase
      .from('user_squads')
      .select('id, name, contest_id, primary_squad_id')
      .eq('user_id', user.id);
    if (!squads?.length) return [];

    const contestIds = [...new Set(squads.map(s => s.contest_id))];
    const { data: contestRows } = await supabase
      .from('contests')
      .select('id, name, contest_type, is_private, invite_code, is_active, scoring_rules, available_boosters')
      .in('id', contestIds)
      .eq('tournament_id', tournamentId)
      .eq('is_active', true);
    const contestMap = new Map((contestRows ?? []).map((c: any) => [c.id, c]));

    return squads
      .filter(s => contestMap.has(s.contest_id))
      .map(s => ({
        squadId:       s.id,
        squadName:     s.name,
        isSharedSquad: !!s.primary_squad_id,
        contest:       mapRealContest(contestMap.get(s.contest_id), '2099-01-01T00:00:00Z'),
      }))
      // Public contests first, then private — same ordering as loadContests.
      .sort((a, b) => Number(a.contest.isPrivate) - Number(b.contest.isPrivate));
  },

  getMainSlSquad: async (tournamentId) => {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return null;
    const { data: slContest } = await supabase
      .from('contests')
      .select('id')
      .eq('tournament_id', tournamentId)
      .eq('contest_type', 'season_long')
      .eq('is_private', false)
      .maybeSingle();
    if (!slContest?.id) return null;
    const { data: squad } = await supabase
      .from('user_squads')
      .select('id, name')
      .eq('contest_id', slContest.id)
      .eq('user_id', user.id)
      .maybeSingle();
    return squad ? { id: squad.id, name: squad.name } : null;
  },

  previewLeagueByCode: async (inviteCode) => {
    const code = inviteCode?.trim().toUpperCase();
    if (!code) return { error: 'Enter an invite code.' };
    // A raw `.from('contests').select()` here would go through the contests
    // SELECT policy (migration_v53), which only allows reading a private
    // contest you already have a user_squads row in — exactly NOT true for
    // someone about to join by code for the first time. This RPC
    // (migration_v54) does its own narrow, exact-match lookup instead,
    // bypassing that policy without reopening it — mirrors db.js's identical
    // fix for the same bug.
    const { data, error } = await supabase
      .rpc('get_contest_by_invite_code', { p_invite_code: code })
      .maybeSingle();
    if (error) return { error: error.message };
    if (!data) return { error: 'Invalid invite code — no active league found.' };
    return { error: null, contest: mapRealContest(data, '2099-01-01T00:00:00Z') };
  },

  createPrivateLeague: async (tournamentId, leagueName) => {
    const name = leagueName?.trim();
    if (!tournamentId) return { error: 'No tournament selected.' };
    if (!name)         return { error: 'Enter a league name.' };

    // Generate a short invite code — retry up to 5x on collision. Same
    // scheme as db.js's createPrivateLeague.
    const genCode = () => Math.random().toString(36).slice(2, 8).toUpperCase();
    let code: string | undefined;
    for (let attempts = 0; attempts < 5 && !code; attempts++) {
      const candidate = genCode();
      const { data: existing } = await supabase
        .from('contests').select('id').eq('invite_code', candidate).maybeSingle();
      if (!existing) code = candidate;
    }
    if (!code) return { error: 'Could not generate a unique invite code — try again.' };

    // Always standard/shared: no custom scoring_rules/available_boosters
    // exposed from this mobile form, same restriction as index.html's
    // user-facing create form (custom-rules leagues stay admin-only, built
    // from the web Admin panel). Fixed at 3 members — migration_v48's
    // trigger enforces this atomically; only an admin can raise it later.
    const row = {
      tournament_id: tournamentId,
      name,
      contest_type:  'season_long',
      is_active:     true,
      is_private:    true,
      invite_code:   code,
      scoring_rules: null,
      max_members:   3,
      available_boosters: null,
    };
    const { data, error } = await supabase.from('contests').insert(row).select().single();
    if (error) {
      // Postgres unique_violation on contests_private_league_name_key (migration_v48)
      if ((error as any).code === '23505' && /contests_private_league_name_key/.test(error.message ?? '')) {
        return { error: `A private league named "${name}" already exists in this tournament — pick a different name.` };
      }
      return { error: error.message };
    }
    return { error: null, contest: mapRealContest(data, '2099-01-01T00:00:00Z') };
  },

  joinLeagueByCode: async (inviteCode, squadName, primarySquadId) => {
    const code = inviteCode?.trim().toUpperCase();
    if (!code) return { error: 'Enter an invite code.' };

    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return { error: 'Not signed in.' };

    // Via the RPC (migration_v54), not a raw select — same reasoning as
    // previewLeagueByCode above. Cast to any: this custom RPC has no
    // generated return-type mapping, so TS would otherwise infer `{}` and
    // reject the .id/.max_members property access below.
    const { data: contestRow, error: cErr } = await supabase
      .rpc('get_contest_by_invite_code', { p_invite_code: code })
      .maybeSingle() as { data: any; error: any };
    if (cErr)      return { error: cErr.message };
    if (!contestRow) return { error: 'Invalid invite code — no active league found.' };

    const { data: existing } = await supabase
      .from('user_squads')
      .select('id')
      .eq('contest_id', contestRow.id)
      .eq('user_id', user.id)
      .maybeSingle();
    if (existing) return { error: 'You are already a member of this league.' };

    // Fast-path client-side cap check for a snappy error — migration_v48's
    // row-locking trigger (enforce_league_member_cap) is the real atomic
    // backstop, same as web; it raises the identical "This league is full."
    // message so no special-casing is needed here either.
    if (contestRow.max_members) {
      const { count } = await supabase
        .from('user_squads')
        .select('id', { count: 'exact', head: true })
        .eq('contest_id', contestRow.id);
      if ((count ?? 0) >= contestRow.max_members) return { error: 'This league is full.' };
    }

    const insertRow = {
      contest_id:       contestRow.id,
      name:             squadName?.trim() || 'My Team',
      user_id:          user.id,
      primary_squad_id: primarySquadId ?? null,
    };
    const { data: squad, error: sErr } = await supabase
      .from('user_squads')
      .insert(insertRow)
      .select()
      .single();
    if (sErr) return { error: sErr.message };

    // Blocking M1 backfill for a freshly-shared squad (migration_v50) — same
    // non-fatal-on-failure design as db.js's joinLeagueByCode: the squad row
    // already exists by this point, so a failure here shouldn't fail the
    // whole join (a retry would just hit "already a member" above with
    // nothing left to fix).
    let backfilledMatches = 0;
    let backfillError: string | null = null;
    if (primarySquadId) {
      try {
        const { data: cnt, error: bErr } = await supabase.rpc('backfill_shared_squad_history', {
          p_new_squad_id: squad.id,
          p_primary_squad_id: primarySquadId,
        });
        if (bErr) throw bErr;
        backfilledMatches = cnt ?? 0;
      } catch (e: any) {
        console.warn('[contestStore] backfill_shared_squad_history failed:', e?.message);
        backfillError = e?.message ?? 'Backfill failed';
      }
    }

    return {
      error: null,
      contest: mapRealContest(contestRow, '2099-01-01T00:00:00Z'),
      isShared: !!primarySquadId,
      backfilledMatches,
      backfillError,
    };
  },
}));

// ─── Helpers for ContestPicker and LeaderboardScreen ─────────────────────────

/** Map a raw Supabase contests row into RealContest, deriving isShared the
 *  same way index.html's isSharedXI() does. */
function mapRealContest(c: any, deadline: string): RealContest {
  const hasCustomRules    = !!(c.scoring_rules && Object.keys(c.scoring_rules).length > 0);
  const hasCustomBoosters = !!(c.available_boosters && Object.keys(c.available_boosters).length > 0);
  return {
    id:          c.id,
    name:        c.name,
    contestType: mapContestType(c.contest_type, c.is_private),
    isPrivate:   Boolean(c.is_private),
    inviteCode:  c.invite_code ?? null,
    deadline,
    hasCustomRules,
    hasCustomBoosters,
    isShared:    Boolean(c.is_private) && !hasCustomRules && !hasCustomBoosters,
  };
}

/** Convert a RealContest into a ContestContext for selection */
export function toContestContext(c: RealContest): ContestContext {
  return {
    contestId:   c.id,
    contestType: c.contestType,
    leagueId:    c.isPrivate ? c.id : null,
    leagueName:  c.name,
    ruleType:    (c.hasCustomRules || c.hasCustomBoosters ? 'custom' : 'standard') as LeagueRuleType,
    deadline:    c.deadline,
    isShared:    c.isShared,
  };
}

/** Returns active leagues as the old PrivateLeague[] shape (for backward compat) */
export function getActiveLeagues(leagues: PrivateLeague[]): PrivateLeague[] {
  return [...leagues]
    .filter(l => l.isActive)
    .sort((a, b) => new Date(a.deadline).getTime() - new Date(b.deadline).getTime());
}
