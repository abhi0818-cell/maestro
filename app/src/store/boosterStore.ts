/**
 * Booster Store
 * Season Long / private leagues only.
 *
 * Booster definitions live in contests.available_boosters ({boosterId: uses} object).
 * Which ones have been used is tracked in user_booster_activations.
 *
 * STAGED-THEN-COMMIT MODEL (mirrors index.html's getSlBoosterContext /
 * renderSlBoosterGrid / saveSlXiHandler):
 * Tapping a booster (selectBooster) only updates LOCAL state — nothing is
 * written to user_booster_activations until commitPending() is called.
 * MyXIScreen calls commitPending() from the same handler that saves the XI,
 * so the booster choice and the XI save commit together, exactly like web's
 * "pick stages instantly, Save XI is the only thing that persists it" flow.
 * Previously this store wrote to Supabase the instant a pill was tapped
 * (via Alert.alert's "Activate"/"Remove" confirm) — that's what made mobile
 * diverge from web and is the gap this rewrite closes.
 *
 * Scope controls which player tiles show the booster icon when active:
 *   'captain'       → only the Captain tile
 *   'vice_captain'  → only the Vice-Captain tile
 *   'all'           → every tile in the XI (e.g. "Team Double")
 *
 * Slot controls conflict: two boosters in the same slot cannot both be active
 * (in practice only one booster total can be active per match — see
 * selectBooster — but slot is kept for the tile-boost helper below).
 */

import { create } from 'zustand';
import { supabase } from '../lib/supabase';
import { CaptaincyRole } from '../types';
import { isMatchLocked } from '../lib/matchLock';
import {
  fetchContestTransferConfig,
  fetchTournamentMatches,
  getPreviousMatchXI,
} from '../lib/transferCap';

// ─── Types ────────────────────────────────────────────────────────────────────

// 'active'  = effective for this match AND already committed to the DB
// 'pending' = effective for this match but only staged — Save XI hasn't
//             committed it yet (mirrors web's "isUnsaved" / asterisk state)
// 'used'    = exhausted, blocked by another active pick, or pointless on this
//             match (transfer boosters on a transfers-unlimited match)
// 'available' = selectable, nothing chosen
export type BoosterStatus = 'available' | 'pending' | 'active' | 'used';
export type BoosterScope  = 'captain' | 'vice_captain' | 'captain_and_vc' | 'all';
export type BoosterSlot   = 'captain' | 'vice_captain' | 'squad' | 'transfers';

export interface Booster {
  id:     string;
  icon:   string;
  name:   string;
  fullName: string;
  desc:   string;
  scope:  BoosterScope;
  slot:   BoosterSlot;
  status: BoosterStatus;
  /** Uses already spent in OTHER matches (current match's own pick excluded). */
  usedInOther: number;
  totalUses:   number;
}

// ─── Static metadata (mirrors BOOSTER_META in index.html) ────────────────────

interface BoosterMeta {
  icon:  string;
  /** Short label shown on the tile itself — kept tight (2-3 chars where
   * possible) so all 7 boosters fit in one un-scrollable row without
   * truncating (see BoostersBar.tsx). */
  name:  string;
  /** Full, unabbreviated name — used anywhere there's room to spell it out
   * (long-press info alert title, staged/removed toasts), so shortening
   * `name` for tile-width reasons never actually hides the real name. */
  fullName: string;
  desc:  string;
  scope: BoosterScope;
  slot:  BoosterSlot;
}

