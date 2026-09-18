/**
 * poll-cricapi — Supabase Edge Function
 *
 * Server-side counterpart to the browser's LiveMatchPoller. Polls CricAPI for
 * every in-play match belonging to a non-scraper-enabled tournament, parses
 * batting/bowling/fielding (fielding is new — the HTML scraper has no
 * fielder data), writes player_match_stats, then cascades to:
 *   - Daily XI scores      (user_team_match_scores)   — flat captain 2x / VC 1.5x
 *   - Season Long scores   (user_match_xi_scores)      — captain/VC mult + full
 *                                                         booster + per-contest
 *                                                         custom-scoring-rules
 *                                                         support (parity with
 *                                                         the client's manual
 *                                                         Finalize/Recalc path)
 *
 * On match completion it flips matches.status to 'completed' automatically —
 * no browser tab needs to be open for any of this. The only manual step left
 * is linking a CricAPI player name that doesn't match the local roster —
 * those rows land in the existing "Unmatched Players" admin panel
 * (scraper_unmatched, tagged source='cricapi') exactly like scraper misses do.
 *
 * Triggered by:
 *   - pg_cron, interval set in migration_v25_cricapi_cron.sql (body: {})
 *       → polls every live match whose tournament has scraper_enabled = false
 *         and has a CricAPI external_id
 *   - Admin "Poll Now" button (body: {matchId})
 *       → polls one match regardless of scraper_enabled (manual override)
 *
 * Required env vars (Supabase dashboard → Edge Functions → poll-cricapi → Secrets):
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *   CRICAPI_KEYS   — one or more CricAPI keys, comma-separated.
 *                    Automatically rotates to the next key when one is
 *                    rate-limited / invalid, same fallback behaviour as the
 *                    browser's fetchJsonWithFallback().
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
// Canonical scoring math + dismissal parsing + rules resolution — see that
// file's header for the full consolidation notes. This used to be an
// independently-maintained copy (DEFAULT_RULES, calcBatting/calcBowling/
// calcFielding, parseDismissalEntry, isDismissed, deriveRole) kept "in sync
// by hand" with index.html and scrape-scorecard/index.ts, which is exactly
// how they drifted (sr_70_to_100 default, run-out dismissal-text fallback,
// contest-level rules support) without anyone deciding to change anything.
import {
  DEFAULT_RULES, MULTIPLIERS,
  calcBattingPoints, calcBowlingPoints, calcFieldingPoints,
  resolveEffectiveRules, deriveRole as deriveRoleShared,
  deriveIsDismissed, parseDismissalEntry as parseDismissalEntryShared,
  matchBowlerName as matchBowlerNameShared,
} from '../../../scoringEngine.shared.js'

const SUPABASE_URL              = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const CRICAPI_KEYS = (Deno.env.get('CRICAPI_KEYS') ?? '')
  .split(',').map(k => k.trim()).filter(Boolean)

const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

// Browser admin "Poll Now" button calls this directly, so it needs CORS.
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

// ─────────────────────────────────────────────────────────────────────────────
// Scoring engine — thin same-signature wrappers over scoringEngine.shared.js
// so every call site below (rawPoints, the XI/SL cascades) is unchanged.
// ─────────────────────────────────────────────────────────────────────────────

interface Rules { [key: string]: number }

interface BatRow { runs?: number; ballsFaced?: number; fours?: number; sixes?: number; isDismissed?: boolean }
interface BowlRow { wickets?: number; wicketTypes?: string[]; maidens?: number; runsConceded?: number; ballsBowled?: number; dotBalls?: number; noBalls?: number; wides?: number }
interface FieldRow { catches?: number; stumpings?: number; runOutDirect?: number; runOutIndirect?: number }

// These three unwrap .points from the canonical {points, breakdown} shape —
// every call site here only ever wanted the number.
function calcBatting(bat: BatRow, role: string, fmt: string, r: Rules): number {
  return calcBattingPoints({ ...bat, role }, fmt, r).points
}
function calcBowling(bowl: BowlRow, fmt: string, r: Rules): number {
  return calcBowlingPoints(bowl, fmt, r).points
}
function calcFielding(f: FieldRow, r: Rules): number {
  return calcFieldingPoints(f, r).points
}

/** Raw fantasy points (no captaincy/booster multiplier) for one player's match stats. */
function rawPoints(
  player: { role: string; batting?: BatRow | null; bowling?: BowlRow | null; fielding?: FieldRow | null },
  fmt: string,
  rules: Rules,
): number {
  let raw = 0
  if (player.batting) raw += calcBatting(player.batting, player.role, fmt, rules)
  if (player.bowling) raw += calcBowling(player.bowling, fmt, rules)
  if (player.fielding) raw += calcFielding(player.fielding, rules)
  return Math.round(raw * 10) / 10
}

function captaincyMultiplier(captaincy: 'captain' | 'vice_captain' | 'normal', booster: string | null): number {
  const key = (booster === 'triple_captain' && captaincy === 'captain') ? 'triple_captain'
    : (booster === 'dual_captain' && captaincy === 'vice_captain') ? 'captain'
      : captaincy
  return MULTIPLIERS[key] ?? 1
}
function boosterMultiplier(booster: string | null, isOverseas: boolean): number {
  if (booster === 'team_double') return 2
  if (booster === 'os_double' && isOverseas) return 2
  if (booster === 'indian_double' && !isOverseas) return 2
  return 1
}

// ─────────────────────────────────────────────────────────────────────────────
// CricAPI adapter — ported from fromCricAPI() / parseDismissalEntry() /
// matchBowlerName() / deriveRole() / matchLifecycle() in index.html.
// ─────────────────────────────────────────────────────────────────────────────

function int(v: unknown): number { return parseInt(String(v), 10) || 0 }

function deriveRole(s = ''): string {
  return deriveRoleShared(s)
}

interface DismissalParse { type: string; bowler: string | null; fielder: string | null; fielder2?: string | null }

