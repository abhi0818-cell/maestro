/**
 * check-toss — Supabase Edge Function
 *
 * Confirms the toss (winner + bat/bowl decision) for any match starting
 * within the next 30 minutes, from three independent sources — CricAPI,
 * CricketAddictor, and Cricbuzz — so the admin has an early, corroborated
 * signal well before lock-matches freezes squads at start_time.
 *
 * Trigger conditions and what happens:
 *   1. Toss confirmed by either source → matches.toss_status = 'confirmed'.
 *      Admin gets a push too ("toss confirmed, no action needed") — this is
 *      the all-clear signal, not just a silent DB write, so a confirmation
 *      is only persisted once that push has actually gone out (see the
 *      "Case 1" comment below for why).
 *   2. No toss from either source, AND we're within 10 minutes of start_time
 *      (i.e. start_time minus 10 minutes has passed) → matches.toss_status =
 *      'delay_flagged', admin gets a push ('no toss yet, match looks delayed
 *      — review / push the start time'). If app_settings.toss_auto_push.enabled
 *      is true (off by default — see migration_v55), it ALSO auto-pushes
 *      lock_time forward and flips the match to 'delayed' instead of just
 *      notifying. As of 2026-09-08 this is deliberately notify-only: real
 *      corroboration data (toss_source_reliability) shows Cricbuzz/
 *      CricketAddictor reliably landing 25-30 min before start, so a T-10
 *      flag is a genuine anomaly worth a manual look, not routine — and the
 *      admin wants to review/push by hand for now rather than have it
 *      pushed automatically. See the CORROBORATION_WINDOW_MINUTES-adjacent
 *      section below for how to flip that on later if wanted.
 *   3. No toss yet, and still more than 10 minutes to start_time →
 *      toss_status = 'pending', no action. Toss is typically in by T-30, so
 *      this is the normal state for the great majority of the 30-minute
 *      window.
 *
 * Why the delay decision point is start_time MINUS 10 minutes (2026-09-08,
 * tightened from 15): toss has consistently landed by T-25..T-30 across
 * every CPL 2026 match with real corroboration data (both Cricbuzz and
 * CricketAddictor agree on that window — see toss_source_reliability) — a
 * T-15 flag was leaving 15 minutes of "normal, nothing's wrong" time
 * classified as if it might already be a delay. T-10 is close enough to
 * kickoff that a flag here is a genuine signal, not noise, while still
 * leaving 10 real minutes to review and manually push lock_time before
 * lock-matches (its own independent 1-minute cron) locks squads the moment
 * start_time passes — the two functions aren't coupled, so flagging only at
 * start_time itself would leave no real buffer at all: both crons could
 * tick the same minute, and a delayed match could get locked before
 * check-toss's own update lands.
 *
 * Why "no toss by the decision point" is the delay signal (rather than
 * text-matching for words like "rain"/"delayed" in a source's status
 * string): every source phrases delays differently, and some never say the
 * word "delayed" at all — they just stay silent on the toss. Comparing our
 * own start_time against wall-clock time is a signal every source shares,
 * so it doesn't depend on guessing any one site's wording. Any delay/rain
 * language a source DOES surface is still captured and included in the
 * notification body as extra context, just not used as the trigger itself.
 *
 * CricketAddictor's toss line lives on the match's "Summary" page — a
 * DIFFERENT page than the one scrape-scorecard hits (its /scorecard/ page has
 * no toss text at all; confirmed live). We also can't rely on
 * matches.scorecard_url being populated yet: scrape-scorecard only starts
 * resolving that URL once start_time is 5+ minutes in the PAST (see its own
 * comment), i.e. never during this function's entire pre-match window. So
 * this function carries its own copy of scrape-scorecard's URL-discovery
 * logic (slug guessing + a listing-page scan) rather than depending on it.
 * When it does resolve a URL, it writes it back to matches.scorecard_url so
 * scrape-scorecard doesn't have to re-discover it later — a free side benefit,
 * not something either function depends on the other for.
 *
 * CricAPI hits /v1/match_info, not /v1/match_scorecard — this project's
 * CricAPI subscription doesn't have access to match_scorecard (confirmed
 * live: it returns "Subscription invalid"), and match_info is a better fit
 * regardless, since it returns tossWinner/tossChoice as clean top-level
 * fields instead of a free-text sentence to regex against.
 *
 * Even with that fix, CricAPI has yet to successfully land a toss_source_log
 * row in production — every attempt fails with "Connection reset by peer
 * (os error 104)" during connect (confirmed via M16's function logs), even
 * though the exact same URL/key returns clean data outside Supabase's edge
 * runtime and this account is well under CricAPI's daily hit limit. That
 * points to a block on Supabase's edge egress specifically (see
 * fetchCricApiMatchInfo/fetchWithRetry below), not a key, quota, or endpoint
 * problem. CricketAddictor is unaffected — different host entirely — so the
 * toss pipeline as a whole still works end-to-end off that one source; this
 * is specifically about restoring CricAPI's contribution.
 *
 * A fourth candidate source, ESPNcricinfo's internal API, was tried and ruled
 * out (2026-08-26): it returns a hard HTTP 403 "Access Denied" from
 * Supabase's edge egress (confirmed live) — a WAF-level block, not something
 * a retry gets past, unlike CricAPI's transport-level reset. Cricbuzz, by
 * contrast, came back clean from that same egress and turned out to have
 * genuinely structured toss data (see the Cricbuzz section below) — better
 * than either existing source's text-scraping, and from a host that isn't
 * blocked either way CricAPI's issue eventually resolves.
 *
 * "Corroborated" above is still aspirational for the CONFIRM/notify decision:
 * matches.toss_status confirms off whichever ONE source answers first
 * (cricApiToss ?? addictorToss ?? cricbuzzToss) — the three sources are not
 * cross-checked against each other before confirming or before the admin's
 * push goes out. What changed (2026-08-26, after M17 showed the gap live):
 * every successful read from ANY source, not just the winning one, is
 * written to toss_source_log (migration_v60_toss_source_log.sql, widened to
 * allow 'cricbuzz' by migration_v61) — one row per (match, source), stamped
 * with when that source first reported it — and a CONFIRMED match now stays
 * in the polling query for CORROBORATION_WINDOW_MINUTES past its
 * confirmation timestamp specifically so the source(s) that didn't win still
 * get logged, instead of being cut off the instant the first one answered.
 * That table is what a real "do the sources agree, and how far apart in
 * time" corroboration check would query; this function still doesn't gate
 * confirmation on it — it now just guarantees the data actually gets
 * collected for that check to be built on top of later.
 *
 * Triggered by:
 *   - pg_cron every 1 minute (migration_v56_check_toss_cron.sql), body: {}
 *
 * Required env vars (Supabase dashboard → Edge Functions → Secrets):
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *   CRICAPI_KEYS   — same comma-separated key list poll-cricapi uses; needs a
 *                    key with match_info access specifically (see above). If
 *                    unset or exhausted, CricAPI is skipped for that pass
 *                    (non-fatal) and the other two sources are relied on.
 *                    (Cricbuzz needs no key/env var — it's a public page.)
 *
 * Deploy:
 *   supabase functions deploy check-toss --no-verify-jwt
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SUPABASE_URL              = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const CRICAPI_KEYS = (Deno.env.get('CRICAPI_KEYS') ?? '')
  .split(',').map(k => k.trim()).filter(Boolean)

const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
})

const UA = 'Mozilla/5.0 (compatible; SuperSelector/1.0)'

// Window opens this many minutes before start_time. Widened from 20 to 30
// (2026-08-22) to give matches more polling passes before the delay
// decision point below — same delay/confirm logic, just a longer runway.
const CHECK_WINDOW_MINUTES = 30
// ...and "no toss yet" only counts as a delay signal once we're within this
// many minutes of start_time (i.e. start_time - DELAY_DECISION_BUFFER_MINUTES
// has passed) — see the file header for why this needs a real buffer before
// start_time itself, not just start_time. Widened from 10 to 15 (2026-08-23),
// then tightened back to 10 (2026-09-08) once real corroboration data
// (toss_source_reliability) showed toss consistently landing by T-25..T-30
// in practice — the 15-minute buffer was flagging matches as "possible
// delay" while still comfortably inside their normal reporting window.
const DELAY_DECISION_BUFFER_MINUTES = 10

// 2026-08-26: added after M17 exposed the gap directly — CricketAddictor
// confirmed the toss, which immediately excluded the match from every future
// tick (old query: `.neq('toss_status','confirmed')`), so Cricbuzz never got
// a chance to log its own read for that match even though its data was
// sitting there correctly a minute or two later. That made toss_source_log
// useless for real corroboration: it only ever captured whichever source
// happened to win a given tick, never a second opinion.
//
// Fix: once a match confirms, keep it in the query (see corroborationWindowStartISO
// below) for this many minutes past the ORIGINAL confirmation timestamp, so
// every source still gets fetched and still gets a chance to write to
// toss_source_log — see the "alreadyConfirmed" branch in the main loop for
// what's actually skipped on those ticks (no re-notify, no status rewrite).
// Not unbounded: CricAPI/CricketAddictor's toss text has a normal window it
// shows up in, so polling indefinitely past confirmation buys nothing once
// every source that will ever answer has had its chance. (Cricbuzz's own
// per-match tossResults fallback — see fetchCricbuzzPerMatchToss — turned
// out to persist far longer than this window, but this constant governs the
// query's polling cutoff, not how long any one source's data stays valid.)
// 30 minutes mirrors CHECK_WINDOW_MINUTES's pre-match window.
const CORROBORATION_WINDOW_MINUTES = 30

// ─────────────────────────────────────────────────────────────────────────────
// ─── CricketAddictor slug / URL discovery ──────────────────────────────────────
// Ported from scrape-scorecard/index.ts (same file's discoverUrl chain) —
// trimmed to the pre-match-relevant listing pages only (no recent-matches/
// last-resort scan, since a match this function checks hasn't happened yet).
// Kept as a near-verbatim copy rather than a shared import, matching this
// project's existing per-function convention (see poll-cricapi's header notes
// on why scrape-scorecard/poll-cricapi each keep their own copies).
// ─────────────────────────────────────────────────────────────────────────────

function toSlug(s: string): string {
  return s.toLowerCase().trim()
    .replace(/['']/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}

function stripGenderSuffix(slug: string): string {
  return slug.replace(/-(?:women|w)$/i, '')
}

function stripConnectorWords(slug: string): string {
  return slug
    .split('-')
    .filter(tok => tok !== 'and' && tok !== 'of' && tok !== 'the')
    .join('-')
}

const COUNTRY_CODE_TO_SLUG: Record<string, string> = {
  nz: 'new-zealand', sl: 'sri-lanka', ind: 'india', aus: 'australia', eng: 'england',
  pak: 'pakistan', sa: 'south-africa', wi: 'west-indies', ban: 'bangladesh', ire: 'ireland',
  sco: 'scotland', afg: 'afghanistan', zim: 'zimbabwe', usa: 'united-states',
  uae: 'united-arab-emirates', ned: 'netherlands', nam: 'namibia', png: 'papua-new-guinea',
  can: 'canada', nep: 'nepal', oma: 'oman', qat: 'qatar', ken: 'kenya', hk: 'hong-kong',
  jer: 'jersey', ber: 'bermuda', tha: 'thailand', vct: 'vanuatu',
  lakr: 'los-angeles-knight-riders', tsk: 'texas-super-kings',
  sfu: 'san-francisco-unicorns', mny: 'mi-new-york',
  so: 'seattle-orcas', wf: 'washington-freedom',
}

function expandTeamSlug(slug: string): string | null {
  const isWomen = /-(?:women|w)$/i.test(slug)
  const bare    = stripGenderSuffix(slug)
  const full    = COUNTRY_CODE_TO_SLUG[bare]
  if (!full) return null
  return isWomen ? `${full}-women` : full
}

function teamSlugVariants(full: string | null, bare: string, nc: string): string[] {
  return [...new Set([full, bare, nc].filter((s): s is string => !!s))]
}

function ordinal(n: number): string {
  const v = n % 100
  if (v >= 11 && v <= 13) return `${n}th`
  switch (n % 10) {
    case 1: return `${n}st`
    case 2: return `${n}nd`
    case 3: return `${n}rd`
    default: return `${n}th`
  }
}

function matchTypeSlugVariants(matchType: string | null, matchNumber: number): string[] {
  switch (matchType) {
    case 'final':       return ['final']
    case 'semi_final':  return ['semi-final']
    case 'qualifier_1': return ['qualifier-1']
    case 'qualifier_2': return ['qualifier-2']
    case 'eliminator':  return ['eliminator']
    default:            return [`match-${matchNumber}`, `${ordinal(matchNumber)}-match`]
  }
}

function cricketAddictorUrl(t1: string, t2: string, desc: string, series: string): string {
  return `https://cricketaddictor.com/livescore/${t1}-vs-${t2}-${desc}-${series}/scorecard/`
}

interface ListingMatch {
  baseUrl: string
  team1Slug: string
  team2Slug: string
  dateTimeText: string | null
  contextText: string
}

function parseListingMatches(html: string): ListingMatch[] {
  const out: ListingMatch[] = []
  const re = /href="(https:\/\/cricketaddictor\.com\/livescore\/([a-z0-9-]+)\/)scorecard\/"/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null) {
    const baseUrl = m[1]
    const slug    = m[2]
    const vsIdx   = slug.indexOf('-vs-')
    if (vsIdx === -1) continue
    const team1Slug = slug.slice(0, vsIdx)
    const rest      = slug.slice(vsIdx + 4)
    const cut = rest.match(/-(?:\d+(?:st|nd|rd|th)?-match|match-\d+|final|semi-final|qualifier-\d|eliminator)-/)
    const team2Slug = cut ? rest.slice(0, cut.index) : rest.split('-').slice(0, 3).join('-')

    const windowStart = Math.max(0, m.index - 600)
    const context      = html.slice(windowStart, m.index + 600)
    const dateM         = context.match(/([A-Za-z]+ \d{1,2}, \d{4}\s+\d{1,2}:\d{2}\s*[AP]M)/)

    out.push({ baseUrl, team1Slug, team2Slug, dateTimeText: dateM ? dateM[1] : null, contextText: context })
  }
  return out
}

function teamSlugMatches(ourSlug: string, theirSlug: string): boolean {
  const a = stripGenderSuffix(ourSlug)
  const b = stripGenderSuffix(theirSlug)
  return a === b || a.startsWith(b) || b.startsWith(a) || a.includes(b) || b.includes(a)
}

// One invocation checks every due match — cache listing pages across matches.
const listingCache = new Map<string, ListingMatch[]>()

async function getListing(url: string): Promise<ListingMatch[]> {
  if (listingCache.has(url)) return listingCache.get(url)!
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA } })
    if (!r.ok) { listingCache.set(url, []); return [] }
    const html   = await r.text()
    const parsed = parseListingMatches(html)
    listingCache.set(url, parsed)
    return parsed
  } catch {
    listingCache.set(url, [])
    return []
  }
}

async function scanListingsForMatch(
  homeSlugs: string[], awaySlugs: string[],
  startTime: string | null, tournamentName: string,
): Promise<string | null> {
  // No recent-matches page here — this function only ever checks matches that
  // haven't started yet, so a "recent" listing can't help.
  const pages = [
    'https://cricketaddictor.com/livescore/',
    'https://cricketaddictor.com/livescore/upcoming-matches/',
  ]
  const targetMs = startTime ? new Date(startTime).getTime() : NaN
  const tWords   = tournamentName.toLowerCase().split(/\W+/).filter(w => w.length > 3)

  let best: { url: string; score: number } | null = null

  for (const page of pages) {
    const listing = await getListing(page)
    for (const lm of listing) {
      const teamsMatch =
        (homeSlugs.some(h => teamSlugMatches(h, lm.team1Slug)) && awaySlugs.some(a => teamSlugMatches(a, lm.team2Slug))) ||
        (homeSlugs.some(h => teamSlugMatches(h, lm.team2Slug)) && awaySlugs.some(a => teamSlugMatches(a, lm.team1Slug)))
      if (!teamsMatch) continue

      let score = 1
      if (lm.dateTimeText && !isNaN(targetMs)) {
        const parsed = Date.parse(lm.dateTimeText)
        if (!isNaN(parsed)) {
          const diffHrs = Math.abs(parsed - targetMs) / 36e5
          if (diffHrs <= 48) score += (48 - diffHrs) / 48
        }
      }
      const ctxLower = lm.contextText.toLowerCase()
      score += tWords.filter(w => ctxLower.includes(w)).length * 0.5

      if (!best || score > best.score) best = { url: lm.baseUrl + 'scorecard/', score }
    }
  }
  return best ? best.url : null
}

/** Same three-step strategy as scrape-scorecard's discoverUrl (candidate slug
 *  guesses → HEAD-check, then a listing-page scan as fallback), minus the
 *  final recent-matches last-resort step, which is meaningless pre-match. */