export const BOOSTER_META: Record<string, BoosterMeta> = {
  triple_captain: {
    icon:  '⚡',
    name:  '3xC',
    fullName: 'Triple Captain',
    desc:  "Your Captain scores 3× their base points for one match. Use once per season.",
    scope: 'captain',
    slot:  'captain',
  },
  dual_captain: {
    icon:  '👥',
    name:  'C+C',
    fullName: 'Dual Captain',
    desc:  "Both Captain and Vice-Captain score 2× their base points for one match. Use once per season.",
    // Applies to BOTH the Captain and Vice-Captain tiles — mirrors web's
    // pitchBoosterDecor, which sets `boosted` for `(isCap || isVc)` when
    // dual_captain is active. 'vice_captain' scope only lit up the VC tile
    // on mobile, which was the mobile-only rendering bug.
    scope: 'captain_and_vc',
    slot:  'vice_captain',
  },
  team_double: {
    icon:  '🚀',
    name:  'T2x',
    fullName: 'Team 2x',
    desc:  "All 11 players score 2x their base points. Use once per season.",
    scope: 'all',
    slot:  'squad',
  },
  free_hit: {
    icon:  '🔄',
    name:  'FH',
    fullName: 'Free Hit',
    desc:  "Unlimited transfers this match with no budget-cap limit; Team reverts to previous match's locked team after the match. Use once per season.",
    scope: 'all',
    slot:  'transfers',
  },
  wildcard: {
    icon:  '♾️',
    name:  'WC',
    fullName: 'Wildcard',
    desc:  "Unlimited transfers this match — Locked Team is carried forward in the next match. Use once per season.",
    scope: 'all',
    slot:  'transfers',
  },
  indian_double: {
    icon:  '🇺🇸',
    name:  'D2x',
    fullName: 'US 2x',
    desc:  "All US domestic (non-overseas) players in your XI score 2× their base points. Use once per season.",
    scope: 'all',
    slot:  'squad',
  },
  os_double: {
    icon:  '✈️',
    name:  'O2x',
    fullName: 'OS 2x',
    desc:  "All overseas players in your XI score 2× their base points. Use once per season.",
    scope: 'all',
    slot:  'squad',
  },
  // Legacy names (kept for backward compat with old DB rows)
  super_cap: {
    icon:  '⚡',
    name:  'Super Captain',
    fullName: 'Super Captain',
    desc:  "Doubles your Captain's 2× multiplier to 4×. Use once per season.",
    scope: 'captain',
    slot:  'captain',
  },
  super_vc: {
    icon:  '🚀',
    name:  'Super Vice-Captain',
    fullName: 'Super Vice-Captain',
    desc:  "Doubles your Vice-Captain's 1.5× multiplier to 3×. Use once per season.",
    scope: 'vice_captain',
    slot:  'vice_captain',
  },
};

export const TRANSFER_BOOSTERS = new Set(['wildcard', 'free_hit']);

// ─── Dynamic domestic-double metadata (mirrors index.html) ────────────────────
// 'indian_double' in BOOSTER_META above is a static legacy fallback only —
// the real label/icon come from the active tournament's domesticLabel/
// domesticIcon (teamStore.RULES), since "domestic" means something different
// per tournament (US for MLC, Caribbean for CPL, Indian for IPL, ...) and
// there isn't always a single accurate flag (no Unicode flag exists for
// "West Indies"/"Caribbean" — it's a multi-nation team, not a country).
const DOMESTIC_ICON_FALLBACK = '🏏';

function getDomesticBoosterMeta(): BoosterMeta {
  // Lazy require avoids a circular import (teamStore imports this file).
  const { getDomesticLabel, getDomesticIcon } = require('./teamStore');
  const label = getDomesticLabel();
  return {
    icon:  getDomesticIcon() || DOMESTIC_ICON_FALLBACK,
    // First letter of the tournament's domestic label, e.g. 'U2x' (US/MLC),
    // 'I2x' (Indian/IPL), 'C2x' (Caribbean/CPL) — disambiguates this tile
    // from team_double's 'T2x' and os_double's 'O2x' now that all three
    // can appear together in one contest's available_boosters.
    name:  `${(label?.[0] || 'D').toUpperCase()}2x`,
    fullName: `${label} 2x`,
    desc:  `All ${label} (non-overseas) players in your XI score 2× their base points.`,
    scope: 'all',
    slot:  'squad',
  };
}

/** Looks up booster metadata by id, resolving 'indian_double' dynamically per tournament. */
export function getBoosterMeta(id: string): BoosterMeta | undefined {
  if (id === 'indian_double') return getDomesticBoosterMeta();
  return BOOSTER_META[id];
}

// ─── Tile-boost decor ─────────────────────────────────────────────────────────

export interface TileBoosterDecor {
  /** Overrides the C/VC badge's letter (e.g. '⚡', '👥') — null = show the plain letter. */
  badgeIcon: string | null;
  /** Gold ring around the jersey (mirrors web's .pitch-jwrap.boosted). */
  boosted: boolean;
  /** Small badge bottom-left of the jersey — US Double only, so far. */
  bottomLeftIcon: string | null;
}