// THE FIX for the run-out gap: this used to check only the short `d` code
// (never dText) for run-outs, which happened to never bite CricAPI directly
// (it reliably populates the short code for genuine dismissals) but was the
// same latent shape as the browser's isDismissed bug. Delegating closes it.
function parseDismissalEntry(b: any): DismissalParse | null {
  return parseDismissalEntryShared(b)
}

function matchBowlerName(dismissalRef: string | null, candidates: string[]): string | null {
  return matchBowlerNameShared(dismissalRef, candidates).name
}

interface ApiPlayer { id: string; name: string; role: string; batting?: BatRow; bowling?: BowlRow; fielding?: FieldRow }
interface FieldingEvent {
  rawName: string
  field: 'catches' | 'stumpings' | 'runOutDirect' | 'runOutIndirect'
  batterName: string
  dismissalText: string
}

/**
 * Parses a CricAPI match_scorecard payload into per-player batting/bowling
 * rows, plus a separate list of raw fielding-credit events. Fielding is
 * deliberately NOT resolved to a player here — this function has no roster
 * access, so it used to guess via a bare name .find() against whoever else
 * had already batted/bowled in this same payload (missing fielders who never
 * batted/bowled, and with zero ambiguity detection for shared surnames). The
 * caller resolves fieldingEvents against the real match roster using the
 * same tiered/ambiguity-aware resolveFielderName used for the scraper
 * pipeline, and can create a credit-only entry for a fielder who never
 * batted/bowled — same standard as scrape-scorecard's fielding handling.
 */
function fromCricAPI(payload: any): { players: ApiPlayer[]; fieldingEvents: FieldingEvent[] } {
  const sc = payload?.data?.scorecard ?? payload?.scorecard ?? []
  const players: ApiPlayer[] = []
  const ensure = (key: string, name: string) => {
    let p = players.find(x => x.id === key)
    if (!p) { p = { id: key, name, role: 'bat' }; players.push(p) }
    return p
  }

  const fieldingEvents: FieldingEvent[] = []
  const addFielding = (rawName: string | null | undefined, field: FieldingEvent['field'], batterName: string, dismissalText: string) => {
    if (!rawName) return
    fieldingEvents.push({ rawName: rawName.trim(), field, batterName, dismissalText })
  }

  for (const inn of sc) {
    const bowlerArr = inn.bowling || inn.bowlers || inn.bowl || []
    const bowlerNames = bowlerArr.map((b: any) => b.bowler?.name ?? b.player?.name ?? b.name ?? '').filter(Boolean)
    const wicketsByBowler: Record<string, string[]> = {}
    const battingRows = (inn.batting || []).map((b: any) => (b.batter ? { ...b, batsman: b.batter } : b))

    for (const b of battingRows) {
      const parsed = parseDismissalEntry(b)
      if (!parsed) continue
      const fullName = matchBowlerName(parsed.bowler, bowlerNames) || parsed.bowler
      if (fullName) (wicketsByBowler[fullName] = wicketsByBowler[fullName] || []).push(parsed.type)
      const batterObj = b.batter ?? b.batsman ?? b.player ?? null
      const batterName = batterObj?.name ?? b.name ?? ''
      const dismissalText = String(b?.['dismissal-text'] ?? b?.dismissal ?? '').trim()
      if (parsed.type === 'caught')  addFielding(parsed.fielder, 'catches', batterName, dismissalText)
      if (parsed.type === 'stumped') addFielding(parsed.fielder, 'stumpings', batterName, dismissalText)
      if (parsed.type === 'run_out') {
        if (parsed.fielder && parsed.fielder2) {
          // Two fielders named — the scorecard notation doesn't reliably
          // tell you who threw vs who broke the stumps, so credit both as
          // assists instead of arbitrarily treating whichever name is
          // listed first as the "direct" hit.
          addFielding(parsed.fielder, 'runOutIndirect', batterName, dismissalText)
          addFielding(parsed.fielder2, 'runOutIndirect', batterName, dismissalText)
        } else {
          // Exactly one fielder named — a clean, solo direct hit.
          addFielding(parsed.fielder ?? parsed.fielder2, 'runOutDirect', batterName, dismissalText)
        }
      }
    }

    for (const b of (inn.batting || [])) {
      const batterObj = b.batter ?? b.batsman ?? b.player ?? null
      const name = batterObj?.name ?? b.name ?? ''
      if (!name) continue
      const id = String(batterObj?.pid ?? b.pid ?? name)
      const e = ensure(id, name)
      e.role = deriveRole(batterObj?.playing_role ?? batterObj?.role ?? '')
      e.batting = {
        runs: int(b.r), ballsFaced: int(b.b), fours: int(b['4s']), sixes: int(b['6s']),
        isDismissed: deriveIsDismissed(b),
      }
    }

    for (const bw of bowlerArr) {
      const name = bw.bowler?.name ?? bw.player?.name ?? bw.name ?? ''
      if (!name) continue
      const id = String(bw.bowler?.pid ?? bw.player?.pid ?? bw.pid ?? name)
      const e = ensure(id, name)
      const [o, bb] = String(bw.o ?? 0).split('.')
      const totalBalls = int(o) * 6 + int(bb || 0)
      e.role = 'bowl'
      e.bowling = {
        wickets: int(bw.w), wicketTypes: wicketsByBowler[name] || [], maidens: int(bw.m),
        runsConceded: int(bw.r), ballsBowled: totalBalls, dotBalls: int(bw.dots ?? 0),
        noBalls: int(bw.nb ?? 0), wides: int(bw.wd ?? 0),
      }
    }
  }

  for (const p of players) { if (p.batting && p.bowling) p.role = 'ar' }
  return { players, fieldingEvents }
}