async function discoverUrl(
  homeTeam: string, awayTeam: string,
  matchType: string | null, matchNumber: number,
  tournamentName: string, startTime: string | null,
): Promise<string | null> {
  const t1     = toSlug(homeTeam)
  const t2     = toSlug(awayTeam)
  const t1Bare = stripGenderSuffix(t1)
  const t2Bare = stripGenderSuffix(t2)
  const t1Full = expandTeamSlug(t1)
  const t2Full = expandTeamSlug(t2)
  const t1Nc   = stripConnectorWords(t1Bare)
  const t2Nc   = stripConnectorWords(t2Bare)
  const series = toSlug(tournamentName)
  const descs  = matchTypeSlugVariants(matchType, matchNumber)

  const teamPairs: Array<[string, string]> = []
  if (t1Full && t2Full) teamPairs.push([t1Full, t2Full], [t2Full, t1Full])
  teamPairs.push([t1, t2], [t2, t1])
  if (t1Bare !== t1 || t2Bare !== t2) teamPairs.push([t1Bare, t2Bare], [t2Bare, t1Bare])
  if (t1Nc !== t1Bare || t2Nc !== t2Bare) teamPairs.push([t1Nc, t2Nc], [t2Nc, t1Nc])

  const candidates: string[] = []
  for (const desc of descs) {
    for (const [a, b] of teamPairs) candidates.push(cricketAddictorUrl(a, b, desc, series))
  }

  for (const url of candidates) {
    try {
      const r = await fetch(url, { method: 'HEAD', headers: { 'User-Agent': UA } })
      if (r.ok) return url
    } catch { /* try next */ }
  }

  const t1Variants = teamSlugVariants(t1Full ? stripGenderSuffix(t1Full) : null, t1Bare, t1Nc)
  const t2Variants = teamSlugVariants(t2Full ? stripGenderSuffix(t2Full) : null, t2Bare, t2Nc)
  return await scanListingsForMatch(t1Variants, t2Variants, startTime, tournamentName)
}