/**
 * Mirrors web's pitchBoosterDecor (index.html) exactly, id-by-id, instead of
 * generically matching on `scope`. Only one booster is ever active per
 * match, so this takes that single booster's id directly rather than a list.
 *
 * scope: 'all' was NOT a safe stand-in for this on its own — os_double and
 * indian_double are also scope: 'all' (their contest-config grouping is
 * still "applies across the whole squad"), but which INDIVIDUAL tiles they
 * decorate depends on that player's overseas status, which a bare scope
 * check has no way to see. Matching web's per-id logic here fixes that:
 * previously every tile in the XI lit up for os_double/indian_double
 * regardless of whether that specific player was actually overseas.
 */
export function getTileBoosterDecor(
  captaincy: CaptaincyRole,
  overseas: boolean,
  boosterKey: string | null,
): TileBoosterDecor {
  if (boosterKey && TRANSFER_BOOSTERS.has(boosterKey)) boosterKey = null;

  const isCap = captaincy === 'captain';
  const isVc  = captaincy === 'vice_captain';

  const capIcon = boosterKey === 'triple_captain' ? '⚡'
                : boosterKey === 'dual_captain'   ? '👥' : null;

  const badgeIcon =
    isCap ? capIcon
    : isVc ? (boosterKey === 'dual_captain' ? capIcon : null)
    : null;

  const boosted = !!(
    (boosterKey === 'triple_captain' && isCap) ||
    (boosterKey === 'dual_captain'   && (isCap || isVc)) ||
    (boosterKey === 'os_double'      && overseas) ||
    (boosterKey === 'indian_double'  && !overseas) ||
    boosterKey === 'team_double'
  );

  // Team Double applies to every tile — previously shown once on the
  // role-row label instead of repeating per tile; the row label is hidden
  // now (see CricketPitch.tsx), so it shows here on every tile like web does.
  const bottomLeftIcon =
    boosterKey === 'team_double' ? '🚀'
    : (boosterKey === 'indian_double' && !overseas) ? getDomesticBoosterMeta().icon
    : null;

  return { badgeIcon, boosted, bottomLeftIcon };
}

// ─── Low-level DB ops (mirror db.js's activateBooster / deactivateBooster) ────

async function dbActivate(
  squadId: string,
  matchId: string,
  booster: string,
  snapshot?: { playerIds: string[]; captainId: string | null; vcId: string | null } | null,
): Promise<void> {
  // Plain insert, NOT upsert — the table's unique constraint is the 3-column
  // (squad_id, match_id, booster), not (squad_id, match_id) — see db.js.
  const { error } = await supabase
    .from('user_booster_activations')
    .insert({ squad_id: squadId, match_id: matchId, booster, snapshot: snapshot ?? null });
  if (error) {
    if ((error as any).code === '23505') {
      throw new Error(`${booster.replace(/_/g, ' ')} is already active for this match.`);
    }
    throw error;
  }
}

async function dbDeactivate(squadId: string, matchId: string, booster: string): Promise<void> {
  const { error } = await supabase
    .from('user_booster_activations')
    .delete()
    .eq('squad_id', squadId)
    .eq('match_id', matchId)
    .eq('booster', booster);
  if (error) throw error;
}

// ─── Store ────────────────────────────────────────────────────────────────────

interface BoosterState {
  boosters: Booster[];
  loading:  boolean;
  /** True when the staged pick differs from what's committed in the DB. */
  isUnsaved: boolean;

  // Context retained from the last loadBoosters() call so commitPending()
  // doesn't need every caller to re-pass squadId/matchId.
  _contestId:   string | null;
  _squadId:     string | null;
  _matchId:     string | null;
  _committedId: string | null;
  _pendingId:   string | null;
  _transfersUnlimited: boolean;

  /**
   * Load boosters for a squad + match.
   * - Fetches available_boosters (+ start_match_number / playoff_start_match_number)
   *   from the contest
   * - Fetches this squad's activations to compute uses-remaining and the
   *   committed pick for this match
   * - Resets the staged pick to the committed one whenever the match being
   *   viewed changes (an in-flight pick for a DIFFERENT match must not leak
   *   into the newly-viewed match) — mirrors getSlBoosterContext's
   *   pendingBoosterMatchId reset.
   * - isFirstMatchFallback: tournament-wide "no match has locked yet" signal
   *   from teamStore, used only if the contest row has no
   *   start_match_number configured (defensive fallback).
   */
  loadBoosters: (
    contestId: string,
    squadId: string | null,
    matchId: string,
    isFirstMatchFallback?: boolean,
  ) => Promise<void>;

  /**
   * Stage (or un-stage) a booster for the currently loaded match — LOCAL
   * ONLY, nothing is written to Supabase. Selecting a different booster than
   * the one currently staged swaps the staged pick (only one booster can be
   * effective per match). Tapping the currently-effective booster clears it.
   * No-op for boosters whose status is 'used'.
   */
  selectBooster: (id: string) => void;