// ─── Completion corroboration ───────────────────────────────────────────────
// CricAPI's matchEnded flag (and vaguer status wording) has been observed to
// flip/appear before the match has actually finished — the scorecard array
// itself still shows the chasing side mid-innings (wickets in hand, overs
// remaining). This is exactly the shape of the false-positive seen with NZ
// Women vs Scotland Women (19th Match): matchEnded/status implied completion
// while the scorecard still showed New Zealand batting.
//
// Treat the completion signal as authoritative outright only when it's an
// EXPLICIT result sentence ("X won by Y wickets/runs", "Match Tied", "No
// Result", "Match Abandoned", "Match Drawn") — CricAPI only writes one of
// those once it actually has a definitive outcome. Anything weaker (the bare
// matchEnded boolean, or vaguer "match ended/completed" / bare "result"
// wording with no result sentence attached) gets corroborated against the
// last innings's own wickets/overs numbers before being trusted; if the
// scorecard doesn't back it up, the match is treated as still live instead
// of being marked completed on a possibly-wrong flag.
const FORMAT_MAX_OVERS: Record<string, number> = { T20: 20, ODI: 50 }

function lastInningsLooksDone(data: any, formatKey: string): boolean {
  const innings = data.scorecard ?? data.innings ?? data.scores ?? null
  if (!Array.isArray(innings) || !innings.length) return false
  const last: any = innings[innings.length - 1]

  const wkts = Number(last?.w ?? last?.wickets ?? NaN)
  if (!Number.isNaN(wkts)) {
    if (wkts >= 10) return true
  } else {
    // No innings-level wicket count on this payload shape — fall back to
    // counting actual dismissals in the innings' own batting rows.
    const battingRows: any[] = last?.batting ?? []
    const dismissed = battingRows.filter((b: any) =>
      !!b?.dismissal && !String(b.dismissal ?? '').toLowerCase().includes('not out'),
    ).length
    if (dismissed >= 10) return true
  }

  const maxOvers = FORMAT_MAX_OVERS[formatKey]
  const overs = Number(last?.o ?? last?.overs ?? NaN)
  // Tolerance for the last legal ball rounding (e.g. 19.6 / 49.6 overs).
  if (maxOvers != null && !Number.isNaN(overs) && overs >= maxOvers - 0.05) return true

  return false
}

function matchLifecycle(payload: any, formatKey = 'T20'): 'completed' | 'live' | 'upcoming' | 'unknown' {
  const data = payload?.data ?? payload ?? {}
  const status = String(data.status || payload?.status || '').toLowerCase()

  // Strong signal — explicit, definitive result sentence. Trust outright.
  if (/won by|\btied\b|no result|abandoned|\bdrawn\b/.test(status)) return 'completed'

  // Weak signal — needs corroboration from the scorecard itself.
  const weakCompletionSignal = data.matchEnded === true || /match (ended|completed)|result/i.test(status)
  if (weakCompletionSignal) {
    return lastInningsLooksDone(data, formatKey) ? 'completed' : 'live'
  }

  if (data.matchStarted === true) return 'live'
  if (/match started|in progress|innings break|live|stumps|tea|lunch|drinks|day [123456789]/i.test(status)) return 'live'
  if (/toss/i.test(status)) return 'live'
  const innings = data.scorecard ?? data.innings ?? data.scores ?? null
  if (Array.isArray(innings) && innings.length > 0) return 'live'
  if (/innings|over|wicket/i.test(status)) return 'live'
  if (/match not started|scheduled|fixture|upcoming/i.test(status)) return 'upcoming'
  if (!status) return 'unknown'
  return 'unknown'
}

// ─────────────────────────────────────────────────────────────────────────────
// Name resolution — identical algorithm to scrape-scorecard's resolvePlayerName,
// reused here against a CricAPI-scoped (source='cricapi') alias table so the
// two pipelines don't collide on the same alias row.
// ─────────────────────────────────────────────────────────────────────────────

interface ResolveResult { playerId: string | null; method: 'exact' | 'alias' | 'fuzzy' | 'unmatched' }

// CricAPI sometimes sends a literal placeholder instead of a real name when
// ITS OWN database can't identify someone (sub fielder, very new/uncapped
// player, scorecard glitch). The same literal string recurs for different
// actual players across different matches, so it can never be aliased to one
// specific local player — that's exactly how "Player Not Found" ended up
// permanently (and wrongly) aliased to a real player in player_name_aliases.
// Skip these entirely: never fuzzy-alias them, never queue them in
// scraper_unmatched (where an admin could "Map" them to a player by mistake).
const PLACEHOLDER_NAMES = new Set(['player not found'])
function isPlaceholderName(name: string): boolean {
  const norm = name.toLowerCase().trim()
  // "empty" is a broader/prefix check (not an exact-set entry) because this
  // source sends variants like "empty &" rather than one fixed literal.
  return PLACEHOLDER_NAMES.has(norm) || norm.startsWith('empty')
}

// Last-name / initials fuzzy tier — returns EVERY roster player_id that
// plausibly matches, not just the first one found, so resolvePlayerName can
// tell a genuinely unambiguous fuzzy match apart from one where two
// roster-mates (e.g. same-surname teammates) could both be it.
function fuzzyMatchCandidates(norm: string, exactMap: Map<string, string>): string[] {
  const lastName = norm.split(' ').pop()!
  const lastNameHits = new Set<string>()
  for (const [pName, pId] of exactMap) {
    if (pName.split(' ').pop() === lastName) lastNameHits.add(pId)
  }
  if (lastNameHits.size) return [...lastNameHits]

  const parts = norm.split(' ')
  if (parts.length === 2 && parts[0].length === 1) {
    const initial = parts[0]
    const lastName2 = parts[1]
    const initialHits = new Set<string>()
    for (const [pName, pId] of exactMap) {
      const pParts = pName.split(' ')
      if (pParts.length >= 2 && pParts[0].startsWith(initial) && pParts[pParts.length - 1] === lastName2) {
        initialHits.add(pId)
      }
    }
    if (initialHits.size) return [...initialHits]
  }
  return []
}