// ─────────────────────────────────────────────────────────────────────────────
// ─── Toss parsing ───────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────

interface TossResult {
  winnerName: string
  decision: 'bat' | 'bowl'
  delayText: string | null   // any delay/rain language the source surfaced, for the notification body only
}

function normalizeDecision(raw: string): 'bat' | 'bowl' {
  return /bat/i.test(raw) ? 'bat' : 'bowl'   // covers "field" too — same meaning as "bowl" here
}

const DELAY_KEYWORDS = /\b(rain|wet outfield|covers? on|pitch inspection|delayed?|reduced overs|bad light|no toss yet)\b/i

function stripTags(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ').trim()
}

// Team-name character class for toss regexes below. Started as
// [A-Za-z .'-] and missed "St Kitts & Nevis Patriots" (CricketAddictor
// spells it with an ampersand, not "and") — a real false-negative caught
// live on CPL 2026 M10, not a hypothetical. Widen this if another team name
// shape turns up a similar miss (numerals, other punctuation, etc.) rather
// than assuming this list is exhaustive.
const TEAM_NAME_CHARS = `A-Za-z .'&-`

function parseCricketAddictorToss(html: string): TossResult | null {
  const text = stripTags(html)
  const m = text.match(new RegExp(`Toss:\\s*([A-Za-z][${TEAM_NAME_CHARS}]+?)\\s+elected to\\s+(bat|bowl|field)`, 'i'))
  const delayM = text.match(DELAY_KEYWORDS)
  if (!m) return null
  return { winnerName: m[1].trim(), decision: normalizeDecision(m[2]), delayText: delayM ? delayM[0] : null }
}