  /** Discard the staged pick, reverting to whatever's committed in the DB. */
  discardPending: () => void;

  /**
   * Commit the staged pick to user_booster_activations. Call this from the
   * same action that saves the XI (mirrors saveSlXiHandler's step 2b) — NOT
   * from the booster pill tap. No-op (returns null) if nothing changed.
   *
   * overrideSquadId/overrideMatchId: pass the REAL squadId/matchId that
   * saveXI just used (its return value, after any internal redirect/
   * creation) — NOT this store's own cached _squadId/_matchId, which can be
   * stale (e.g. from before this squad existed, or from before saveXI
   * redirected to a different match). This is exactly what silently dropped
   * ShooterXI's Team Double: commitPending trusted a decoupled, possibly-
   * stale cached context instead of verifying fresh against what was
   * actually just saved. If omitted, falls back to the cached values (only
   * safe when the caller genuinely has nothing fresher).
   *
   * Throws (does not silently return null) if there's a staged change but
   * squadId/matchId can't be resolved, or if a post-commit read-back shows
   * the DB doesn't actually reflect what was just attempted — callers must
   * surface this to the user rather than assume success.
   */
  commitPending: (overrideSquadId?: string | null, overrideMatchId?: string | null) => Promise<{ changed: boolean; message: string } | null>;

  /** Boosters currently effective (committed-and-saved) for this match. */
  activeBoosters: () => Booster[];
}

function buildBoosterList(
  availableMap:   Record<string, number>,
  usedCounts:     Record<string, number>,
  committedId:    string | null,
  pendingId:      string | null,
  transfersUnlimited: boolean,
): Booster[] {
  return Object.keys(availableMap).map(id => {
    const meta = getBoosterMeta(id) ?? {
      icon: '🎯', name: id, fullName: id, desc: '', scope: 'all' as BoosterScope, slot: 'squad' as BoosterSlot,
    };

    const totalUses   = availableMap[id] ?? 1;
    const usedInOther = usedCounts[id]   ?? 0; // current match's own pick already excluded by caller
    const isEffective = pendingId === id;       // the pick that WOULD apply if saved now
    const isUnsavedPick = isEffective && pendingId !== committedId;

    const remaining = totalUses - usedInOther;
    const isSpent    = remaining <= 0;
    // Another booster is already staged for this match — only one allowed.
    const anotherActive = !!pendingId && !isEffective;
    const isBlockedByTransfersUnlimited = TRANSFER_BOOSTERS.has(id) && transfersUnlimited;

    let status: BoosterStatus;
    if (isEffective) {
      // An effective pick is always selectable (to deselect), regardless of
      // spent/blocked status — mirrors web's "isDisabled = isActive ? false : ..."
      status = isUnsavedPick ? 'pending' : 'active';
    } else if (isSpent || anotherActive || isBlockedByTransfersUnlimited) {
      status = 'used';
    } else {
      status = 'available';
    }

    return { id, ...meta, status, usedInOther, totalUses };
  });
}