function resolvePlayerName(name: string, exactMap: Map<string, string>, aliasMap: Map<string, string>): ResolveResult {
  const norm = name.toLowerCase().trim()
  if (exactMap.has(norm)) return { playerId: exactMap.get(norm)!, method: 'exact' }

  // Check for ambiguity BEFORE trusting a saved alias — see scrape-scorecard's
  // resolvePlayerName for the full reasoning. A saved alias was only ever
  // verified once; if the raw text could currently match more than one
  // rostered player, don't blindly trust the old alias.
  const candidates = fuzzyMatchCandidates(norm, exactMap)
  if (candidates.length > 1) return { playerId: null, method: 'unmatched' }

  if (aliasMap.has(norm)) return { playerId: aliasMap.get(norm)!, method: 'alias' }
  if (candidates.length === 1) return { playerId: candidates[0], method: 'fuzzy' }

  return { playerId: null, method: 'unmatched' }
}

interface FielderResolveResult { playerId: string | null; candidates: string[] | null }

/**
 * Resolve a raw fielder-credit name (e.g. "A Fletcher") to exactly one
 * player_id, checked against the full roster of BOTH teams playing this
 * match — not just whoever batted/bowled in this match — so that two squad
 * members sharing a surname (e.g. sisters) are correctly flagged as
 * ambiguous instead of one of them silently absorbing the other's fielding
 * credit. Identical algorithm to scrape-scorecard's resolveFielderName (the
 * "Bryce sisters" fix) — poll-cricapi's fielding matching used to be a bare
 * .find() against players already resolved from batting/bowling, with no
 * ambiguity detection and no way to credit a fielder who never batted/bowled.
 *
 * Tiers, in order: exact full-name match → roster name ends with " <norm>"
 * (raw is a surname or "Initial Surname") → norm ends with " <roster surname>"
 * (raw has a longer/different first name than the roster entry). Ambiguity is
 * checked within EACH tier before falling through to the next.
 */
function resolveFielderName(
  raw: string,
  exactMap: Map<string, string>,  // norm full name → player_id (both teams in this match)
  aliasMap: Map<string, string>,  // norm alias → player_id
): FielderResolveResult {
  const norm = raw.toLowerCase().trim()
  if (exactMap.has(norm)) return { playerId: exactMap.get(norm)!, candidates: null }

  const rosterNames = [...exactMap.keys()]
  const tiers = [
    rosterNames.filter(n => n === norm),
    rosterNames.filter(n => n.endsWith(' ' + norm)),
    rosterNames.filter(n => norm.endsWith(' ' + n.split(' ').pop())),
  ]
  for (const tier of tiers) {
    if (!tier.length) continue
    const distinct = [...new Set(tier)]
    // A saved alias only ever verified the match once — if the current
    // roster now has more than one name in this tier, don't let a stale
    // alias silently pick one. Surface it as ambiguous instead.
    if (distinct.length > 1) return { playerId: null, candidates: distinct }
    if (aliasMap.has(norm)) return { playerId: aliasMap.get(norm)!, candidates: null }
    return { playerId: exactMap.get(distinct[0])!, candidates: null }
  }

  // No fuzzy tier matched at all — fall back to a saved alias if we have one
  // (covers names that don't cleanly fuzzy-match syntactically).
  if (aliasMap.has(norm)) return { playerId: aliasMap.get(norm)!, candidates: null }

  return { playerId: null, candidates: null }
}

// ─────────────────────────────────────────────────────────────────────────────
// CricAPI fetch with multi-key rotation (server-side equivalent of the
// browser's fetchJsonWithFallback / getApiKeys / isKeyExhaustedError).
// ─────────────────────────────────────────────────────────────────────────────

function isKeyExhaustedError(msg: string): boolean {
  // Some CricAPI quota/auth failures don't come back as a clean HTTP error —
  // a key that's hit its daily cap can get its connection reset at the LB
  // before a JSON error is ever produced. Treat connection-level failures
  // the same as a recognized quota error so rotation still kicks in and
  // tries the next configured key instead of giving up on the first one.
  return /blocked|daily.limit|quota|too.many|429|invalid.*key|unauthori[sz]|connection reset|econnreset|client error \(connect\)|timed? ?out/i.test(String(msg))
}

async function fetchScorecard(externalId: string): Promise<any> {
  if (!CRICAPI_KEYS.length) throw new Error('No CRICAPI_KEYS configured (set the Edge Function secret)')
  let lastErr: Error | null = null
  for (const key of CRICAPI_KEYS) {
    try {
      // CricAPI (or a WAF in front of it) appears to reset bare server-to-server
      // requests with no User-Agent/Accept headers — confirmed the same key/id
      // works fine from a regular browser but gets "Connection reset by peer"
      // from this Edge Function. Send browser-like headers to rule that out
      // before assuming it's a hard IP-range block on Supabase's egress.
      const res = await fetch(`https://api.cricapi.com/v1/match_scorecard?apikey=${encodeURIComponent(key)}&id=${encodeURIComponent(externalId)}`, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          'Accept': 'application/json, text/plain, */*',
        },
      })
      const json = await res.json().catch(() => null)
      if (!res.ok) {
        const msg = json?.message || `HTTP ${res.status}`
        if (isKeyExhaustedError(msg)) { lastErr = new Error(msg); continue }
        throw new Error(msg)
      }
      // CricAPI returns HTTP 200 with status:'failure' for quota/auth errors.
      if (json?.status === 'failure') {
        const msg = json?.message || 'CricAPI request failed'
        if (isKeyExhaustedError(msg)) { lastErr = new Error(msg); continue }
        throw new Error(msg)
      }
      return json
    } catch (e) {
      lastErr = e as Error
      if (!isKeyExhaustedError((e as Error).message)) throw e
    }
  }
  throw lastErr ?? new Error('All CricAPI keys exhausted')
}

// ─────────────────────────────────────────────────────────────────────────────
// Daily XI (ad-hoc one-off teams) scoring — identical to scrape-scorecard's
// scoreDailyTeamsForMatch. No booster/custom-rules concept exists for Daily.
// ─────────────────────────────────────────────────────────────────────────────