// CricAPI's tossWinner comes back lowercase (e.g. "guyana amazon warriors") —
// resolve it against this match's actual home/away team names so pushes and
// toss_source_log read with proper casing instead of a raw lowercase dump.
// Falls back to naive title-casing if it doesn't match either team (shouldn't
// happen in practice, but better than surfacing the lowercase string as-is).
function resolveTeamCasing(rawName: string, homeTeam: string, awayTeam: string): string {
  const norm = (s: string) => s.toLowerCase().trim()
  if (homeTeam && norm(rawName) === norm(homeTeam)) return homeTeam
  if (awayTeam && norm(rawName) === norm(awayTeam)) return awayTeam
  return rawName.replace(/\b\w/g, c => c.toUpperCase())
}

// 2026-08-24: switched from /v1/match_scorecard to /v1/match_info. The keys
// this project's CricAPI subscription has actually been granted only have
// access to match_info (confirmed live: match_scorecard returns "Subscription
// invalid" for this account, match_info returns real data) — and match_info
// is a better fit anyway: it returns tossWinner/tossChoice as clean top-level
// fields instead of requiring a regex against a free-text `status` sentence,
// which is what match_scorecard forced (see parseCricketAddictorToss below
// for the regex approach CricketAddictor still needs, since it has no
// structured API to fall back on).
function parseCricApiToss(payload: any, homeTeam: string, awayTeam: string): TossResult | null {
  const data = payload?.data ?? payload ?? {}
  const rawWinner = data.tossWinner
  const rawChoice = data.tossChoice
  if (!rawWinner || !rawChoice) return null
  const winnerName = resolveTeamCasing(String(rawWinner), homeTeam, awayTeam)
  const decision   = normalizeDecision(String(rawChoice))
  // match_info's `status` field is still a free-text summary (e.g. a result
  // line, or "Match starts at ..." pre-match) — DELAY_KEYWORDS can still
  // surface rain/delay language there even though toss itself is structured.
  const delayM = String(data.status || '').match(DELAY_KEYWORDS)
  return { winnerName, decision, delayText: delayM ? delayM[0] : null }
}

// 2026-08-26: M16 confirmed live what fetchCricApiMatchInfo's header comment
// only speculated about — the failure is a transport-level reset, not an API
// error. The function's own log for that run:
//   "CricAPI check failed for M16: error sending request for url
//   (https://api.cricapi.com/v1/match_info?...): client error (Connect):
//   Connection reset by peer (os error 104)"
// happening on the SAME key/endpoint/match id that returns clean data when
// fetched from outside Supabase's edge runtime (confirmed by hand). The user
// also confirmed this project is nowhere near CricAPI's daily hit limit, so
// this isn't rate-limiting — it's the connection itself being refused during
// connect, which is the signature of a firewall/WAF/bot-protection layer in
// front of api.cricapi.com rejecting Supabase's edge egress specifically
// (cloud/datacenter IP ranges are a common target for that kind of block),
// not a fluke of this one run — CricAPI has never once landed a
// toss_source_log row since the endpoint/key fix, while CricketAddictor
// (different host) has succeeded on every run.
//
// fetchWithRetry below is a best-effort mitigation, not a fix: a reset during
// connect can occasionally succeed a few hundred ms later even against a
// flaky network path, so it's worth doing regardless. But if this really is
// a deliberate IP-based block (as opposed to something transient), no amount
// of retrying from the same egress fixes it — that needs either CricAPI
// confirming/lifting the block, or routing this call through a different
// egress path (a proxy) that isn't recognized as Supabase's edge network.
async function fetchWithRetry(url: string, options: RequestInit, maxAttempts = 3): Promise<Response> {
  let lastErr: Error | null = null
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fetch(url, options)
    } catch (e) {
      lastErr = e as Error
      if (attempt < maxAttempts) await new Promise(r => setTimeout(r, 300 * attempt))
    }
  }
  throw lastErr ?? new Error('fetch failed with no error captured')
}

// ─────────────────────────────────────────────────────────────────────────────
// ─── Cricbuzz (Source 3) ────────────────────────────────────────────────────
// 2026-08-26: added after confirming (a) ESPNcricinfo's internal API is
// blocked outright — a real HTTP 403 "Access Denied" from Supabase's edge
// egress, a WAF-level block, not something a retry gets past — and (b)
// Cricbuzz is NOT blocked from that same egress, confirmed live.
//
// Rather than scraping a per-match page for a toss sentence (CricketAddictor's
// approach, needed because it has no structured API), Cricbuzz's own
// cricket-match/live-scores listing page embeds a structured JSON blob of
// every live/upcoming/recently-finished match it's currently tracking, each
// with a `matchInfo.state` field ("Preview" → "Toss" → "In Progress"/"Live" →
// "Complete"/"Stumps"/etc.) and a `matchInfo.status` free-text field whose
// CONTENTS depend on state. When state is exactly "Toss", status IS the toss
// line (confirmed live: {"state":"Toss","status":"Guernsey Women opt to
// bowl"} for an unrelated match on the same page) — so this is read as a
// structured signal (state === 'Toss'), same tier of reliability as CricAPI's
// tossWinner/tossChoice fields, just sourced from a host that isn't blocked.
//
// One real limitation: this only catches the toss during the narrow window
// where state stays "Toss" — once play starts, state moves on and `status`
// stops being the toss line. Given check-toss polls every minute and there's
// normally a real gap between toss and first ball, this should catch it in
// practice, but it's not guaranteed the way CricAPI/CricketAddictor's toss
// text (which doesn't disappear once the match progresses) is. That's fine
// here: Cricbuzz is a third source, not a replacement for the other two.
//
// 2026-09-01 hardening: that limitation stopped being theoretical on CPL 2026
// M22 — a toss that happened exactly on schedule (confirmed by the user; NOT
// a rain-delay case) was still missed, despite check-toss polling every
// single minute of the pre-match window with zero cron gaps (verified against
// pg_cron's own run history). Cricbuzz's state machine simply never landed on
// "Toss" during any of those 45 polls — it moved from "Preview" straight past
// it, so there was no window to catch at all, not just a narrow one. See
// fetchCricbuzzPerMatchToss below for the fix: a second, persistent signal on
// each match's own page that doesn't depend on catching a one-minute-wide
// state, tried as a fallback whenever this transient text parse comes up
// empty.
//
// One page covers everything check-toss might be polling for (confirmed live:
// CPL, TNPL, DPL, ETPL, County Championship, Duleep Trophy, Women's
// Continental Cup, and a Bangladesh A tour all appeared on one fetch) — so
// unlike CricketAddictor's per-tournament slug-guessing, this needs exactly
// one fetch per check-toss invocation, cached and reused across every match
// in that run's loop.