export const useBoosterStore = create<BoosterState>((set, get) => ({
  boosters:  [],
  loading:   false,
  isUnsaved: false,

  _contestId:   null,
  _squadId:     null,
  _matchId:     null,
  _committedId: null,
  _pendingId:   null,
  _transfersUnlimited: false,

  loadBoosters: async (contestId, squadId, matchId, isFirstMatchFallback = false) => {
    set({ loading: true });
    try {
      // 1. Contest config — available boosters + season/playoff start matches
      const { data: contestRow, error: contestErr } = await supabase
        .from('contests')
        .select('available_boosters, start_match_number, playoff_start_match_number, playoff_first_match_unlimited')
        .eq('id', contestId)
        .single();
      if (contestErr) throw contestErr;

      // available_boosters is stored as {boosterId: numberOfUses}; also
      // accept legacy string[] format.
      const rawBoosters = contestRow?.available_boosters;
      const availableMap: Record<string, number> = {};
      if (rawBoosters) {
        if (Array.isArray(rawBoosters)) {
          (rawBoosters as string[]).forEach(id => { availableMap[id] = 1; });
        } else if (typeof rawBoosters === 'object') {
          Object.entries(rawBoosters).forEach(([id, uses]) => {
            availableMap[id] = typeof uses === 'number' ? uses : 1;
          });
        }
      }

      // 2. This match's match_number, to compare against the contest's
      // start_match_number / playoff_start_match_number — mirrors web's
      // `mn === contest.start_match_number || mn === contest.playoff_start_match_number`.
      const { data: matchRow } = await supabase
        .from('matches')
        .select('match_number')
        .eq('id', matchId)
        .maybeSingle();
      const mn = matchRow?.match_number ?? null;
      const startMN            = contestRow?.start_match_number            ?? null;
      const playoffMN          = contestRow?.playoff_start_match_number    ?? null;
      const playoffFirstUnlim  = contestRow?.playoff_first_match_unlimited ?? false;
      // Season opener is ALWAYS unlimited (no prior baseline to diff against).
      // The first playoff match is only unlimited when playoff_first_match_unlimited
      // is explicitly set — otherwise it shares the same pooled playoff budget
      // as the rest of the playoff matches, so boosters remain meaningful there.
      const transfersUnlimited =
        (mn !== null && (mn === startMN || (mn === playoffMN && playoffFirstUnlim))) ||
        // Defensive fallback for contests with no start_match_number configured.
        (startMN === null && playoffMN === null && isFirstMatchFallback);

      // 3. Activations for this squad (all matches). A booster committed to
      // a DIFFERENT match only permanently spends its season use once THAT
      // match has locked — mirrors leaderboardStore's lockedMatchIds gating.
      // Mobile's "save is the lock" model commits to user_booster_activations
      // immediately on Save XI, well before the match's actual lock_time, so
      // the user can still go back and remove/swap it right up until lock.
      // Counting an other-match commitment as spent before that point made
      // a booster show 'used' (and un-selectable everywhere else) even
      // though the user could still free it up — this is the fix for that.
      let committedId = null as string | null;
      const usedCounts: Record<string, number> = {};
      if (squadId) {
        const { data: activations } = await supabase
          .from('user_booster_activations')
          .select('booster, match_id')
          .eq('squad_id', squadId);

        const otherMatchIds = [...new Set(
          (activations ?? [])
            .filter((row: any) => row.match_id !== matchId)
            .map((row: any) => row.match_id),
        )];

        const lockedOtherMatchIds = new Set<string>();
        if (otherMatchIds.length) {
          const { data: matchRows } = await supabase
            .from('matches')
            .select('id, lock_time, start_time, status')
            .in('id', otherMatchIds);
          (matchRows ?? []).forEach((m: any) => {
            if (isMatchLocked(m)) lockedOtherMatchIds.add(m.id);
          });
        }

        (activations ?? []).forEach((row: any) => {
          if (row.match_id === matchId) {
            committedId = row.booster;
          } else if (lockedOtherMatchIds.has(row.match_id)) {
            usedCounts[row.booster] = (usedCounts[row.booster] ?? 0) + 1;
          }
        });
      }

      // Reset the staged pick to whatever's committed whenever we (re)load
      // for a match — if the previously-loaded match differs, any in-flight
      // pick for THAT match must not leak into this one.
      const prevMatchId = get()._matchId;
      const pendingId = prevMatchId === matchId ? get()._pendingId : committedId;

      const boosters = buildBoosterList(availableMap, usedCounts, committedId, pendingId, transfersUnlimited);

      set({
        boosters,
        isUnsaved:    pendingId !== committedId,
        _contestId:   contestId,
        _squadId:     squadId,
        _matchId:     matchId,
        _committedId: committedId,
        _pendingId:   pendingId,
        _transfersUnlimited: transfersUnlimited,
      });
    } catch (err) {
      console.warn('[boosterStore] loadBoosters failed:', err);
    } finally {
      set({ loading: false });
    }
  },

  selectBooster: (id) => {
    const state = get();
    const target = state.boosters.find(b => b.id === id);
    if (!target || target.status === 'used') return;

    const newPendingId = target.status === 'active' || target.status === 'pending' ? null : id;

    set(s => ({
      _pendingId: newPendingId,
      isUnsaved:  newPendingId !== s._committedId,
      boosters:   buildBoosterList(
        Object.fromEntries(s.boosters.map(b => [b.id, b.totalUses])),
        Object.fromEntries(s.boosters.map(b => [b.id, b.usedInOther])),
        s._committedId,
        newPendingId,
        s._transfersUnlimited,
      ),
    }));
  },

  discardPending: () => {
    // Must use buildBoosterList, not a manual .map() — the manual version only
    // reset 'pending'→'available' but left boosters that were 'used' because
    // of the anotherActive flag (every non-selected booster when one is staged)
    // stuck as 'used' after the discard. buildBoosterList recomputes all
    // statuses correctly from the reverted pending === committed baseline.
    set(s => ({
      _pendingId: s._committedId,
      isUnsaved:  false,
      boosters: buildBoosterList(
        Object.fromEntries(s.boosters.map(b => [b.id, b.totalUses])),
        Object.fromEntries(s.boosters.map(b => [b.id, b.usedInOther])),
        s._committedId,
        s._committedId, // pendingId === committedId after discard
        s._transfersUnlimited,
      ),
    }));
  },

  commitPending: async (overrideSquadId, overrideMatchId) => {
    const s = get();
    const squadId = overrideSquadId ?? s._squadId;
    const matchId = overrideMatchId ?? s._matchId;
    const { _committedId: committed, _pendingId: pending, _contestId: contestId } = s;

    if (!squadId || !matchId) {
      if (pending !== committed) {
        // A staged change exists and the user expects it applied — missing
        // squadId/matchId means we genuinely cannot commit it. Fail loudly
        // instead of the old silent `return null`, which is exactly what
        // made ShooterXI's Team Double look "saved" when nothing was ever
        // written.
        throw new Error('Could not confirm your squad or match — booster was not saved. Please reopen Pick XI and try again.');
      }
      return null; // genuinely nothing staged and nothing resolvable — fine
    }
    if (pending === committed) return null; // nothing staged — nothing to commit

    try {
      if (committed) await dbDeactivate(squadId, matchId, committed);

      // Free Hit: capture the squad's pre-free-hit baseline (the team they'd
      // otherwise carry into this match) onto the activation row, so it can
      // be restored as "previous XI" for whatever match comes after this one
      // — mirrors web's intent (free_hit reverts after the match) but
      // snapshots the BASELINE, not the free-hit team itself, since that's
      // what actually needs to be restored. Best-effort: a failed snapshot
      // lookup must not block activating the booster.
      let snapshot: { playerIds: string[]; captainId: string | null; vcId: string | null } | null = null;
      if (pending === 'free_hit' && contestId) {
        try {
          const { config, tournamentId } = await fetchContestTransferConfig(contestId);
          if (tournamentId) {
            const allMatches = await fetchTournamentMatches(tournamentId);
            const prev = await getPreviousMatchXI(squadId, matchId, allMatches, config.start_match_number);
            if (prev.playerIds.length === 11) {
              snapshot = { playerIds: prev.playerIds, captainId: prev.captainId, vcId: prev.vcId };
            }
          }
        } catch (snapErr) {
          console.warn('[boosterStore] free_hit snapshot capture failed (non-fatal):', snapErr);
        }
      }

      if (pending) await dbActivate(squadId, matchId, pending, snapshot);

      // Verification read-back — confirm user_booster_activations actually
      // reflects what we just tried to commit, rather than assuming the
      // writes above landed. Belt-and-suspenders: this catches any failure
      // mode beyond the specific stale-context bug above (e.g. a dropped
      // request, an RLS policy silently filtering the insert's return, etc.)
      // and turns it into a visible error instead of a false "success".
      const { data: verifyRow } = await supabase
        .from('user_booster_activations')
        .select('booster')
        .eq('squad_id', squadId)
        .eq('match_id', matchId)
        .maybeSingle();
      const actuallyCommitted = verifyRow?.booster ?? null;
      if (actuallyCommitted !== pending) {
        throw new Error(
          `Booster commit could not be verified (expected "${pending ?? 'none'}", found "${actuallyCommitted ?? 'none'}") — please try again.`
        );
      }

      set({ _committedId: pending, isUnsaved: false, _squadId: squadId, _matchId: matchId });
      // Refresh statuses against the new committed baseline.
      set(state => ({
        boosters: state.boosters.map(b => ({
          ...b,
          status: (b.id === pending ? 'active' : (b.status === 'pending' ? 'available' : b.status)) as BoosterStatus,
        })),
      }));

      const message = pending
        ? `${getBoosterMeta(pending)?.name ?? pending} activated.`
        : `${getBoosterMeta(committed!)?.name ?? committed} removed.`;
      return { changed: true, message };
    } catch (err: any) {
      console.warn('[boosterStore] commitPending failed:', err);
      throw err;
    }
  },

  activeBoosters: () => get().boosters.filter(b => b.status === 'active'),
}));