async function scoreDailyTeamsForMatch(matchId: string, pointsMap: Map<string, number>): Promise<number> {
  const { data: teams, error } = await sb
    .from('user_teams')
    .select('id, captain_id, vice_captain_id, user_team_players(player_id)')
    .eq('match_id', matchId)
    .is('squad_id', null)
  if (error || !teams?.length) return 0

  const scoreRows = teams.map((t: any) => {
    const playerIds = (t.user_team_players ?? []).map((p: any) => p.player_id)
    let total = 0
    for (const pid of playerIds) {
      const raw  = pointsMap.get(pid) ?? 0
      const mult = pid === t.captain_id ? 2 : pid === t.vice_captain_id ? 1.5 : 1
      total += raw * mult
    }
    return { user_team_id: t.id, match_id: matchId, total_points: Math.round(total * 10) / 10, computed_at: new Date().toISOString() }
  })

  const CHUNK = 100
  for (let i = 0; i < scoreRows.length; i += CHUNK) {
    await sb.from('user_team_match_scores').upsert(scoreRows.slice(i, i + CHUNK), { onConflict: 'user_team_id,match_id' })
  }
  return scoreRows.length
}

// ─────────────────────────────────────────────────────────────────────────────
// Season Long XI scoring — full parity with the client's
// computeAndSaveSLScoresForMatch(): captain/VC multiplier, booster
// multiplier (team_double / os_double / indian_double / triple_captain /
// dual_captain), and per-contest custom scoring_rules re-scoring.
// ─────────────────────────────────────────────────────────────────────────────

interface PlayerStat { batting?: BatRow | null; bowling?: BowlRow | null; fielding?: FieldRow | null; raw_points: number }
interface PlayerMeta { role: string; is_overseas: boolean }

async function scoreSLForMatch(
  matchId: string,
  fmt: string,
  statsByPlayer: Map<string, PlayerStat>,
  metaByPlayer: Map<string, PlayerMeta>,
  dotBallEnabled: boolean,
): Promise<number> {
  const { data: xiRows, error } = await sb
    .from('user_match_xi')
    .select('squad_id, player_id, is_captain, is_vc')
    .eq('match_id', matchId)
  if (error || !xiRows?.length) return 0

  const grouped = new Map<string, any[]>()
  for (const row of xiRows) {
    if (!grouped.has(row.squad_id)) grouped.set(row.squad_id, [])
    grouped.get(row.squad_id)!.push(row)
  }
  const squadIds = Array.from(grouped.keys())

  // Boosters for every squad in this match — one query (avoids RLS issues
  // scoring other users' squads, mirrors getAllBoostersForMatch).
  const { data: boosterRows } = await sb
    .from('user_booster_activations')
    .select('squad_id, booster')
    .eq('match_id', matchId)
  const boosterMap = new Map<string, string>()
  for (const b of boosterRows ?? []) boosterMap.set(b.squad_id, b.booster)

  // Contest → custom scoring rules, resolved per squad.
  const { data: squadRows } = await sb.from('user_squads').select('id, contest_id').in('id', squadIds)
  const contestIdBySquad = new Map<string, string>()
  for (const s of squadRows ?? []) if (s.contest_id) contestIdBySquad.set(s.id, s.contest_id)

  const contestIds = Array.from(new Set(contestIdBySquad.values()))
  const customRulesByContest = new Map<string, Rules | null>()
  if (contestIds.length) {
    const { data: contests } = await sb.from('contests').select('id, scoring_rules').in('id', contestIds)
    for (const c of contests ?? []) {
      const custom = c.scoring_rules?.[fmt]
      const merged = custom ? { ...DEFAULT_RULES[fmt], ...custom } : null
      // Same tournament-level dot_ball_enabled gate as the Daily/default path —
      // a contest's own custom scoring_rules shouldn't be able to bypass it.
      if (merged && !dotBallEnabled) merged.dot_ball = 0
      customRulesByContest.set(c.id, merged)
    }
  }

  let totalSaved = 0
  for (const [squadId, rows] of grouped) {
    const booster     = boosterMap.get(squadId) ?? null
    const contestId    = contestIdBySquad.get(squadId)
    const customRules = contestId ? (customRulesByContest.get(contestId) ?? null) : null

    const scoreRows = rows.map((r: any) => {
      const s    = statsByPlayer.get(r.player_id)
      const meta = metaByPlayer.get(r.player_id)
      const isOverseas = meta?.is_overseas ?? false

      const raw = (customRules && s)
        ? rawPoints({ role: meta?.role ?? 'bat', batting: s.batting, bowling: s.bowling, fielding: s.fielding }, fmt, customRules)
        : Number(s?.raw_points ?? 0)

      const captaincy: 'captain' | 'vice_captain' | 'normal' = r.is_captain ? 'captain' : r.is_vc ? 'vice_captain' : 'normal'
      const mult = captaincyMultiplier(captaincy, booster) * boosterMultiplier(booster, isOverseas)

      return {
        squad_id: squadId, match_id: matchId, player_id: r.player_id,
        base_points: raw, multiplier: mult, total_points: Math.round(raw * mult * 10) / 10,
        computed_at: new Date().toISOString(),
      }
    })

    const { error: upErr } = await sb.from('user_match_xi_scores')
      .upsert(scoreRows, { onConflict: 'squad_id,match_id,player_id' })
    if (!upErr) totalSaved += scoreRows.length
  }
  return totalSaved
}