const CRICBUZZ_LIVE_SCORES_URL = 'https://www.cricbuzz.com/cricket-match/live-scores'

interface CricbuzzMatchInfo {
  matchId: number
  state: string
  status: string
  startDate: string
  team1: { teamName: string }
  team2: { teamName: string }
}

// NOT module-level state (unlike CricketAddictor's listingCache above) —
// this holds live state/status data that goes stale within seconds, not
// just static URL-discovery data. CricketAddictor's cache is safe as a
// module-level Map because a warm Deno isolate reusing it across separate
// cron ticks only costs a redundant URL guess; the same pattern here would
// mean serving a Toss/Preview/Complete snapshot from a PREVIOUS minute's
// invocation on ticks where the isolate stayed warm. So this cache is
// instead a plain object created fresh inside Deno.serve's handler (see
// `cricbuzzCache` below) and threaded through as a parameter — guaranteed
// to be empty at the start of every invocation, reused only across the
// matches looped over within that same invocation.
interface CricbuzzCache { data: CricbuzzMatchInfo[] | null }

// The listing page embeds its match data as a JSON string nested inside a
// larger JS/JSON payload (a `"matches":[...]` array whose own quotes are
// backslash-escaped, i.e. double-encoded) rather than as directly-parseable
// JSON. Un-escaping `\"` → `"` first turns that substring into ordinary JSON,
// which is far more robust than regexing individual fields out of it by hand.
async function getCricbuzzMatches(cache: CricbuzzCache): Promise<CricbuzzMatchInfo[]> {
  if (cache.data) return cache.data
  try {
    const res = await fetch(CRICBUZZ_LIVE_SCORES_URL, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36', 'Accept': 'text/html,*/*' },
    })
    if (!res.ok) { cache.data = []; return [] }
    const html = await res.text()
    const unescaped = html.replace(/\\"/g, '"')
    const markerIdx = unescaped.indexOf('"matches":[')
    if (markerIdx === -1) { cache.data = []; return [] }
    const arrStart = unescaped.indexOf('[', markerIdx)
    let depth = 0, i = arrStart
    for (; i < unescaped.length; i++) {
      if (unescaped[i] === '[') depth++
      else if (unescaped[i] === ']') { depth--; if (depth === 0) { i++; break } }
    }
    const parsed = JSON.parse(unescaped.slice(arrStart, i))
    // 2026-08-26, M17: the page has 44 separate "matches":[...] blocks (one
    // per widget/section), and the FIRST one — the one indexOf above grabs —
    // shapes its items as {"match":{"matchInfo":{...}}}, one level deeper
    // than a LATER block's {"matchInfo":{...}} shape (which is what this
    // parser was originally built against, from inspecting a different block
    // than the one actually used at runtime). Confirmed live: that first
    // block's data was complete and correct (state "Toss", right status
    // text) — only the extraction was wrong, silently reading undefined off
    // every item. Handling both shapes here is more robust than switching
    // marker/block, in case the shape varies again.
    const out: CricbuzzMatchInfo[] = Array.isArray(parsed)
      ? parsed.map((m: any) => m?.matchInfo ?? m?.match?.matchInfo).filter(Boolean)
      : []
    cache.data = out
    return out
  } catch (e) {
    console.warn('[check-toss] Cricbuzz listing fetch/parse failed:', (e as Error).message)
    cache.data = []
    return []
  }
}

function findCricbuzzMatch(
  matches: CricbuzzMatchInfo[], homeTeam: string, awayTeam: string, startTimeISO: string | null,
): CricbuzzMatchInfo | null {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
  const h = norm(homeTeam), a = norm(awayTeam)
  if (!h || !a) return null
  const targetMs = startTimeISO ? new Date(startTimeISO).getTime() : NaN

  let best: CricbuzzMatchInfo | null = null
  let bestDiff = Infinity
  for (const info of matches) {
    const t1 = norm(info.team1?.teamName ?? ''), t2 = norm(info.team2?.teamName ?? '')
    if (!t1 || !t2) continue
    const teamsMatch = (t1 === h && t2 === a) || (t1 === a && t2 === h)
    if (!teamsMatch) continue
    // Cricbuzz's own human-readable status text has shown date display
    // quirks (e.g. "Match starts at Aug 27" for a match whose structured
    // startDate is actually the 26th) — startDate itself (epoch ms) matched
    // our start_time exactly when checked live, so trust that field, not the
    // display string, for disambiguation when team names alone aren't enough.
    const diff = !isNaN(targetMs) && info.startDate ? Math.abs(Number(info.startDate) - targetMs) : 0
    if (diff < bestDiff) { bestDiff = diff; best = info }
  }
  // Same-tournament rematches within ~48h of each other are the only
  // realistic ambiguity here; reject a match whose start time is that far
  // off rather than risk pairing the wrong fixture.
  if (best && !isNaN(targetMs) && bestDiff > 48 * 60 * 60 * 1000) return null
  return best
}

const CRICBUZZ_TOSS_TEXT = /([A-Za-z][A-Za-z .'&-]+?)\s+(?:won the toss and )?(?:opt(?:s|ed)?|elected)\s+to\s+(bat|bowl|field)/i

function parseCricbuzzToss(info: CricbuzzMatchInfo | null, homeTeam: string, awayTeam: string): TossResult | null {
  // status only IS the toss line while state === 'Toss' — see header comment.
  if (!info || info.state !== 'Toss') return null
  const m = String(info.status || '').match(CRICBUZZ_TOSS_TEXT)
  if (!m) return null
  return { winnerName: resolveTeamCasing(m[1].trim(), homeTeam, awayTeam), decision: normalizeDecision(m[2]), delayText: null }
}

// 2026-09-01: the hardening fallback for the "state never actually hits
// Toss" gap described above the CRICBUZZ_TOSS_TEXT regex. Each match's own
// page (`/live-cricket-scores/{matchId}/anything-or-nothing` — confirmed
// live that the slug is purely decorative; Cricbuzz resolves the same
// canonical page off matchId alone, e.g. `.../154535/x` and `.../154535`
// both returned identical content) embeds a `tossResults` object that is
// SEPARATE from matchInfo.state/status and, unlike that transient status
// line, doesn't go away once the match moves on — confirmed live on CPL 2026
// M22, hours after full time with a DLS result already showing:
// {"tossWinnerId":271,"tossWinnerName":"Trinbago Knight Riders",
// "decision":"Bowling"} was still sitting in the page. That makes this a
// genuinely persistent signal rather than a race against a one-minute-wide
// state window, so it's worth the extra fetch as a fallback whenever the
// cheap listing-page text parse above comes up empty but Cricbuzz is
// tracking the match at all (i.e. findCricbuzzMatch resolved a matchId).
//
// Deliberately not folded into getCricbuzzMatches/the shared listing cache:
// that one listing fetch covers every tournament check-toss might be
// polling in a single request, but this is a per-match page — one fetch per
// match that still needs it, only triggered on the (common, per the M22
// finding) case where the transient signal didn't land this tick.
const CRICBUZZ_TOSS_RESULTS =
  /"tossResults"\s*:\s*\{\s*"tossWinnerId"\s*:\s*\d+\s*,\s*"tossWinnerName"\s*:\s*"([^"]*)"\s*,\s*"decision"\s*:\s*"([^"]*)"\s*\}/

async function fetchCricbuzzPerMatchToss(
  matchId: number, homeTeam: string, awayTeam: string,
): Promise<TossResult | null> {
  try {
    const res = await fetchWithRetry(`https://www.cricbuzz.com/live-cricket-scores/${matchId}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36', 'Accept': 'text/html,*/*' },
    })
    if (!res.ok) return null
    const html = await res.text()
    // Same double-encoding as the listing page (see getCricbuzzMatches) —
    // un-escape before regexing so embedded quotes don't break the match.
    const unescaped = html.replace(/\\"/g, '"')
    const m = unescaped.match(CRICBUZZ_TOSS_RESULTS)
    if (!m) return null
    const [, rawWinner, rawDecision] = m
    // Defensive: this project has only ever observed tossResults POST-toss
    // (every live sample so far has been a completed or in-progress match).
    // Its pre-toss shape — absent entirely, or present with empty/placeholder
    // fields — isn't confirmed either way, so treat blank fields as "not a
    // real result yet" rather than risk surfacing an empty string as a winner.
    if (!rawWinner.trim() || !rawDecision.trim()) return null
    return {
      winnerName: resolveTeamCasing(rawWinner.trim(), homeTeam, awayTeam),
      decision: normalizeDecision(rawDecision),
      delayText: null,
    }
  } catch (e) {
    console.warn('[check-toss] Cricbuzz per-match fetch/parse failed:', (e as Error).message)
    return null
  }
}

async function fetchCricApiMatchInfo(externalId: string): Promise<any> {
  if (!CRICAPI_KEYS.length) throw new Error('No CRICAPI_KEYS configured')
  let lastErr: Error | null = null
  for (const key of CRICAPI_KEYS) {
    try {
      const res = await fetchWithRetry(
        `https://api.cricapi.com/v1/match_info?apikey=${encodeURIComponent(key)}&id=${encodeURIComponent(externalId)}`,
        { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36', 'Accept': 'application/json, text/plain, */*' } },
        3,
      )
      const json = await res.json().catch(() => null)
      // Note: CricAPI's failure payloads carry the explanation in `reason`,
      // not `message` (e.g. {"status":"failure","reason":"Subscription
      // invalid"}) — json?.message below is near-always undefined in
      // practice, so `msg` mostly falls through to the generic string. That
      // only affects the diagnostic text in a thrown/logged error, not retry
      // behavior: every failure path here (exhausted or not) still ends up
      // caught by this same try's `catch` below and moves on to the next
      // key regardless, since the `throw`s are inside this try block.
      const exhausted = (msg: string) => /invalid.*key|quota|limit|not.*found.*key/i.test(msg)
      if (!res.ok) {
        const msg = json?.message || json?.reason || `HTTP ${res.status}`
        if (exhausted(msg)) { lastErr = new Error(msg); continue }
        throw new Error(msg)
      }
      if (json?.status === 'failure') {
        const msg = json?.message || json?.reason || 'CricAPI request failed'
        if (exhausted(msg)) { lastErr = new Error(msg); continue }
        throw new Error(msg)
      }
      return json
    } catch (e) {
      lastErr = e as Error
      continue
    }
  }
  throw lastErr ?? new Error('All CricAPI keys exhausted')
}

// ─────────────────────────────────────────────────────────────────────────────
// ─── Admin notification ─────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────

async function notifyAdmin(title: string, body: string, data: Record<string, unknown>) {
  const res = await fetch(`${SUPABASE_URL}/functions/v1/send-push-notification`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    },
    body: JSON.stringify({ title, body, target: 'admin', data }),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`send-push-notification failed: HTTP ${res.status} ${text}`)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ─── Main ────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────

interface Match {
  id: string
  tournament_id: string
  match_number: number
  match_type: string | null
  format: string | null
  start_time: string | null
  lock_time: string | null
  status: string
  external_id: string | null
  scorecard_url: string | null
  toss_status: string
  toss_delay_notified_at: string | null
  home_team: { id: string; name: string } | null
  away_team: { id: string; name: string } | null
  tournament: { id: string; name: string } | null
}

Deno.serve(async (req) => {
  if (req.method !== 'POST' && req.method !== 'GET') {
    return new Response('Method Not Allowed', { status: 405 })
  }

  const auth = req.headers.get('Authorization') ?? ''
  if (!auth.includes(SUPABASE_SERVICE_ROLE_KEY)) {
    // Diagnostic only — lengths and a short prefix, never the actual secret
    // values, so this is safe to leave in the logs. Delete once the 401
    // mismatch this is chasing is understood.
    console.error(
      '[check-toss] Auth rejected.',
      'authHeaderLen:', auth.length,
      'authPrefix:', auth.slice(0, 12),
      'envKeyLen:', SUPABASE_SERVICE_ROLE_KEY.length,
      'envKeyPrefix:', SUPABASE_SERVICE_ROLE_KEY.slice(0, 12),
    )
    return new Response('Unauthorized', { status: 401 })
  }

  const nowMs  = Date.now()
  const nowISO = new Date(nowMs).toISOString()
  const windowStartISO = new Date(nowMs + CHECK_WINDOW_MINUTES * 60 * 1000).toISOString()
  // We give up looking at a match 6 hours after its start_time, so a match
  // that never got a toss recorded (abandoned without a ball, data gap,
  // whatever) doesn't sit in this query forever.
  const giveUpISO = new Date(nowMs - 6 * 60 * 60 * 1000).toISOString()
  // See CORROBORATION_WINDOW_MINUTES above — bounds how long a CONFIRMED
  // match still gets polled for corroboration purposes.
  const corroborationWindowStartISO = new Date(nowMs - CORROBORATION_WINDOW_MINUTES * 60 * 1000).toISOString()

  const { data: matches, error: mErr } = await sb
    .from('matches')
    .select(`
      id, tournament_id, match_number, match_type, format, start_time, lock_time, status,
      external_id, scorecard_url, toss_status, toss_delay_notified_at,
      home_team:teams!home_team_id(id, name),
      away_team:teams!away_team_id(id, name),
      tournament:tournaments!tournament_id(id, name)
    `)
    .in('status', ['scheduled', 'delayed'])
    // Previously `.neq('toss_status','confirmed')` dropped a match from every
    // future tick the instant ONE source confirmed it — silently cutting off
    // any other source's chance to log its own read, even one that would've
    // landed a minute later (this is exactly what happened to Cricbuzz on
    // M17). Now: still skip a match confirmed long ago (nothing to gain
    // re-polling something confirmed hours back), but keep a FRESHLY
    // confirmed match in the query for CORROBORATION_WINDOW_MINUTES past its
    // confirmation timestamp, purely so the other sources get logged too.
    .or(`toss_status.neq.confirmed,and(toss_status.eq.confirmed,toss_checked_at.gte.${corroborationWindowStartISO})`)
    .lte('start_time', windowStartISO)
    .gte('start_time', giveUpISO)
    .order('start_time', { ascending: true })

  if (mErr) {
    console.error('[check-toss] Failed to query matches:', mErr.message)
    return new Response(JSON.stringify({ error: mErr.message }), { status: 500 })
  }

  const summary = {
    matchesChecked      : 0,
    tossConfirmed       : 0,
    delayFlagged        : 0,
    notified            : 0,
    corroborationPolled : 0,   // already-confirmed matches re-checked only to log other sources
    errors              : [] as string[],
  }

  if (!matches?.length) {
    return new Response(JSON.stringify({ message: 'No matches due for a toss check', ...summary }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    })
  }

  // Load the auto-push setting once per run.
  let autoPush = { enabled: false, push_minutes: 30, renotify_minutes: 15 }
  try {
    const { data: settingRow } = await sb.from('app_settings').select('value').eq('key', 'toss_auto_push').maybeSingle()
    if (settingRow?.value) autoPush = { ...autoPush, ...settingRow.value }
  } catch (e: any) {
    console.warn('[check-toss] Could not load toss_auto_push setting, defaulting to disabled:', e.message)
  }

  // Fresh every invocation — see the CricbuzzCache comment above for why this
  // can't be module-level state like CricketAddictor's listingCache.
  const cricbuzzCache: CricbuzzCache = { data: null }

  for (const match of (matches as unknown as Match[])) {
    summary.matchesChecked++
    try {
      const homeTeam = match.home_team?.name ?? ''
      const awayTeam = match.away_team?.name ?? ''
      const tournamentName = match.tournament?.name ?? ''
      // See CORROBORATION_WINDOW_MINUTES / the query's `.or(...)` above — a
      // match can now show up here already confirmed, purely so the sources
      // that didn't win the original confirmation still get a chance to log.
      const alreadyConfirmed = match.toss_status === 'confirmed'

      // ── Source 1: CricAPI ────────────────────────────────────────────────
      let cricApiToss: TossResult | null = null
      if (match.external_id) {
        try {
          const payload = await fetchCricApiMatchInfo(match.external_id)
          cricApiToss = parseCricApiToss(payload, homeTeam, awayTeam)
        } catch (e: any) {
          console.warn(`[check-toss] CricAPI check failed for M${match.match_number}:`, e.message)
        }
      }

      // ── Source 2: CricketAddictor ────────────────────────────────────────
      let addictorToss: TossResult | null = null
      try {
        let scorecardUrl = match.scorecard_url
        if (!scorecardUrl && homeTeam && awayTeam) {
          scorecardUrl = await discoverUrl(
            homeTeam, awayTeam, match.match_type, match.match_number, tournamentName, match.start_time,
          )
          // Free side benefit for scrape-scorecard, once this match starts —
          // never overwrites a URL another process already found.
          if (scorecardUrl) {
            await sb.from('matches')
              .update({ scorecard_url: scorecardUrl })
              .eq('id', match.id)
              .is('scorecard_url', null)
          }
        }
        if (scorecardUrl) {
          const summaryUrl = scorecardUrl.replace(/scorecard\/?$/, '')
          const r = await fetch(summaryUrl, { headers: { 'User-Agent': UA } })
          if (r.ok) {
            const html = await r.text()
            addictorToss = parseCricketAddictorToss(html)
          }
        }
      } catch (e: any) {
        console.warn(`[check-toss] CricketAddictor check failed for M${match.match_number}:`, e.message)
      }

      // ── Source 3: Cricbuzz ───────────────────────────────────────────────
      let cricbuzzToss: TossResult | null = null
      try {
        const cbMatches = await getCricbuzzMatches(cricbuzzCache)
        const cbInfo = findCricbuzzMatch(cbMatches, homeTeam, awayTeam, match.start_time)
        cricbuzzToss = parseCricbuzzToss(cbInfo, homeTeam, awayTeam)
        // Hardening (2026-09-01, M22): the transient state==='Toss' text
        // above can miss a perfectly on-time toss outright — see
        // fetchCricbuzzPerMatchToss's header comment. Fall back to the
        // per-match page's persistent tossResults field whenever the cheap
        // parse came up empty but Cricbuzz is tracking this match at all.
        if (!cricbuzzToss && cbInfo) {
          cricbuzzToss = await fetchCricbuzzPerMatchToss(cbInfo.matchId, homeTeam, awayTeam)
        }
      } catch (e: any) {
        console.warn(`[check-toss] Cricbuzz check failed for M${match.match_number}:`, e.message)
      }

      // ── Persist each source's independent read, for corroboration ──────────
      // (migration_v60_toss_source_log.sql, widened to allow 'cricbuzz' by
      // migration_v61). This runs regardless of which source ends up
      // "winning" below — the point is to keep every source's result and
      // arrival time, not just whichever answered first. One row per (match,
      // source): the unique constraint plus ignoreDuplicates means only the
      // FIRST successful read from each source is kept, even though this
      // block runs again on every subsequent minute's tick.
      for (const [source, result] of [
        ['cricapi', cricApiToss], ['cricketaddictor', addictorToss], ['cricbuzz', cricbuzzToss],
      ] as const) {
        if (!result) continue
        try {
          await sb.from('toss_source_log').upsert(
            { match_id: match.id, source, winner_name: result.winnerName, decision: result.decision, received_at: nowISO },
            { onConflict: 'match_id,source', ignoreDuplicates: true },
          )
        } catch (e: any) {
          console.warn(`[check-toss] toss_source_log write failed (${source}) M${match.match_number}:`, e.message)
        }
      }

      // ── Already confirmed: this tick exists only to give the other
      // sources a chance to log to toss_source_log — nothing else to do.
      // Deliberately does NOT touch toss_checked_at: that timestamp is what
      // anchors corroborationWindowStartISO above, so writing to it here
      // would keep re-arming the window forever instead of letting it expire
      // CORROBORATION_WINDOW_MINUTES after the match's ORIGINAL confirmation.
      if (alreadyConfirmed) {
        summary.corroborationPolled++
        continue
      }

      const toss   = cricApiToss ?? addictorToss ?? cricbuzzToss
      const source = cricApiToss ? 'cricapi' : addictorToss ? 'cricketaddictor' : cricbuzzToss ? 'cricbuzz' : null
      const delayText = cricApiToss?.delayText ?? addictorToss?.delayText ?? cricbuzzToss?.delayText ?? null
      const teamsLabel = homeTeam && awayTeam ? `${homeTeam} vs ${awayTeam}` : `Match ${match.match_number}`

      // ── Case 1: toss confirmed ───────────────────────────────────────────
      // The push here IS the deliverable ("toss confirmed, no action needed")
      // — you explicitly want to hear this even when nothing's wrong. So the
      // notify call goes first, and toss_status only flips to 'confirmed'
      // once it actually succeeds; a failed push just leaves the match
      // 'pending'/'delay_flagged' so the next tick retries both the source
      // check and the notification, instead of silently going quiet.
      if (toss && source) {
        const wasFlaggedDelayed = match.toss_status === 'delay_flagged'
        const resultLabel = `${toss.winnerName} won the toss, elected to ${toss.decision}`
        try {
          await notifyAdmin(
            `✅ ${teamsLabel} (M${match.match_number}) — toss confirmed`,
            wasFlaggedDelayed
              ? `Delay resolved — ${resultLabel}. No action needed.`
              : `${resultLabel}. No action needed — match will lock at the scheduled time.`,
            { matchId: match.id, kind: 'toss_confirmed' },
          )
          await sb.from('matches').update({
            toss_status     : 'confirmed',
            toss_winner_name: toss.winnerName,
            toss_decision   : toss.decision,
            toss_source     : source,
            toss_checked_at : nowISO,
          }).eq('id', match.id)
          summary.tossConfirmed++
        } catch (e: any) {
          summary.errors.push(`Confirm-notify failed M${match.match_number}: ${e.message}`)
          await sb.from('matches').update({ toss_checked_at: nowISO }).eq('id', match.id)
        }
        continue
      }

      // ── Case 2/3: no toss yet — past the delay decision point, or still pending ──
      const startMs = match.start_time ? new Date(match.start_time).getTime() : NaN
      const decisionDeadlineMs = startMs - DELAY_DECISION_BUFFER_MINUTES * 60 * 1000
      const pastDecisionPoint = !isNaN(startMs) && nowMs >= decisionDeadlineMs

      if (!pastDecisionPoint) {
        await sb.from('matches').update({
          toss_status: 'pending', toss_checked_at: nowISO,
        }).eq('id', match.id)
        continue
      }

      summary.delayFlagged++
      const lastNotifiedMs = match.toss_delay_notified_at ? new Date(match.toss_delay_notified_at).getTime() : null
      const shouldNotify = lastNotifiedMs === null || (nowMs - lastNotifiedMs) >= autoPush.renotify_minutes * 60 * 1000

      const update: Record<string, unknown> = { toss_status: 'delay_flagged', toss_checked_at: nowISO }

      if (shouldNotify) {
        // Positive = still before start_time (we're inside the 10-minute
        // decision buffer); negative = start_time has also passed.
        const minutesToStart = Math.round((startMs - nowMs) / 60000)
        const timingText = minutesToStart >= 0
          ? `starts in ${minutesToStart}m`
          : `started ${Math.abs(minutesToStart)}m ago`
        const reasonText = delayText ? ` (source reports: "${delayText}")` : ''

        let body: string
        if (autoPush.enabled && !match.lock_time) {
          const newLockTime = new Date(startMs + autoPush.push_minutes * 60 * 1000).toISOString()
          update.status     = 'delayed'
          update.lock_time  = newLockTime
          body = `No toss confirmed, match ${timingText}${reasonText}. Auto-pushed lock time to ${newLockTime}. Confirm toss when known.`
        } else {
          body = `No toss confirmed, match ${timingText}${reasonText}. Review and push the start time if needed.`
        }

        try {
          await notifyAdmin(
            `⚠️ ${teamsLabel} (M${match.match_number}) — possible delay`,
            body,
            { matchId: match.id, kind: 'toss_delay' },
          )
          update.toss_delay_notified_at = nowISO
          summary.notified++
        } catch (e: any) {
          summary.errors.push(`Notify failed M${match.match_number}: ${e.message}`)
        }
      }

      await sb.from('matches').update(update).eq('id', match.id)
    } catch (e: any) {
      summary.errors.push(`M${match.match_number}: ${e.message}`)
      console.error(`[check-toss] Failed for M${match.match_number}:`, e.message)
    }
  }

  console.log('[check-toss] Done:', summary)
  return new Response(JSON.stringify(summary), { status: 200, headers: { 'Content-Type': 'application/json' } })
})