// ─────────────────────────────────────────────────────────────────────────────
// Main handler
// ─────────────────────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS })

  try {
    const body     = await req.json().catch(() => ({})) as { matchId?: string }
    const matchId  = body.matchId ?? null
    const nowDate  = new Date()
    const now      = nowDate.toISOString()

    // Cron calls only consider matches whose start_time is at least 30
    // minutes in the past — the scraper (running every 15 min, gated to
    // start_time+5min) owns the early part of the match; CricAPI joins in
    // as the slower cross-check once things have settled. Manual "Poll Now"
    // (matchId provided) is unaffected — the admin is explicitly asking
    // right now, regardless of how recently the match started.
    const cutoff = matchId ? now : new Date(nowDate.getTime() - 30 * 60 * 1000).toISOString()

    let query = sb
      .from('matches')
      .select(`
        id, match_number, format, status, external_id, tournament_id, start_time, data_source,
        progress_innings, progress_balls, home_team_id, away_team_id,
        tournament:tournaments!tournament_id(id, name, scraper_enabled, scoring_rules, dot_ball_enabled)
      `)
      .lte('start_time', cutoff)
      .not('status', 'in', '("completed","delayed")')
      .not('external_id', 'is', null)

    if (matchId) query = query.eq('id', matchId)

    // No DB-level scraper_enabled filter here — eligibility now also depends on
    // matches.data_source (a per-match override), which can't be expressed as a
    // single PostgREST filter alongside the joined tournament flag. Filtered in
    // JS below instead, same defensive pattern this code already used before
    // data_source existed.
    const { data: matches, error: mErr } = await query
    if (mErr) throw mErr

    // Manual poll (matchId provided) bypasses all source gating — the admin is
    // explicitly asking to poll this match via CricAPI regardless of its
    // tournament default or its own data_source override.
    //
    // Otherwise (cron call): data_source='cricapi' forces this match onto
    // CricAPI even if its tournament defaults to the scraper; data_source=
    // 'scraper' forces it away from CricAPI even if the tournament defaults
    // here; data_source='auto' (or unset) falls back to the tournament-wide
    // scraper_enabled flag, same behaviour as before this override existed.
    const liveMatches = (matches ?? []).filter((m: any) => {
      if (matchId) return true
      const src = m.data_source || 'auto'
      if (src === 'scraper') return false
      if (src === 'cricapi') return true
      return m.tournament?.scraper_enabled === false
    })

    if (!liveMatches.length) {
      return new Response(
        JSON.stringify({ ok: true, message: 'No live CricAPI matches to poll' }),
        { status: 200, headers: { ...CORS, 'Content-Type': 'application/json' } },
      )
    }

    const results = []

    for (const match of liveMatches as any[]) {
      const tournament = match.tournament
      const fmtKey      = (match.format ?? 'T20').toUpperCase()
      // Tournament-level rules — this is the base raw_points figure used for
      // player_match_stats and Daily XI (which never get per-contest
      // overrides). The per-contest override for Season Long squads is
      // resolved separately, per-squad, in the SL cascade below.
      const rules: Rules = resolveEffectiveRules(tournament, null, fmtKey)

      // ── 1. Fetch from CricAPI ────────────────────────────────────────────
      let payload: any
      try {
        payload = await fetchScorecard(match.external_id)
      } catch (e) {
        results.push({ matchId: match.id, status: 'fetch_failed', error: (e as Error).message })
        continue
      }

      // Cache the raw payload — survives even if this run fails downstream,
      // and lets an admin re-finalize from cache later without re-fetching.
      await sb.from('match_scorecards').upsert(
        { match_id: match.id, payload, fetched_at: new Date().toISOString() },
        { onConflict: 'match_id' },
      )

      const stage = matchLifecycle(payload, fmtKey)

      if (stage === 'upcoming') {
        results.push({ matchId: match.id, status: 'upcoming' })
        continue
      }

      // ── 1b. Staleness guard ───────────────────────────────────────────
      // Mirrors scrape-scorecard's guard: compare this read's progress
      // against the furthest progress seen so far for this match (across
      // either source). If this read is BEHIND that, it's almost certainly
      // a stale/cached payload — skip the write (including the status
      // flip below) entirely rather than regressing good data.
      const dataForProgress = (payload as any)?.data ?? payload ?? {}
      const inningsArr: any[] = dataForProgress.scorecard ?? dataForProgress.innings ?? dataForProgress.scores ?? []
      const lastInnEntry = Array.isArray(inningsArr) ? inningsArr[inningsArr.length - 1] : null
      const lastOvers = Number(lastInnEntry?.o ?? 0) || 0
      const newProgress    = { innings: Array.isArray(inningsArr) ? inningsArr.length : 0, balls: Math.floor(lastOvers) * 6 + Math.round((lastOvers % 1) * 10) }
      const storedProgress = { innings: (match as any).progress_innings ?? 0, balls: (match as any).progress_balls ?? 0 }
      const isStale = newProgress.innings < storedProgress.innings
        || (newProgress.innings === storedProgress.innings && newProgress.balls < storedProgress.balls)

      if (isStale) {
        results.push({ matchId: match.id, status: 'stale_skipped', stage, read: newProgress, stored: storedProgress })
        continue
      }

      // ── 2. Build name-resolution maps, scoped to ONLY the two teams ───────
      // playing this match — not the whole tournament roster. A name in this
      // match's scorecard can only ever be one of these ~22 players; matching
      // against the full tournament roster let a name from one team's box
      // score fuzzy/alias-match a same-surname player on a team that isn't
      // even in this match.
      const matchTeamIds = [(match as any).home_team_id, (match as any).away_team_id].filter(Boolean)

      const { data: tPlayers } = await sb
        .from('tournament_players')
        .select('player_id, team_id, players(id, name, role, is_overseas)')
        .eq('tournament_id', match.tournament_id)
        .in('team_id', matchTeamIds)

      const rosterPlayerIds = (tPlayers ?? []).map(tp => tp.player_id)

      const { data: aliasRows } = await sb
        .from('player_name_aliases')
        .select('alias, player_id')
        .eq('tournament_id', match.tournament_id)
        .eq('source', 'cricapi')
        .in('player_id', rosterPlayerIds.length ? rosterPlayerIds : ['__none__'])

      const exactMap = new Map<string, string>()
      const metaByPlayer = new Map<string, PlayerMeta>()
      for (const tp of tPlayers ?? []) {
        const p = (tp as any).players
        if (!p) continue
        exactMap.set(p.name.toLowerCase().trim(), tp.player_id)
        metaByPlayer.set(tp.player_id, { role: p.role ?? 'bat', is_overseas: !!p.is_overseas })
      }
      const aliasMap = new Map<string, string>()
      for (const a of aliasRows ?? []) aliasMap.set(a.alias.toLowerCase().trim(), a.player_id)

      // ── 3. Parse CricAPI scorecard ─────────────────────────────────────
      const { players: apiPlayers, fieldingEvents } = fromCricAPI(payload)
      if (!apiPlayers.length) {
        results.push({ matchId: match.id, status: 'no_player_rows', stage })
        continue
      }

      // ── 4. Resolve names → score → dedupe by local player id ───────────
      const statsByPlayer = new Map<string, PlayerStat>()
      const unmatched: Array<{ name: string; context: 'batting' | 'bowling' }> = []
      const fuzzyAliases: Array<{ player_id: string; alias: string }> = []
      // Placeholder rows ("Player Not Found") never get aliased or queued in
      // scraper_unmatched — see isPlaceholderName. But their points shouldn't
      // just vanish either: capture the raw numbers here so an admin can
      // later force-credit this one match/row to the right player via
      // scraper_placeholder_stats, without ever creating a sticky alias.
      const placeholderRows: Array<{ context: 'batting' | 'bowling'; raw_stats: PlayerStat }> = []

      for (const pl of apiPlayers) {
        if (isPlaceholderName(pl.name)) {
          const raw = rawPoints({ role: pl.role, batting: pl.batting, bowling: pl.bowling, fielding: pl.fielding }, fmtKey, rules)
          placeholderRows.push({
            context: pl.bowling ? 'bowling' : 'batting',
            raw_stats: { batting: pl.batting ?? null, bowling: pl.bowling ?? null, fielding: pl.fielding ?? null, raw_points: raw },
          })
          continue
        }
        const { playerId, method } = resolvePlayerName(pl.name, exactMap, aliasMap)
        if (!playerId) {
          unmatched.push({ name: pl.name, context: pl.bowling ? 'bowling' : 'batting' })
          continue
        }
        if (method === 'fuzzy') fuzzyAliases.push({ player_id: playerId, alias: pl.name.toLowerCase().trim() })
        if (statsByPlayer.has(playerId)) continue // dedupe — two API names resolved to the same local player

        const meta = metaByPlayer.get(playerId)
        const localRole = meta?.role ?? pl.role // local DB role is authoritative for the duck-penalty exemption
        const raw = rawPoints({ role: localRole, batting: pl.batting, bowling: pl.bowling, fielding: pl.fielding }, fmtKey, rules)

        statsByPlayer.set(playerId, {
          batting: pl.batting ?? null, bowling: pl.bowling ?? null, fielding: pl.fielding ?? null,
          raw_points: raw,
        })
      }

      // ── 4b. Resolve fielding credit against the full 2-team match roster ──
      // (not just whoever batted/bowled) so a fielder who never got a
      // batting/bowling line still gets credited, and so two same-surname
      // roster-mates are flagged as ambiguous instead of one silently
      // absorbing the other's catch/stumping/run-out credit. Mirrors
      // scrape-scorecard's resolveFielderName handling exactly.
      const fieldingByPlayer = new Map<string, FieldRow>()
      const fieldingIssues: Array<{
        rawName: string; candidates: string[] | null
        field: 'catches' | 'stumpings' | 'runOutDirect' | 'runOutIndirect'
        batterName: string; dismissalText: string
      }> = []
      for (const ev of fieldingEvents) {
        const { playerId, candidates } = resolveFielderName(ev.rawName, exactMap, aliasMap)
        if (playerId) {
          const cur = fieldingByPlayer.get(playerId) ?? { catches: 0, stumpings: 0, runOutDirect: 0, runOutIndirect: 0 }
          cur[ev.field]++
          fieldingByPlayer.set(playerId, cur)
        } else {
          fieldingIssues.push({ rawName: ev.rawName, candidates, field: ev.field, batterName: ev.batterName, dismissalText: ev.dismissalText })
        }
      }
      // A fielder might be credit-only (never batted/bowled themselves) —
      // ensure they still get a statsByPlayer entry rather than being
      // silently dropped.
      for (const [playerId, fielding] of fieldingByPlayer) {
        const fieldingPts = calcFielding(fielding, rules)
        const existing = statsByPlayer.get(playerId)
        if (existing) {
          existing.fielding = fielding
          existing.raw_points = Math.round((existing.raw_points + fieldingPts) * 10) / 10
        } else {
          statsByPlayer.set(playerId, { batting: null, bowling: null, fielding, raw_points: fieldingPts })
        }
      }

      // ── 5. Upsert player_match_stats ────────────────────────────────────
      const statRows = Array.from(statsByPlayer.entries()).map(([playerId, s]) => ({
        match_id: match.id, player_id: playerId,
        batting: s.batting, bowling: s.bowling, fielding: s.fielding,
        raw_points: s.raw_points, source: 'cricapi',
      }))
      if (statRows.length) {
        const CHUNK = 50
        for (let i = 0; i < statRows.length; i += CHUNK) {
          const { error: uErr } = await sb.from('player_match_stats')
            .upsert(statRows.slice(i, i + CHUNK), { onConflict: 'match_id,player_id' })
          if (uErr) throw uErr
        }
      }

      // ── 6. Persist fuzzy aliases + unmatched names (source='cricapi') ──
      if (fuzzyAliases.length) {
        await sb.from('player_name_aliases').upsert(
          fuzzyAliases.map(a => ({ player_id: a.player_id, tournament_id: match.tournament_id, alias: a.alias, source: 'cricapi' })),
          { onConflict: 'alias,source,tournament_id', ignoreDuplicates: true },
        )
      }
      // See scrape-scorecard/index.ts step 9 for why this needs a reopen
      // pass: the (tournament_id, raw_name, source) key has no match_id, so
      // ignoreDuplicates alone silently no-ops once a raw name has ever been
      // resolved for this tournament+source — even when it fails to resolve
      // again later for a different match. Insert-if-new, then reopen any
      // existing row that's already resolved (leaving still-pending rows
      // untouched, so a chronic miss doesn't spam a new row per match).
      if (unmatched.length) {
        const { error: umErr } = await sb.from('scraper_unmatched').upsert(
          unmatched.map(u => ({ tournament_id: match.tournament_id, match_id: match.id, raw_name: u.name, source: 'cricapi', context: u.context })),
          { onConflict: 'tournament_id,raw_name,source', ignoreDuplicates: true },
        )
        if (umErr) console.error(`[${match.id}] scraper_unmatched upsert failed:`, umErr.message)

        for (const u of unmatched) {
          const { error: reopenErr } = await sb.from('scraper_unmatched')
            .update({ match_id: match.id, context: u.context, resolved_at: null, resolved_by: null })
            .eq('tournament_id', match.tournament_id)
            .eq('source', 'cricapi')
            .eq('raw_name', u.name)
            .not('resolved_at', 'is', null)
          if (reopenErr) console.error(`[${match.id}] scraper_unmatched reopen failed for "${u.name}":`, reopenErr.message)
        }
      }
      // Placeholder rows are keyed per match+context (not per tournament like
      // scraper_unmatched above) — every match's "Player Not Found" needs its
      // own resolution, it's never auto-resolved by a prior match's fix. Don't
      // overwrite resolved_at/resolved_by/credited_player_id on repeat polls —
      // only raw_stats refreshes (the match may still be live).
      if (placeholderRows.length) {
        await sb.from('scraper_placeholder_stats').upsert(
          placeholderRows.map(r => ({
            tournament_id: match.tournament_id, match_id: match.id,
            source: 'cricapi', context: r.context, raw_stats: r.raw_stats,
          })),
          { onConflict: 'match_id,source,context' },
        )
      }
      // Fielding credit that couldn't be resolved to exactly one player
      // (unmatched, or ambiguous — e.g. two roster-mates sharing a surname).
      // Same table/shape as the scraper pipeline; ignoreDuplicates so a row
      // an admin already resolved doesn't get reset back to unresolved by a
      // later re-poll that reproduces the same unresolved dismissal.
      if (fieldingIssues.length) {
        await sb.from('scraper_fielding_issues').upsert(
          fieldingIssues.map(fi => ({
            tournament_id : match.tournament_id,
            match_id      : match.id,
            raw_name      : fi.rawName,
            source        : 'cricapi',
            field         : fi.field,
            batter_name   : fi.batterName,
            dismissal_text: fi.dismissalText,
            candidates    : fi.candidates,
          })),
          { onConflict: 'match_id,raw_name,field,batter_name', ignoreDuplicates: true },
        )
      }
      // Flag any bowler on 3+ wickets this innings for Review → 🎩 Potential
      // Hat-tricks — none of our sources report ball-by-ball sequencing, so
      // this is only ever a candidate for an admin to confirm/decline after
      // checking the real scorecard. Same idempotent-upsert shape as
      // scraper_fielding_issues just above.
      const hattrickCandidates = statRows.filter(r => (r.bowling?.wickets ?? 0) >= 3)
      if (hattrickCandidates.length) {
        await sb.from('potential_hattricks').upsert(
          hattrickCandidates.map(r => ({
            tournament_id: match.tournament_id,
            match_id     : match.id,
            player_id    : r.player_id,
            wickets      : r.bowling!.wickets,
            source       : 'cricapi',
          })),
          { onConflict: 'match_id,player_id', ignoreDuplicates: true },
        )
      }

      // ── 7. Cascade to Daily + Season Long scores ────────────────────────
      const pointsMap = new Map<string, number>()
      for (const [pid, s] of statsByPlayer) pointsMap.set(pid, s.raw_points)
      const dailyTeamsScored = await scoreDailyTeamsForMatch(match.id, pointsMap)
      const slScored         = await scoreSLForMatch(match.id, fmtKey, statsByPlayer, metaByPlayer, !!tournament?.dot_ball_enabled)

      // ── 8. Update match status (mirrors the browser poller's apiStatus logic) ──
      // stats_verified_at (migration_v59) is stamped unconditionally here too
      // — reaching this line means this run passed the isStale check above,
      // so the stats just written are trustworthy. Shared with
      // scrape-scorecard's identical convention so the admin panel's
      // "⚠ unverified" badge (status='completed' with stats_verified_at
      // still null) works the same regardless of which data source completed
      // the match.
      const apiStatus = stage === 'completed' ? 'completed' : stage === 'live' ? 'in_progress' : null
      const matchUpdate: Record<string, unknown> = { stats_verified_at: new Date().toISOString() }
      if (apiStatus && match.status !== apiStatus) matchUpdate.status = apiStatus
      await sb.from('matches').update(matchUpdate).eq('id', match.id)

      // ── 9. Bump the progress watermark now that this read has landed ────
      if (newProgress.innings !== storedProgress.innings || newProgress.balls !== storedProgress.balls) {
        await sb.from('matches')
          .update({ progress_innings: newProgress.innings, progress_balls: newProgress.balls })
          .eq('id', match.id)
      }

      results.push({
        matchId: match.id, status: 'ok', stage,
        matched: statRows.length, unmatched: unmatched.map(u => u.name),
        fuzzyAliasesCreated: fuzzyAliases.length,
        fieldingCredited: fieldingByPlayer.size, fieldingIssues: fieldingIssues.length,
        dailyTeamsScored, slScored,
        matchCompleted: stage === 'completed',
      })
    }

    return new Response(JSON.stringify({ ok: true, results }), { status: 200, headers: { ...CORS, 'Content-Type': 'application/json' } })
  } catch (err) {
    console.error('[poll-cricapi]', err)
    return new Response(JSON.stringify({ ok: false, error: (err as Error).message }), { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } })
  }
})
