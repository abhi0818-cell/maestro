/**
 * scrape-scorecard — Supabase Edge Function
 *
 * Fetches a live match scorecard from CricketAddictor (primary) or
 * Business Standard (fallback), resolves player names against the
 * tournament roster, writes player_match_stats, then distributes
 * raw_points to user_match_xi_scores so users see near-live fantasy totals.
 *
 * Triggered by:
 *   - pg_cron every 15 min (body: {})               → scrapes all live matches
 *   - Admin "Scrape Now" button (body: {matchId})    → scrapes one match
 *
 * Required env vars (set in Supabase dashboard → Settings → Edge Functions):
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
// Canonical scoring math + rules resolution — see that file's header. This
// replaces what used to be an independently-maintained copy here (its own
// calcBatting/calcBowling/calcFielding, a DEFAULT_T20_RULES whose
// sr_70_to_100 had drifted to -4 vs -2 everywhere else, and — the bigger
// one — an automatic cron cascade that only ever applied tournament-level
// rules, never a squad's own contest-level custom scoring_rules, unlike the
// browser's manual Finalize/Recalc path and poll-cricapi's cron).
import {
  DEFAULT_RULES, resolveEffectiveRules, parseOversToBalls,
  calcBattingPoints, calcBowlingPoints, calcFieldingPoints,
} from '../../../scoringEngine.shared.js'

const SUPABASE_URL             = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

// Browser (admin "Scrape Now" button) calls this directly, so it needs CORS
// headers just like cricapi-proxy — otherwise the POST is blocked client-side
// before the response ever reaches the page ("Load failed" / "Failed to fetch").
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

// ─── Slug / URL helpers ───────────────────────────────────────────────────────

function toSlug(s: string): string {
  return s.toLowerCase().trim()
    .replace(/['']/g, '')                 // CricketAddictor drops apostrophes entirely ("Women's" → "womens")
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}

/** Strip a trailing women's-team marker ("-w" / "-women") so our slugs line up
 *  with CricketAddictor's convention of using the plain country/club code even
 *  inside a women's tournament (e.g. our "NZ-W" → their "nz"). */
function stripGenderSuffix(slug: string): string {
  return slug.replace(/-(?:women|w)$/i, '')
}

/** Strip connector words ("and", "of", "the") that CricketAddictor's own
 *  slugs typically omit even when our stored team name spells them out —
 *  e.g. our "St Kitts and Nevis Patriots" → toSlug() → "st-kitts-and-nevis-
 *  patriots", but CricketAddictor's real slug is "st-kitts-nevis-patriots"
 *  (the connector is dropped, not spelled out). Only strips whole
 *  hyphen-delimited tokens, never mid-word, so it's safe for names that
 *  don't contain these as standalone words. */
function stripConnectorWords(slug: string): string {
  return slug
    .split('-')
    .filter(tok => tok !== 'and' && tok !== 'of' && tok !== 'the')
    .join('-')
}

/** Map of short country codes (as stored in our `teams.name`, e.g. "NZ" in
 *  "NZ-W") to the full country slug CricketAddictor actually uses in its
 *  URLs. Needed because ICC-tournament URLs (e.g. the Women's T20 World Cup)
 *  use the full country name — optionally plus "-women" — rather than the
 *  bare 2-3 letter code our DB stores (our "NZ-W" → their
 *  "new-zealand-women", not "nz"). */
const COUNTRY_CODE_TO_SLUG: Record<string, string> = {
  nz: 'new-zealand', sl: 'sri-lanka', ind: 'india', aus: 'australia', eng: 'england',
  pak: 'pakistan', sa: 'south-africa', wi: 'west-indies', ban: 'bangladesh', ire: 'ireland',
  sco: 'scotland', afg: 'afghanistan', zim: 'zimbabwe', usa: 'united-states',
  uae: 'united-arab-emirates', ned: 'netherlands', nam: 'namibia', png: 'papua-new-guinea',
  can: 'canada', nep: 'nepal', oma: 'oman', qat: 'qatar', ken: 'kenya', hk: 'hong-kong',
  jer: 'jersey', ber: 'bermuda', tha: 'thailand', vct: 'vanuatu',
  // Major League Cricket franchise codes (our DB short codes, per MLC SQUAD.csv)
  // → CricketAddictor's full franchise-name slugs. Without these, discoverUrl()
  // guesses URLs like "mny-vs-lakr-..." which never exist — CricketAddictor uses
  // full franchise names (e.g. "mi-new-york-vs-los-angeles-knight-riders-...").
  // This is why MLC scorecard discovery has failed outright rather than being a
  // CricketAddictor coverage gap or outage; confirmed against live MLC 2026 URLs.
  lakr: 'los-angeles-knight-riders', tsk: 'texas-super-kings',
  sfu: 'san-francisco-unicorns', mny: 'mi-new-york',
  so: 'seattle-orcas', wf: 'washington-freedom',
}

/** Expand a short team-code slug (e.g. "nz-w", "nz") into the full slug
 *  CricketAddictor uses (e.g. "new-zealand-women", "new-zealand"). Returns
 *  null when the slug isn't a recognized short code (e.g. it's already a
 *  full name), so callers can fall back to the existing candidates. */
function expandTeamSlug(slug: string): string | null {
  const isWomen = /-(?:women|w)$/i.test(slug)
  const bare    = stripGenderSuffix(slug)
  const full    = COUNTRY_CODE_TO_SLUG[bare]
  if (!full) return null
  return isWomen ? `${full}-women` : full
}

/** Every plausible slug form for one team, in preference order: the
 *  country-code expansion (if any), the bare gender-stripped slug as-is, and
 *  the connector-stripped ("and"/"of"/"the" removed) slug. We can't know in
 *  advance whether CricketAddictor keeps or drops connector words for a given
 *  team name — it keeps them for some ("Antigua and Barbuda Falcons" →
 *  antigua-and-barbuda-falcons) and drops them for others ("St Kitts and
 *  Nevis Patriots" → st-kitts-nevis-patriots) — so anything that matches
 *  against a single guessed form (as this used to) can silently miss a match
 *  that's sitting right there on the listing page. Callers should check a
 *  slug against ALL of these, not just one. */
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

/** Convert match_type DB value → CricketAddictor URL slug fragment(s) to try.
 *  Different series use different conventions for ordinary (non-knockout)
 *  matches — some use plain "match-7" (e.g. ICC World Cups), others use the
 *  ordinal form "7th-match" (e.g. several domestic First Class series) — so we
 *  try both rather than assuming one. */
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

// ─── Listing-page scan (team + start-time + tournament matching) ─────────────
// CricketAddictor's live / upcoming / recent listing pages already contain the
// real scorecard hrefs. Rather than only guessing a slug, we parse these
// listings and score each entry by: team-code containment (gender-suffix
// tolerant), proximity of the listed kickoff time to our match.start_time, and
// how many tournament-name keywords appear near the entry. This is far more
// robust than slug-guessing alone whenever a tournament's real slug doesn't
// exactly mirror our `teams.name` / `tournaments.name` values.

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
    // The team2 slug ends where the match-number / match-type segment begins.
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

// Cache parsed listing pages for the lifetime of one Edge Function invocation —
// a single cron run processes every live match, so this avoids re-fetching the
// same listing page once per match.
const listingCache = new Map<string, ListingMatch[]>()

async function getListing(url: string): Promise<ListingMatch[]> {
  if (listingCache.has(url)) return listingCache.get(url)!
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SuperSelector/1.0)' } })
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
  const pages = [
    'https://cricketaddictor.com/livescore/',
    'https://cricketaddictor.com/livescore/upcoming-matches/',
    'https://cricketaddictor.com/livescore/recent-matches/',
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
          if (diffHrs <= 48) score += (48 - diffHrs) / 48   // closer kickoff time → higher score
        }
      }
      const ctxLower = lm.contextText.toLowerCase()
      score += tWords.filter(w => ctxLower.includes(w)).length * 0.5  // tournament-name keyword overlap

      if (!best || score > best.score) best = { url: lm.baseUrl + 'scorecard/', score }
    }
  }
  return best ? best.url : null
}

/**
 * Try to discover the CricketAddictor scorecard URL for a match.
 * 1. Construct candidate URLs from slugs — both team orderings, both
 *    gender-suffix forms, and both match-number formats ("match-7" /
 *    "7th-match") — and HEAD-check each.
 * 2. Scan live / upcoming / recent listing pages, matching by team codes plus
 *    start-time and tournament-name proximity as tie-breakers.
 * 3. Last resort: regex-scan recent-matches for a link containing both team
 *    slugs, trying every plausible slug variant (country-code expansion,
 *    bare, connector-stripped) for each team.
 */
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

  // Try the full-country-name expansion first — it's the correct form for
  // ICC tournaments (and most others) when our team slug is a short code.
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
      const r = await fetch(url, {
        method: 'HEAD',
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SuperSelector/1.0)' },
      })
      if (r.ok) return url
    } catch { /* try next */ }
  }

  // Listing-page scan: match by team codes + start-time + tournament proximity.
  // Check every plausible slug form (country-code expansion, bare, and
  // connector-stripped) for each team, since we can't know in advance whether
  // CricketAddictor keeps or drops "and"/"of"/"the" for THIS team's slug —
  // it keeps them for some (e.g. "Antigua and Barbuda Falcons" →
  // antigua-and-barbuda-falcons) and drops them for others (e.g. "St Kitts
  // and Nevis Patriots" → st-kitts-nevis-patriots). Committing to only one
  // guessed form here used to mean a live, listed match could still come
  // back url_not_found if we guessed the wrong one.
  const t1Variants = teamSlugVariants(t1Full ? stripGenderSuffix(t1Full) : null, t1Bare, t1Nc)
  const t2Variants = teamSlugVariants(t2Full ? stripGenderSuffix(t2Full) : null, t2Bare, t2Nc)
  const scanned = await scanListingsForMatch(t1Variants, t2Variants, startTime, tournamentName)
  if (scanned) return scanned

  // Last-resort fallback: substring scan, same reasoning as above — try every
  // slug variant for each team rather than committing to one.
  const t1Alt = t1Variants.join('|')
  const t2Alt = t2Variants.join('|')
  try {
    const r = await fetch('https://cricketaddictor.com/livescore/recent-matches/', {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SuperSelector/1.0)' },
    })
    if (r.ok) {
      const html = await r.text()
      const re = new RegExp(
        `href="(https://cricketaddictor\\.com/livescore/[^"]*(?:(?:${t1Alt})[^"]*(?:${t2Alt})|(?:${t2Alt})[^"]*(?:${t1Alt}))[^"]*scorecard/)"`,
        'i',
      )
      const m = html.match(re)
      if (m) return m[1]
    }
  } catch { /* continue to null */ }

  return null
}

// ─── HTML parsers ─────────────────────────────────────────────────────────────

interface BatRow  {
  name: string; runs: number; balls: number; fours: number; sixes: number; dismissed: boolean
  // Raw dismissal description as it appears next to the batter's name, e.g.
  // "c A Fletcher b A Russell", "runout (A Fletcher / M Tromp)", "b SC van Schalkwyk".
  // null when not out. This is the same text poll-cricapi gets handed already-split
  // out by CricAPI's JSON — here we have to lift it out of the HTML ourselves, see
  // parseCricketAddictor/parseBusinessStandard below. Used to auto-derive fielding
  // credit (catches/stumpings/run-outs) and bowler wicketTypes (for the lbw/bowled
  // bonus) instead of leaving fielding null and wicketTypes empty for every
  // scraper-sourced match, as before.
  dismissalText: string | null
}
interface BowlRow { name: string; overs: number; runs: number; wickets: number; maidens: number; dots: number }
interface Innings { teamName: string; batting: BatRow[]; bowling: BowlRow[] }

function stripTags(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ').trim()
}

function firstLinkText(html: string): string {
  const m = html.match(/<a[^>]*>([^<]+)<\/a>/)
  return m ? m[1].trim() : ''
}

// When a batter's name isn't a hyperlink (common for less-established
// players CricketAddictor hasn't built a profile page for), the old logic
// took just the cell's first whitespace-delimited token as "the name" —
// which breaks the moment a name has more than one word (e.g. "Chemar
// Parris"): the surname is then left stuck as a prefix on the dismissal
// text ("Parris c Jahmar Hamilton b A Joseph"), which fails every
// ^-anchored dismissal regex downstream (parseScrapedDismissal here, and
// its client-side twin index.html's parseDismissalEntry) with no error or
// visible warning — silently dropping the named fielder's credit entirely.
// Instead, search for the EARLIEST known dismissal-text opening
// (word-boundary anchored) and treat everything before it as the name.
const DISMISSAL_START_RE = /\b(not\s*out|run\s*out|runout|hit\s*wicket|c\s*&\s*b|ct\s|c\s|st\s|lbw|b\s)/i

/**
 * @typedef {'linked'|'roster'|'regex'|'first_token'} NameSplitMethod
 *   linked      — name came from an <a> profile link (exact, always reliable)
 *   roster      — matched a known player name from this match's roster (see below)
 *   regex       — fell back to DISMISSAL_START_RE's word-boundary keyword search
 *   first_token — nothing recognizable matched at all; took the first word
 */

/**
 * When a batter's name isn't a hyperlink (common for less-established
 * players the site hasn't built a profile page for), the ONLY signal left to
 * find where the name ends and the dismissal text begins used to be
 * DISMISSAL_START_RE, which requires a word boundary (`\b`) immediately
 * before the matched keyword. That fails silently whenever the site's markup
 * has literally no separator between the name and the dismissal — e.g.
 * "Navin Bidaiseec Joshua Da Silva b Terrance Hinds" (no space before the
 * "c" that starts "c Joshua..."): there's no boundary there, so the regex
 * skips past it and matches the LATER "b Terrance Hinds" instead, producing
 * a garbled name that fails roster matching (shows up as an "unmatched"
 * player in Review) and silently drops the fielder's catch credit, since the
 * text naming the fielder became part of the mangled "name" instead of the
 * dismissal text.
 *
 * Matching against the match's own roster sidesteps the boundary problem
 * entirely — we don't need a separator if we already know what the name is.
 * This is tried BEFORE the regex fallback whenever a roster is available;
 * the regex/first-token tiers remain as a last resort for names not on the
 * roster (imports lagging the actual squad, spelling variants, etc.).
 *
 * @param strippedCell - the batting cell's plain text (name + dismissal, tags stripped)
 * @param linkedName - the name from an <a> tag, if the site linked this player
 * @param knownNames - every player name on the two teams in this match, for roster-prefix matching
 */
function splitNameAndDismissal(
  strippedCell: string,
  linkedName: string,
  knownNames: string[] = [],
): { name: string; afterName: string; method: string } {
  if (linkedName) {
    // Full name already known from the <a> link — just peel it off the front.
    return strippedCell.startsWith(linkedName)
      ? { name: linkedName, afterName: strippedCell.slice(linkedName.length).trim(), method: 'linked' }
      : { name: linkedName, afterName: strippedCell.replace(linkedName, '').trim(), method: 'linked' }
  }

  if (knownNames.length) {
    const lowerCell = strippedCell.toLowerCase()
    let best: string | null = null
    for (const known of knownNames) {
      if (!known) continue
      if (lowerCell.startsWith(known.toLowerCase()) && (!best || known.length > best.length)) {
        best = known // prefer the longest match, e.g. "Chris Gayle" over "Chris"
      }
    }
    if (best) {
      return { name: best, afterName: strippedCell.slice(best.length).trim(), method: 'roster' }
    }
  }

  const m = strippedCell.match(DISMISSAL_START_RE)
  if (m && m.index !== undefined && m.index > 0) {
    return { name: strippedCell.slice(0, m.index).trim(), afterName: strippedCell.slice(m.index).trim(), method: 'regex' }
  }
  // No recognizable dismissal keyword found at all — fall back to the old
  // first-token heuristic rather than guessing further (e.g. a genuinely
  // unrecognized format, or an empty cell).
  const fallbackName = strippedCell.split(' ')[0]
  return {
    name: fallbackName,
    afterName: strippedCell.startsWith(fallbackName)
      ? strippedCell.slice(fallbackName.length).trim()
      : strippedCell.replace(fallbackName, '').trim(),
    method: 'first_token',
  }
}

function parseTables(html: string): string[] {
  const tables: string[] = []
  const re = /<table[\s\S]*?<\/table>/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null) tables.push(m[0])
  return tables
}

function parseRows(tableHtml: string): string[][] {
  const rows: string[][] = []
  const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi
  let rowM: RegExpExecArray | null
  let first = true
  while ((rowM = rowRe.exec(tableHtml)) !== null) {
    if (first) { first = false; continue } // skip header
    const cells: string[] = []
    const cellRe = /<td[^>]*>([\s\S]*?)<\/td>/gi
    let cellM: RegExpExecArray | null
    while ((cellM = cellRe.exec(rowM[1])) !== null) cells.push(cellM[1])
    if (cells.length) rows.push(cells)
  }
  return rows
}

/** Parse CricketAddictor scorecard HTML */
function parseCricketAddictor(html: string, knownNames: string[] = []): Innings[] {
  const innings: Innings[] = []
  // QA signal: every batting row whose name didn't come from a clean <a>
  // link (roster-matched, regex-guessed, or first-token-guessed). Attached
  // to the return value below so the caller can log/report it even when the
  // guess turned out fine — this is what makes the "name+dismissal glued
  // together" failure class visible in Function Logs instead of only ever
  // showing up (if at all) as a confusing garbled name in Review.
  const nameSplitFallbacks: { teamName: string; raw: string; resolvedName: string; method: string }[] = []
  // Innings sections are delimited by <h2> headers containing "Inning" —
  // but the live markup wraps the score in nested tags (e.g. a <span>),
  // so we can't require the whole <h2> body to be plain text. Instead,
  // capture each <h2>...</h2> block in full (allowing nested markup) and
  // strip tags before testing for "Inning".
  const h2Re = /<h2[^>]*>([\s\S]*?)<\/h2>/gi
  const headers: { teamName: string; start: number }[] = []
  let h2m: RegExpExecArray | null
  while ((h2m = h2Re.exec(html)) !== null) {
    const text = stripTags(h2m[1])
    if (!/Inning/i.test(text)) continue
    headers.push({ teamName: text.replace(/\s+Inning.*$/i, '').trim(), start: h2Re.lastIndex })
  }

  for (let i = 0; i < headers.length; i++) {
    const { teamName, start } = headers[i]
    let end = i + 1 < headers.length ? html.indexOf('<h2', start) : html.length
    if (end === -1) end = html.length
    // Stop early at a "Match Info" heading too, in case it follows the last
    // innings section before any further <h2> (there usually isn't one).
    const miMatch = html.slice(start, end).match(/<h3[^>]*>[\s\S]{0,60}?Match Info/i)
    if (miMatch) end = start + miMatch.index!

    const body   = html.slice(start, end)
    const tables = parseTables(body)

    // ── Batting (first table) ──
    const batting: BatRow[] = []
    if (tables[0]) {
      for (const cells of parseRows(tables[0])) {
        if (cells.length < 6) continue
        const nameHtml  = cells[0]
        // The dismissal text lives in the same cell, after the name and a small
        // arrow-icon <img> (e.g. "Lhuan-dre Pretorius [icon] c A Fletcher b A
        // Russell" or "Hammad Azam Not out"). Strip the whole cell to plain text,
        // then peel the name back off the front to leave just the dismissal part
        // — see splitNameAndDismissal() for why this isn't just "first word".
        const strippedCell = stripTags(nameHtml)
        const { name, afterName, method } = splitNameAndDismissal(strippedCell, firstLinkText(nameHtml), knownNames)
        if (!name) continue
        if (method !== 'linked') {
          nameSplitFallbacks.push({ teamName, raw: strippedCell, resolvedName: name, method })
        }
        const notOut    = afterName === '' || /^not\s*out/i.test(afterName)
        const dismissed = !notOut
        batting.push({
          name,
          runs:      parseInt(stripTags(cells[1]), 10) || 0,
          balls:     parseInt(stripTags(cells[2]), 10) || 0,
          fours:     parseInt(stripTags(cells[3]), 10) || 0,
          sixes:     parseInt(stripTags(cells[4]), 10) || 0,
          dismissed,
          dismissalText: notOut ? null : afterName,
        })
      }
    }

    // ── Bowling (second table) — columns: Bowling, O, R, W, ECO, Dots ──
    const bowling: BowlRow[] = []
    if (tables[1]) {
      for (const cells of parseRows(tables[1])) {
        if (cells.length < 4) continue
        const name = firstLinkText(cells[0]) || stripTags(cells[0])
        if (!name) continue
        bowling.push({
          name,
          overs:   parseFloat(stripTags(cells[1])) || 0,
          runs:    parseInt(stripTags(cells[2]), 10) || 0,
          wickets: parseInt(stripTags(cells[3]), 10) || 0,
          maidens: 0,  // CA doesn't show maidens
          dots:    parseInt(stripTags(cells[5] ?? ''), 10) || 0,
        })
      }
    }

    if (batting.length || bowling.length) innings.push({ teamName, batting, bowling })
  }
  ;(innings as any).nameSplitFallbacks = nameSplitFallbacks
  return innings
}

/** Parse Business Standard scorecard HTML */
function parseBusinessStandard(html: string): Innings[] {
  const innings: Innings[] = []
  // BS uses <h4> with "Inning" in text
  const sectionRe = /<h4[^>]*>([^<]*(?:Inning|Innings)[^<]*)<\/h4>([\s\S]*?)(?=<h4|$)/gi
  let sec: RegExpExecArray | null
  while ((sec = sectionRe.exec(html)) !== null) {
    const teamName = sec[1].replace(/\s+Inning.*$/i, '').trim()
    const body     = sec[2]
    const tables   = parseTables(body)

    // ── Batting ──
    const batting: BatRow[] = []
    if (tables[0]) {
      for (const cells of parseRows(tables[0])) {
        if (cells.length < 6) continue
        const raw  = stripTags(cells[0])
        // BS puts name and dismissal in same cell separated by whitespace
        const rawParts   = raw.split(/\s{2,}/)
        const name       = rawParts[0].trim()
        const dismissalRaw = (rawParts[1] ?? '').trim()
        if (!name || name === 'Extras' || name === 'Total' || name === 'Yet to Bat') continue
        const notOut = dismissalRaw === '' || /^not\s*out/i.test(dismissalRaw)
        batting.push({
          name,
          runs:      parseInt(stripTags(cells[1]), 10) || 0,
          balls:     parseInt(stripTags(cells[2]), 10) || 0,
          fours:     parseInt(stripTags(cells[3]), 10) || 0,
          sixes:     parseInt(stripTags(cells[4]), 10) || 0,
          dismissed: !notOut,
          dismissalText: notOut ? null : dismissalRaw,
        })
      }
    }

    // ── Bowling — columns: Bowler, O, M, R, W, NB, WD, ECO ──
    const bowling: BowlRow[] = []
    if (tables[1]) {
      for (const cells of parseRows(tables[1])) {
        if (cells.length < 5) continue
        const name = stripTags(cells[0]).trim()
        if (!name) continue
        bowling.push({
          name,
          overs:   parseFloat(stripTags(cells[1])) || 0,
          maidens: parseInt(stripTags(cells[2]), 10) || 0,
          runs:    parseInt(stripTags(cells[3]), 10) || 0,
          wickets: parseInt(stripTags(cells[4]), 10) || 0,
          dots:    0,
        })
      }
    }

    if (batting.length || bowling.length) innings.push({ teamName, batting, bowling })
  }
  return innings
}

// Format's regulation overs, for corroborating a weak completion signal
// against the last parsed innings (see lastInningsLooksDone() / detectCompletion()
// below). Test has no fixed cap, so it's intentionally absent here — only the
// all-out check applies for that format.
const FORMAT_MAX_OVERS: Record<string, number> = { T20: 20, ODI: 50 }

/** Does the last parsed innings actually look finished — all out, or overs
 *  exhausted for the format? Used to corroborate a weak ("bare badge", no
 *  result-sentence-yet) completion signal before trusting it. */
function lastInningsLooksDone(innings: Innings[], formatKey: string | null | undefined): boolean {
  if (!innings.length) return false
  const last = innings[innings.length - 1]
  const wkts = last.batting.filter(b => b.dismissed).length
  if (wkts >= 10) return true
  const maxOvers = FORMAT_MAX_OVERS[(formatKey ?? 'T20').toUpperCase()]
  if (maxOvers != null) {
    const balls = last.bowling.reduce(
      (sum, b) => sum + (Math.round(b.overs) * 6 + Math.round((b.overs % 1) * 10)),
      0,
    )
    if (balls >= maxOvers * 6 - 1) return true // tolerate the last legal ball
  }
  return false
}

// ─── Match-completion detection ───────────────────────────────────────────────
// Previously only poll-cricapi's matchLifecycle() (driven by CricAPI's
// matchEnded/status fields) could ever flip matches.status to 'completed' — a
// scraper-sourced match just sat at whatever status it already had until an
// admin clicked Finalize, or CricAPI later confirmed it. CricketAddictor's
// pages carry the same signal in plain text: a "LIVE / Match N /" vs
// "COMPLETED / Match N /" badge near the top, and a result line ("X won by Y
// wickets/runs", "Match Tied", "No Result", "Match Abandoned") that replaces
// the live "X need Y runs in Z balls" line once the match actually ends.
function detectCompletion(html: string): { completed: boolean; resultText: string | null; strong: boolean } {
  const text = stripTags(html)
  const badgeMatch = text.match(/\b(LIVE|COMPLETED|UPCOMING)\s*\/\s*Match\b/i)
  const badge = badgeMatch ? badgeMatch[1].toUpperCase() : null
  const resultMatch = text.match(
    /([A-Za-z][A-Za-z .'-]+ won by [\w\s]+?(?:wickets?|wkts?|runs?)(?:\s*\(.*?\))?|Match Tied|Match Drawn|No Result|Match Abandoned)/i,
  )
  return {
    completed : badge === 'COMPLETED' || !!resultMatch,
    resultText: resultMatch ? resultMatch[1].trim() : null,
    // An explicit result sentence is a strong, definitive signal — the page
    // only prints one once the match actually has an outcome. The bare
    // "COMPLETED" badge with no result sentence yet is weaker: the badge and
    // the scorecard table below it are populated by separately-timed feeds,
    // and the badge has been seen to flip before the table actually finishes
    // updating (see lastInningsLooksDone() below for the corroboration this
    // feeds into).
    strong    : !!resultMatch,
  }
}

// ─── Dismissal-text parsing (mirrors poll-cricapi's parseDismissalEntry) ──────
// poll-cricapi gets dismissal type/bowler/fielder already split out as separate
// JSON fields by CricAPI. Scraped HTML only gives us one free-text blob per
// batter (e.g. "c A Fletcher b A Russell", "runout (A Fletcher / M Tromp)",
// "lbw b S Narine", "st U Chand b S Narine", "c & b A Russell", "b SC van
// Schalkwyk"). This is the scraper-side equivalent: same dismissal grammar,
// same regex shapes, just parsing it out of plain text instead of JSON fields.
interface DismissalParse { type: string; bowler: string | null; fielder: string | null; fielder2?: string | null }

function parseScrapedDismissal(raw: string | null): DismissalParse | null {
  if (!raw) return null
  const d = raw.toLowerCase().trim()
  if (!d || d.includes('not out') || d.includes('retired')) return null

  if (/^hit.?wicket/i.test(d)) return { type: 'hit_wicket', bowler: null, fielder: null }
  if (/^run\s*out/.test(d)) {
    const parenMatch = d.match(/run\s*out\s*\(([^)]+)\)/i)
    const parts = parenMatch
      ? parenMatch[1].split(/\s*[/\\&]\s*/).map(n => n.trim()).filter(Boolean)
      : []
    return { type: 'run_out', bowler: null, fielder: parts[0] || null, fielder2: parts[1] || null }
  }

  let m: RegExpMatchArray | null
  if ((m = d.match(/^lbw(?:\s+b\s+(.+))?/)))        return { type: 'lbw',     bowler: (m[1] || '').trim() || null, fielder: null }
  if ((m = d.match(/^c\s*&\s*b\s+(.+)/)))           return { type: 'caught',  bowler: m[1].trim(),                 fielder: m[1].trim() }
  if ((m = d.match(/^c(?:t)?\s+(.+?)\s+b\s+(.+)/))) return { type: 'caught',  bowler: m[2].trim(),                 fielder: m[1].trim() }
  if ((m = d.match(/^st\s+(.+?)\s+b\s+(.+)/)))      return { type: 'stumped', bowler: m[2].trim(),                 fielder: m[1].trim() }
  if ((m = d.match(/^b\s+(.+)/)))                   return { type: 'bowled',  bowler: m[1].trim(),                 fielder: null }
  return null
}

/** Match a dismissal's loosely-written bowler reference (e.g. "A Russell") against
 *  the full names actually listed in that innings's bowling table ("Andre Russell"),
 *  same exact/surname-fallback strategy as poll-cricapi's matchBowlerName. */
function matchBowlerNameInInnings(ref: string | null, candidates: string[]): string | null {
  if (!ref) return null
  const t = ref.toLowerCase().trim()
  const exact = candidates.find(c => c.toLowerCase() === t)
  if (exact) return exact
  const refSurname = t.split(/\s+/).pop()
  if (refSurname) {
    const bySurname = candidates.filter(c => c.toLowerCase().split(/\s+/).pop() === refSurname)
    if (bySurname.length === 1) return bySurname[0]
  }
  return null
}

// ─── Scoring formula (mirrors index.html calcBatting / calcBowling) ───────────
// Rules object shape: { run, boundary4, boundary6, half_century, century, duck,
//   sr_above_170, sr_140_to_170, sr_below_70, sr_70_to_100,
//   wicket, maiden_over, dot_ball, four_wicket_haul, five_wicket_haul,
//   economy_below_5, economy_5_to_6, economy_10_to_11, economy_above_11 }

interface Rules { [key: string]: number }

// Thin wrappers over scoringEngine.shared.js, translating this file's field
// names (balls/dismissed/overs/dots) to the canonical shape
// (ballsFaced/isDismissed/ballsBowled/dotBalls). sr_70_to_100 no longer has
// its own copy here to drift out of sync — DEFAULT_RULES.T20 is canonical's.
function calcBatting(bat: BatRow, role: string, fmt: string, r: Rules): number {
  return calcBattingPoints(
    { runs: bat.runs, ballsFaced: bat.balls, fours: bat.fours, sixes: bat.sixes, isDismissed: bat.dismissed, role },
    fmt, r,
  ).points
}

function calcBowling(bowl: BowlRow, fmt: string, r: Rules): number {
  return calcBowlingPoints(
    { wickets: bowl.wickets, maidens: bowl.maidens, runsConceded: bowl.runs, ballsBowled: parseOversToBalls(bowl.overs), dotBalls: bowl.dots },
    fmt, r,
  ).points
}

interface FieldRow { catches: number; stumpings: number; runOutDirect: number; runOutIndirect: number }

/** Mirrors index.html's calcFielding / poll-cricapi's calcFielding. */
function calcFielding(f: FieldRow, r: Rules): number {
  return calcFieldingPoints(f, r).points
}

/** Mirrors poll-cricapi/cricketScoringEngine.js's lbw_bowled_bonus: a bonus to
 *  the BOWLER (not a fielder) per lbw/bowled wicket, since those dismissal
 *  types involve no fielder credit at all. */
function calcLbwBowledBonus(wicketTypes: string[], r: Rules): number {
  const premium = wicketTypes.filter(t => t === 'lbw' || t === 'bowled').length
  return premium * (r.lbw_bowled_bonus ?? 0)
}

// ─── Name resolution ──────────────────────────────────────────────────────────

interface ResolveResult { playerId: string | null; method: 'exact' | 'alias' | 'fuzzy' | 'unmatched' }

// A source (CricketAddictor / Business Standard) can send a literal
// placeholder instead of a real name when IT can't identify someone. The
// same literal string recurs for different actual players across different
// matches, so it can never be aliased to one specific local player — that's
// exactly how "Player Not Found" ended up permanently (and wrongly) aliased
// to a real player in player_name_aliases. Skip these entirely: never
// fuzzy-alias them, never queue them in scraper_unmatched (where an admin
// could "Map" them to a player by mistake).
const PLACEHOLDER_NAMES = new Set(['player not found'])
function isPlaceholderName(name: string): boolean {
  const norm = name.toLowerCase().trim()
  // "empty" is a broader/prefix check (not an exact-set entry) because this
  // source sends variants like "empty &" rather than one fixed literal.
  return PLACEHOLDER_NAMES.has(norm) || norm.startsWith('empty')
}

// Last-name / initials fuzzy tier, shared by resolvePlayerName and
// resolveFielderName so ambiguity detection is consistent across both
// (returns EVERY roster player_id that plausibly matches, not just the
// first one found — callers decide what to do with more than one).
function fuzzyMatchCandidates(norm: string, exactMap: Map<string, string>): string[] {
  const lastName = norm.split(' ').pop()!
  const lastNameHits = new Set<string>()
  for (const [pName, pId] of exactMap) {
    if (pName.split(' ').pop() === lastName) lastNameHits.add(pId)
  }
  if (lastNameHits.size) return [...lastNameHits]

  // Initials match, e.g. "V Kohli" vs "Virat Kohli"
  const parts = norm.split(' ')
  if (parts.length === 2 && parts[0].length === 1) {
    const initial   = parts[0]
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

function resolvePlayerName(
  name: string,
  exactMap: Map<string, string>,  // normalised full name → player_id
  aliasMap: Map<string, string>,  // alias → player_id
): ResolveResult {
  const norm = name.toLowerCase().trim()

  if (exactMap.has(norm)) return { playerId: exactMap.get(norm)!, method: 'exact' }

  // Check for ambiguity BEFORE trusting a saved alias. An alias was only
  // ever verified once (by an earlier fuzzy match or a manual admin pick) —
  // if the raw text could currently match more than one rostered player
  // (e.g. two same-surname teammates), blindly trusting the old alias risks
  // silently crediting the wrong one forever. Surface it as unmatched
  // instead, same as if no alias existed yet.
  const candidates = fuzzyMatchCandidates(norm, exactMap)
  if (candidates.length > 1) return { playerId: null, method: 'unmatched' }

  if (aliasMap.has(norm)) return { playerId: aliasMap.get(norm)!, method: 'alias' }
  if (candidates.length === 1) return { playerId: candidates[0], method: 'fuzzy' }

  return { playerId: null, method: 'unmatched' }
}

interface FielderResolveResult { playerId: string | null; candidates: string[] | null }

/**
 * Resolve a raw fielder/bowler-credit name (e.g. "A Fletcher") to exactly one
 * player_id, checked against the full roster of BOTH teams playing this
 * match (exactMap keys — scoped to just those two teams, not the whole
 * tournament, see step 4 above) — not just whoever batted/bowled in this
 * match — so that two squad members sharing a surname (e.g. sisters) are
 * correctly flagged as ambiguous instead of one of them silently absorbing
 * the other's fielding credit. Mirrors index.html's resolveFielder, which
 * was fixed for exactly this bug (see migration history: "Bryce sisters"
 * ambiguity fix).
 *
 * Tiers, in order: exact full-name match → roster name ends with " <norm>"
 * (raw is a surname or "Initial Surname") → norm ends with " <roster surname>"
 * (raw has a longer/different first name than the roster entry). Ambiguity is
 * checked within EACH tier before falling through to the next.
 */
function resolveFielderName(
  raw: string,
  exactMap: Map<string, string>,  // norm full name → player_id (full roster)
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
    // roster now has more than one name in this tier (e.g. two same-surname
    // teammates), don't let a stale alias silently pick one. Surface it as
    // ambiguous instead, same as if no alias existed yet.
    if (distinct.length > 1) return { playerId: null, candidates: distinct }
    if (aliasMap.has(norm)) return { playerId: aliasMap.get(norm)!, candidates: null }
    return { playerId: exactMap.get(distinct[0])!, candidates: null }
  }

  // No fuzzy tier matched at all — fall back to a saved alias if we have one
  // (covers names that don't cleanly fuzzy-match syntactically, e.g. a
  // nickname or a differently-formatted name).
  if (aliasMap.has(norm)) return { playerId: aliasMap.get(norm)!, candidates: null }

  return { playerId: null, candidates: null }
}

// ─── XI scoring distribution ─────────────────────────────────────────────────
//
// Multiplier logic mirrors poll-cricapi's captaincyMultiplier/boosterMultiplier
// (MULTIPLIERS: captain=2, triple_captain=3, vice_captain=1.5, normal=1, plus
// team_double/os_double/indian_double). This function used to hardcode
// captain=2x/vc=1.5x and never looked at user_booster_activations at all, so
// any squad running triple_captain (or dual_captain / the *_double boosters)
// would still be scored/stored as a plain 2x whenever the scraper (rather than
// poll-cricapi) was the one to write user_match_xi_scores for that match —
// silently clobbering the correct multiplier on the very next scrape.
const XI_MULTIPLIERS: Record<string, number> = { captain: 2, triple_captain: 3, vice_captain: 1.5, normal: 1 }

function xiCaptaincyMultiplier(captaincy: 'captain' | 'vice_captain' | 'normal', booster: string | null): number {
  const key = (booster === 'triple_captain' && captaincy === 'captain') ? 'triple_captain'
    : (booster === 'dual_captain' && captaincy === 'vice_captain') ? 'captain'
      : captaincy
  return XI_MULTIPLIERS[key] ?? 1
}
function xiBoosterMultiplier(booster: string | null, isOverseas: boolean): number {
  if (booster === 'team_double') return 2
  if (booster === 'os_double' && isOverseas) return 2
  if (booster === 'indian_double' && !isOverseas) return 2
  return 1
}

/**
 * THE FIX: this used to take a flat `pointsMap` (one number per player,
 * computed from TOURNAMENT-level rules only) and apply it to every squad's
 * XI regardless of which contest they're in — so a Season League squad
 * sitting in a private league with its own custom scoring_rules got wrong
 * automatic (cron) scores, correct only after an admin manually re-ran
 * Finalize in the browser (which does resolve contest-level rules). Now
 * mirrors poll-cricapi's scoreSLForMatch / admin.js's
 * computeAndSaveSLScoresForMatch: resolve each squad's contest, and where a
 * contest has its own scoring_rules for this format, re-derive that squad's
 * points from the player's raw batting/bowling/fielding stats using the
 * contest's effective rules instead of the tournament-level total.
 */
async function scoreXIForMatch(
  matchId: string,
  tournament: any,
  fmt: string,
  statsByPlayer: Map<string, { batting?: any; bowling?: any; fielding?: FieldRow; rawPoints: number }>,
) {
  // Get all locked XIs for this match
  const { data: xiRows, error } = await sb
    .from('user_match_xi')
    .select('squad_id, player_id, is_captain, is_vc')
    .eq('match_id', matchId)

  if (error || !xiRows?.length) return

  // Active boosters for every squad in this match, one query (mirrors
  // poll-cricapi's scoreSLForMatch / getAllBoostersForMatch).
  const { data: boosterRows } = await sb
    .from('user_booster_activations')
    .select('squad_id, booster')
    .eq('match_id', matchId)
  const boosterMap = new Map<string, string>()
  for (const b of boosterRows ?? []) boosterMap.set(b.squad_id, b.booster)

  // Overseas flag + role per player — role is needed for the duck-penalty
  // role check when re-scoring from raw stats under custom contest rules.
  const playerIds = Array.from(new Set(xiRows.map((r: any) => r.player_id)))
  const { data: playerRows } = await sb.from('players').select('id, is_overseas, role').in('id', playerIds)
  const overseasMap = new Map<string, boolean>()
  const roleMap = new Map<string, string>()
  for (const p of playerRows ?? []) {
    overseasMap.set(p.id, !!p.is_overseas)
    roleMap.set(p.id, p.role ?? 'bat')
  }

  // Squad → contest → contest's effective rules (only populated when the
  // contest actually has its own scoring_rules for this format — squads in
  // Daily-style or default-rules contests fall through to the tournament
  // total below, same as before).
  const squadIds = Array.from(new Set(xiRows.map((r: any) => r.squad_id)))
  const { data: squadRows } = await sb.from('user_squads').select('id, contest_id').in('id', squadIds)
  const contestIdBySquad = new Map<string, string>()
  for (const s of squadRows ?? []) if (s.contest_id) contestIdBySquad.set(s.id, s.contest_id)

  const contestIds = Array.from(new Set(contestIdBySquad.values()))
  const rulesByContest = new Map<string, Rules | null>()
  if (contestIds.length) {
    const { data: contests } = await sb.from('contests').select('id, scoring_rules').in('id', contestIds)
    for (const c of contests ?? []) {
      rulesByContest.set(c.id, c.scoring_rules?.[fmt] ? resolveEffectiveRules(tournament, c, fmt) : null)
    }
  }

  const scoreRows = xiRows.map((xi: any) => {
    const contestId   = contestIdBySquad.get(xi.squad_id)
    const customRules = contestId ? (rulesByContest.get(contestId) ?? null) : null
    const s           = statsByPlayer.get(xi.player_id)

    const raw = (customRules && s)
      ? (
          (s.batting  ? calcBattingPoints({ ...s.batting, role: roleMap.get(xi.player_id) ?? 'bat' }, fmt, customRules).points : 0) +
          (s.bowling  ? calcBowlingPoints(s.bowling, fmt, customRules).points : 0) +
          (s.fielding ? calcFieldingPoints(s.fielding, customRules).points : 0)
        )
      : (s?.rawPoints ?? 0)

    const booster   = boosterMap.get(xi.squad_id) ?? null
    const captaincy: 'captain' | 'vice_captain' | 'normal' = xi.is_captain ? 'captain' : xi.is_vc ? 'vice_captain' : 'normal'
    const isOverseas = overseasMap.get(xi.player_id) ?? false
    const mult = xiCaptaincyMultiplier(captaincy, booster) * xiBoosterMultiplier(booster, isOverseas)
    return {
      squad_id    : xi.squad_id,
      match_id    : matchId,
      player_id   : xi.player_id,
      base_points : Math.round(raw * 10) / 10,
      multiplier  : mult,
      total_points: Math.round(raw * mult * 10) / 10,
      computed_at : new Date().toISOString(),
    }
  })

  const CHUNK = 100
  for (let i = 0; i < scoreRows.length; i += CHUNK) {
    await sb.from('user_match_xi_scores').upsert(
      scoreRows.slice(i, i + CHUNK),
      { onConflict: 'squad_id,match_id,player_id' },
    )
  }
}

// ─── Daily XI (ad-hoc one-off teams) scoring distribution ───────────────────
//
// Daily teams live in user_teams (squad_id IS NULL) + user_team_players, and
// their totals are stored in user_team_match_scores. Previously this table was
// only ever updated by an admin-triggered client-side recompute; this mirrors
// that same captain/VC multiplier logic so the cron scraper keeps Daily XI
// leaderboards live, the same way it already does for Season Long squads.

async function scoreDailyTeamsForMatch(matchId: string, pointsMap: Map<string, number>) {
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
    return {
      user_team_id: t.id,
      match_id    : matchId,
      total_points: Math.round(total * 10) / 10,
      computed_at : new Date().toISOString(),
    }
  })

  const CHUNK = 100
  for (let i = 0; i < scoreRows.length; i += CHUNK) {
    await sb.from('user_team_match_scores').upsert(
      scoreRows.slice(i, i + CHUNK),
      { onConflict: 'user_team_id,match_id' },
    )
  }
  return scoreRows.length
}

// ─── Main handler ─────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS })
  }
  try {
    const body     = await req.json().catch(() => ({})) as { matchId?: string }
    const matchId  = body.matchId ?? null

    // A match is considered "in play" when its start_time has passed and it is
    // neither completed nor delayed.  Admin does NOT need to manually flip status
    // to 'live' — the scraper treats past-start-time as implicitly live.
    const nowDate = new Date()
    const now     = nowDate.toISOString()

    // Cron calls only consider matches whose start_time is at least 5 minutes
    // in the past — gives the official scorecard page a few minutes to
    // actually populate before the scraper's first attempt. Manual "Scrape
    // Now" (matchId provided) is unaffected — the admin is explicitly asking
    // right now, regardless of how recently the match started.
    const cutoff = matchId ? now : new Date(nowDate.getTime() - 5 * 60 * 1000).toISOString()

    let query = sb
      .from('matches')
      .select(`
        id, match_number, match_type, format, status, scorecard_url, tournament_id, start_time, data_source,
        progress_innings, progress_balls,
        home_team:teams!home_team_id(id, name),
        away_team:teams!away_team_id(id, name),
        tournament:tournaments!tournament_id(id, name, scraper_enabled, scoring_rules, dot_ball_enabled)
      `)
      .lte('start_time', cutoff)

    // Cron runs (no matchId) must never touch a match once it's completed/
    // delayed — that exclusion is what protects post-completion admin
    // corrections from being clobbered by the next unattended run. A manual
    // "Scrape Now" (matchId provided) bypasses it: the admin is explicitly
    // asking to re-scrape THIS match regardless of its current status — e.g.
    // to top up stats after the staleness guard forced a completion flip off
    // an incomplete last-trusted read. Without this, Scrape Now on an
    // already-'completed' match silently returns "no live matches" and can
    // never be used to fix it.
    if (!matchId) query = query.not('status', 'in', '("completed","delayed")')
    if (matchId) query = query.eq('id', matchId)

    // No DB-level scraper_enabled filter here — mirrors poll-cricapi's
    // reasoning: eligibility also depends on matches.data_source (a per-match
    // override), which can't be expressed as one PostgREST filter alongside
    // the joined tournament flag. Filtered in JS below instead.
    const { data: matches, error: mErr } = await query
    if (mErr) throw mErr

    // Manual scrapes (matchId provided) bypass all source gating — the admin
    // is explicitly asking to scrape this match regardless of its tournament
    // default or its own data_source override.
    //
    // Otherwise (cron call): data_source='scraper' forces this match onto the
    // scraper even if its tournament defaults to CricAPI; data_source=
    // 'cricapi' forces it away from the scraper even if the tournament
    // defaults here (poll-cricapi's cron owns it instead); data_source='auto'
    // (or unset) falls back to the tournament-wide scraper_enabled flag, same
    // behaviour as before this override existed.
    const liveMatches = (matches ?? []).filter((m: any) => {
      if (matchId) return true
      const src = m.data_source || 'auto'
      if (src === 'cricapi') return false
      if (src === 'scraper') return true
      return m.tournament?.scraper_enabled === true
    })

    if (!liveMatches.length) {
      return new Response(
        JSON.stringify({ ok: true, message: 'No live matches with scraper enabled' }),
        { status: 200, headers: { ...CORS, 'Content-Type': 'application/json' } },
      )
    }

    const results = []

    for (const match of liveMatches) {
      const tournament = match.tournament as any
      const homeTeam   = (match.home_team as any)?.name ?? ''
      const awayTeam   = (match.away_team as any)?.name ?? ''
      const fmt        = match.format ?? 'T20'

      // ── 1. Discover / use cached URL ──────────────────────────────────────
      // A manual "Scrape Now" (matchId provided) always re-discovers — the
      // admin is explicitly retrying, often *because* a previously cached
      // URL was wrong, so reusing that same cached URL here would silently
      // repeat the same failure forever.
      let url: string | null = matchId ? null : (match.scorecard_url ?? null)

      if (!url) {
        url = await discoverUrl(
          homeTeam, awayTeam, match.match_type, match.match_number,
          tournament.name, (match as any).start_time ?? null,
        )
        if (url) {
          await sb.from('matches').update({ scorecard_url: url }).eq('id', match.id)
        }
      }

      if (!url) {
        results.push({ matchId: match.id, status: 'url_not_found', fallback: 'cricapi' })
        continue
      }

      // ── 2. Fetch HTML ──────────────────────────────────────────────────────
      let html: string
      let source: 'cricketaddictor' | 'business_standard'

      try {
        // Cache-bust: confirmed live that cricketaddictor's CDN serves a
        // frozen/stale edge copy of the bare scorecard URL (seen stuck on an
        // in-progress snapshot well after the real match had finished), while
        // the exact same URL with any query string appended returns the
        // current page. Without this, a match can get permanently stuck
        // mid-innings no matter how many times we re-fetch.
        const fetchUrl = url + (url.includes('?') ? '&' : '?') + '_cb=' + Date.now()
        const res = await fetch(fetchUrl, {
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SuperSelector/1.0)' },
        })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        html   = await res.text()
        source = url.includes('cricketaddictor') ? 'cricketaddictor' : 'business_standard'
      } catch (e) {
        // Clear the cached URL — it may be stale/wrong, so the next attempt
        // (cron or manual) re-runs discovery instead of retrying the same dead link.
        await sb.from('matches').update({ scorecard_url: null }).eq('id', match.id)
        results.push({ matchId: match.id, status: 'fetch_failed', url, error: (e as Error).message })
        continue
      }

      // ── 2b. Roster names for this match's two teams ────────────────────────
      // Fetched here (before parsing, not with the rest of the name-resolution
      // maps in step 4 below) purely so splitNameAndDismissal can match a
      // non-hyperlinked player's name against the real roster instead of
      // guessing from dismissal-keyword regexes alone — see its doc comment.
      const matchTeamIdsForParse = [(match.home_team as any)?.id, (match.away_team as any)?.id].filter(Boolean)
      const { data: rosterForParse } = await sb
        .from('tournament_players')
        .select('players(name)')
        .eq('tournament_id', tournament.id)
        .in('team_id', matchTeamIdsForParse.length ? matchTeamIdsForParse : ['__none__'])
      const knownNames = (rosterForParse ?? []).map((r: any) => r.players?.name).filter(Boolean)

      // ── 3. Parse innings ──────────────────────────────────────────────────
      const innings = source === 'cricketaddictor'
        ? parseCricketAddictor(html, knownNames)
        : parseBusinessStandard(html)

      if (!innings.length) {
        // Same reasoning: a cached URL that fetches OK but never parses
        // (wrong page / wrong match) shouldn't be reused on the next attempt.
        await sb.from('matches').update({ scorecard_url: null }).eq('id', match.id)
        // Deeper diagnostics: html.includes('Inning') being true doesn't mean
        // our <h2>...Inning...</h2> regex actually matches — the heading may
        // have nested markup (breaking the [^<]* class) or be a different
        // tag entirely. Extract every <h2> block in full (no length cap) and
        // report its stripped inner text, so we can see what the real
        // innings-heading markup/tag actually looks like.
        const h2Re = /<h2[^>]*>([\s\S]*?)<\/h2>/gi
        const h2Texts: string[] = []
        let h2m: RegExpExecArray | null
        while ((h2m = h2Re.exec(html)) !== null) h2Texts.push(stripTags(h2m[1]).slice(0, 120))
        results.push({
          matchId: match.id, status: 'parse_failed', url,
          htmlLength: html.length,
          hasInningText: html.includes('Inning'),
          hasTableMarkup: html.includes('<table'),
          h2Count: (html.match(/<h2/gi) ?? []).length,
          tableCount: (html.match(/<table/gi) ?? []).length,
          h2StrippedTexts: h2Texts,
        })
        continue
      }

      // ── 3a. Completion detection ────────────────────────────────────────
      // Previously only poll-cricapi could ever flip matches.status to
      // 'completed' — see detectCompletion() above for why this same signal
      // is readable straight out of the scraped HTML.
      let completionInfo = detectCompletion(html)

      // Weak signal (bare "COMPLETED" badge, no result sentence yet) gets
      // corroborated against the innings we just parsed before being trusted
      // — same false-positive shape as poll-cricapi's matchEnded flag (see
      // that file's matchLifecycle() for the NZ Women vs Scotland Women case
      // this guards against): the badge can flip before the scorecard table
      // underneath has actually finished updating. If the last innings here
      // doesn't look done (not all out, overs not exhausted), treat the
      // match as still live regardless of what the badge says.
      if (completionInfo.completed && !completionInfo.strong && !lastInningsLooksDone(innings, (match as any).format)) {
        completionInfo = { ...completionInfo, completed: false }
      }

      // ── 3b. Staleness guard ─────────────────────────────────────────────
      // Compare this read's progress against the furthest progress seen so
      // far for this match (across either source — see poll-cricapi for the
      // CricAPI side of the same guard). If this read is BEHIND that, it's
      // almost certainly a stale/cached page — skip the write entirely
      // rather than regressing good data with a worse read.
      //
      // This protection is for the CRON path only, where nobody's watching
      // and a background re-read silently regressing good data would go
      // unnoticed. A manual "Scrape Now" (matchId provided) is the admin
      // looking directly at this one match and explicitly asking for its
      // current state — same "admin explicitly asked for this" reasoning as
      // the cached-URL and status-filter bypasses above — so it always
      // trusts the fresh read instead of silently discarding it. This is
      // exactly the gap that left M12 stuck on 'stale_skipped' with no way
      // to force a real re-read through the admin panel.
      const lastInn = innings[innings.length - 1]
      const inningsBalls = lastInn.bowling.reduce(
        (sum, b) => sum + (Math.round(b.overs) * 6 + Math.round((b.overs % 1) * 10)),
        0,
      )
      const newProgress    = { innings: innings.length, balls: inningsBalls }
      const storedProgress = { innings: (match as any).progress_innings ?? 0, balls: (match as any).progress_balls ?? 0 }
      const isStale = !matchId && (
        newProgress.innings < storedProgress.innings
        || (newProgress.innings === storedProgress.innings && newProgress.balls < storedProgress.balls)
      )

      if (isStale) {
        // The stats/scorecard numbers on this read aren't trusted (that's what
        // triggered isStale above), but a genuine completion signal must never
        // be suppressed by that — otherwise a match whose final page happens to
        // read as "behind" the watermark (e.g. a curtailed/DLS-affected chase,
        // or an earlier noisy mid-match read that over-counted balls) can never
        // leave 'live', and nothing else in the app can ever finalize it. Flip
        // status only; every stats/scorecard write below is still skipped for
        // this match on this run — deliberately does NOT stamp
        // stats_verified_at (migration_v59), so this exact completion is
        // flagged "⚠ unverified" in the admin panel until a trustworthy
        // re-scrape lands.
        let completionMarkedWhileStale = false
        if (completionInfo.completed && match.status !== 'completed') {
          await sb.from('matches').update({ status: 'completed' }).eq('id', match.id)
          completionMarkedWhileStale = true
        }
        results.push({
          matchId: match.id, status: 'stale_skipped', url, read: newProgress, stored: storedProgress,
          completionDetected: completionInfo.completed,
          completionMarked: completionMarkedWhileStale,
        })
        continue
      }

      // ── 3c. Cache the raw scraped scorecard for the admin "Live scorecard" panel ──
      // poll-cricapi caches CricAPI's raw payload into match_scorecards so the
      // browser's renderScorecard()/renderInnings()/renderBatRow() code (built
      // for CricAPI) can render it as-is. Scraper-driven matches never wrote
      // anything there, so the admin panel fell back to a lossy reconstruction
      // built later from player_match_stats — fantasy-squad players only, no
      // dismissal text, and any name the resolver couldn't match was silently
      // dropped from view (only visible as a bare string in scraper_unmatched).
      // Shaping `innings` (every batter/bowler exactly as scraped, BEFORE name
      // resolution runs) into the same CricAPI-ish payload shape and writing it
      // here gives scraper matches the identical rich view CricAPI matches get
      // — unmatched names included, with their real runs/balls/dismissal text —
      // which is what actually lets an admin spot and fix a gap at a glance.
      const SKIP_ROW_NAMES = new Set(['extras', 'total', 'yet to bat', 'did not bat'])
      const rawScorecard = innings.map(inn => {
        const bat  = inn.batting.filter(b => !SKIP_ROW_NAMES.has(b.name.toLowerCase().trim()))
        const bowl = inn.bowling.filter(b => !SKIP_ROW_NAMES.has(b.name.toLowerCase().trim()))
        const totalRuns  = bat.reduce((s, b) => s + b.runs, 0)
        const totalWkts  = bat.filter(b => b.dismissed).length
        const totalBalls = bowl.reduce((s, b) => s + (Math.round(b.overs) * 6 + Math.round((b.overs % 1) * 10)), 0)
        const overallOvers = Math.floor(totalBalls / 6) + (totalBalls % 6) / 10
        return {
          inning: `${inn.teamName} Innings`,
          r: totalRuns, w: totalWkts, o: totalBalls ? overallOvers.toFixed(1) : '0.0',
          batting: bat.map(b => ({
            batsman: { name: b.name }, r: b.runs, b: b.balls, '4s': b.fours, '6s': b.sixes,
            'dismissal-text': b.dismissed ? (b.dismissalText ?? 'out') : 'not out',
          })),
          bowling: bowl.map(b => ({
            bowler: { name: b.name }, o: b.overs, m: b.maidens, r: b.runs, w: b.wickets, dots: b.dots,
          })),
        }
      })
      await sb.from('match_scorecards').upsert(
        {
          match_id: match.id,
          payload: {
            data: {
              matchInfo: {
                name  : `${homeTeam} vs ${awayTeam}`,
                status: completionInfo.completed ? 'Completed' : 'Live',
              },
              scorecard: rawScorecard,
            },
          },
          fetched_at: new Date().toISOString(),
        },
        { onConflict: 'match_id' },
      )

      // ── 4. Build name resolution maps ─────────────────────────────────────
      // Scoped to ONLY the two teams playing this match, not the whole
      // tournament roster. A raw name from this scorecard can only ever be
      // one of these ~22 players — matching against the full tournament
      // roster (which can include 100+ players across every team) let a name
      // from one team's box score fuzzy/alias-match a same-surname player on
      // a completely different team that isn't even playing today.
      const matchTeamIds = [(match.home_team as any)?.id, (match.away_team as any)?.id].filter(Boolean)

      const { data: tPlayers } = await sb
        .from('tournament_players')
        .select('player_id, team_id, players(id, name, role)')
        .eq('tournament_id', tournament.id)
        .in('team_id', matchTeamIds)

      const rosterPlayerIds = (tPlayers ?? []).map(tp => tp.player_id)

      const { data: aliases } = await sb
        .from('player_name_aliases')
        .select('alias, player_id')
        .eq('tournament_id', tournament.id)
        .eq('source', source)
        .in('player_id', rosterPlayerIds.length ? rosterPlayerIds : ['__none__'])

      // id → role map (needed for duck penalty logic)
      const roleMap = new Map<string, string>()
      const exactMap = new Map<string, string>()  // norm name → player_id
      for (const tp of tPlayers ?? []) {
        const p = (tp as any).players
        if (!p) continue
        exactMap.set(p.name.toLowerCase().trim(), tp.player_id)
        roleMap.set(tp.player_id, p.role ?? 'bat')
      }

      const aliasMap = new Map<string, string>()
      for (const a of aliases ?? []) {
        aliasMap.set(a.alias.toLowerCase().trim(), a.player_id)
      }

      // ── 5. Scoring rules ──────────────────────────────────────────────────
      // Tournament-level only — this is the base raw_points figure written to
      // player_match_stats and used for Daily XI. dot_ball is forced to 0
      // unless the tournament's "Dot ball scoring" toggle is explicitly ON
      // (migration_v30) — resolveEffectiveRules applies that gate.
      const fmtKey   = fmt.toUpperCase() === 'ODI' ? 'ODI' : 'T20'
      const rules: Rules = resolveEffectiveRules(tournament, null, fmtKey)

      // ── 6. Process innings → stat rows ───────────────────────────────────
      // player_id → { batting?, bowling?, fielding?, rawPoints }
      const statAccum = new Map<string, { batting?: object; bowling?: object; fielding?: FieldRow; rawPoints: number }>()
      const unmatched: Array<{ name: string; context: 'batting' | 'bowling' }> = []
      const fuzzyAliases: Array<{ player_id: string; alias: string }> = []
      // Placeholder rows ("Player Not Found") are never aliased or queued in
      // scraper_unmatched (see isPlaceholderName), but their points shouldn't
      // just vanish — capture the raw numbers so an admin can later
      // force-credit this match/context to the right player. Keyed only by
      // context (one batting row, one bowling row per match/source): if the
      // same match has two different unidentified players in the same
      // discipline, the later one's numbers win — documented limitation, see
      // migration_v28_placeholder_stats.sql.
      const placeholderRows = new Map<'batting' | 'bowling', { batting: object | null; bowling: object | null; fielding: object | null; raw_points: number }>()

      // Fielding credit derived from dismissal text, and any raw fielder name
      // that couldn't be resolved (unmatched) or resolved to 2+ players
      // (ambiguous — e.g. two squad members sharing a surname). Surfaced to
      // the admin via scraper_fielding_issues instead of silently dropped.
      const fieldingByPlayer = new Map<string, FieldRow>()
      const fieldingIssues: Array<{
        rawName: string; candidates: string[] | null
        field: 'catches' | 'stumpings' | 'runOutDirect' | 'runOutIndirect'
        batterName: string; dismissalText: string
      }> = []
      const addFieldingCredit = (
        rawName: string | null | undefined,
        field: 'catches' | 'stumpings' | 'runOutDirect' | 'runOutIndirect',
        batterName: string, dismissalText: string,
      ) => {
        if (!rawName) return
        const { playerId, candidates } = resolveFielderName(rawName, exactMap, aliasMap)
        if (playerId) {
          const cur = fieldingByPlayer.get(playerId) ?? { catches: 0, stumpings: 0, runOutDirect: 0, runOutIndirect: 0 }
          cur[field]++
          fieldingByPlayer.set(playerId, cur)
        } else {
          fieldingIssues.push({ rawName, candidates, field, batterName, dismissalText })
        }
      }

      for (const inn of innings) {
        // Bowler wicketTypes (for the lbw/bowled bonus) keyed by the exact name
        // string as it appears in THIS innings's bowling table, so the lookup
        // below lines up 1:1 regardless of how a dismissal line abbreviates
        // the bowler's first name (e.g. "A Russell" dismissal vs "Andre
        // Russell" bowling-table entry — matched via matchBowlerNameInInnings).
        const bowlerNamesInInnings = inn.bowling.map(b => b.name)
        const wicketsByBowlerRaw: Record<string, string[]> = {}

        for (const bat of inn.batting) {
          // Fielding/wicket-type derivation runs independently of whether the
          // BATTER himself resolves to a local player_id — an unmatched
          // batter's dismissal still names a real fielder/bowler who should
          // get credit regardless.
          const parsed = parseScrapedDismissal(bat.dismissalText)
          if (parsed) {
            if (parsed.bowler) {
              const matchedBowlerName = matchBowlerNameInInnings(parsed.bowler, bowlerNamesInInnings) || parsed.bowler
              ;(wicketsByBowlerRaw[matchedBowlerName] ||= []).push(parsed.type)
            }
            if (parsed.type === 'caught')  addFieldingCredit(parsed.fielder, 'catches', bat.name, bat.dismissalText!)
            if (parsed.type === 'stumped') addFieldingCredit(parsed.fielder, 'stumpings', bat.name, bat.dismissalText!)
            if (parsed.type === 'run_out') {
              if (parsed.fielder && parsed.fielder2) {
                // Two fielders named — the scorecard notation doesn't
                // reliably tell you who threw vs who broke the stumps, so
                // credit both as assists instead of arbitrarily treating
                // whichever name is listed first as the "direct" hit.
                addFieldingCredit(parsed.fielder,  'runOutIndirect', bat.name, bat.dismissalText!)
                addFieldingCredit(parsed.fielder2, 'runOutIndirect', bat.name, bat.dismissalText!)
              } else {
                // Exactly one fielder named — a clean, solo direct hit.
                addFieldingCredit(parsed.fielder ?? parsed.fielder2, 'runOutDirect', bat.name, bat.dismissalText!)
              }
            }
          }

          if (isPlaceholderName(bat.name)) {
            const rawPts = calcBatting(bat, 'bat', fmtKey, rules)
            placeholderRows.set('batting', {
              batting: { runs: bat.runs, ballsFaced: bat.balls, fours: bat.fours, sixes: bat.sixes, isDismissed: bat.dismissed },
              bowling: null, fielding: null, raw_points: rawPts,
            })
            continue // never alias or queue the source's own "not found" placeholder
          }
          const { playerId, method } = resolvePlayerName(bat.name, exactMap, aliasMap)
          if (!playerId) {
            if (!unmatched.some(u => u.name === bat.name)) unmatched.push({ name: bat.name, context: 'batting' })
            continue
          }
          if (method === 'fuzzy') fuzzyAliases.push({ player_id: playerId, alias: bat.name.toLowerCase().trim() })

          const role = roleMap.get(playerId) ?? 'bat'
          const rawPts = calcBatting(bat, role, fmtKey, rules)

          const existing = statAccum.get(playerId)
          if (existing) {
            existing.batting = { runs: bat.runs, ballsFaced: bat.balls, fours: bat.fours, sixes: bat.sixes, isDismissed: bat.dismissed }
            existing.rawPoints += rawPts
          } else {
            statAccum.set(playerId, {
              batting  : { runs: bat.runs, ballsFaced: bat.balls, fours: bat.fours, sixes: bat.sixes, isDismissed: bat.dismissed },
              rawPoints: rawPts,
            })
          }
        }

        for (const bowl of inn.bowling) {
          if (isPlaceholderName(bowl.name)) {
            const wicketTypes = wicketsByBowlerRaw[bowl.name] ?? []
            const ballsBowled = parseOversToBalls(bowl.overs)
            const rawPts = calcBowling(bowl, fmtKey, rules) + calcLbwBowledBonus(wicketTypes, rules)
            placeholderRows.set('bowling', {
              bowling: { wickets: bowl.wickets, wicketTypes, maidens: bowl.maidens, runsConceded: bowl.runs, ballsBowled, dotBalls: bowl.dots, noBalls: 0, wides: 0 },
              batting: null, fielding: null, raw_points: rawPts,
            })
            continue // never alias or queue the source's own "not found" placeholder
          }
          const { playerId, method } = resolvePlayerName(bowl.name, exactMap, aliasMap)
          if (!playerId) {
            if (!unmatched.some(u => u.name === bowl.name)) unmatched.push({ name: bowl.name, context: 'bowling' })
            continue
          }
          if (method === 'fuzzy') fuzzyAliases.push({ player_id: playerId, alias: bowl.name.toLowerCase().trim() })

          const wicketTypes  = wicketsByBowlerRaw[bowl.name] ?? []
          const rawPts       = calcBowling(bowl, fmtKey, rules) + calcLbwBowledBonus(wicketTypes, rules)
          const ballsBowled  = parseOversToBalls(bowl.overs)

          const existing = statAccum.get(playerId)
          if (existing) {
            existing.bowling  = { wickets: bowl.wickets, wicketTypes, maidens: bowl.maidens, runsConceded: bowl.runs, ballsBowled, dotBalls: bowl.dots, noBalls: 0, wides: 0 }
            existing.rawPoints += rawPts
          } else {
            statAccum.set(playerId, {
              bowling  : { wickets: bowl.wickets, wicketTypes, maidens: bowl.maidens, runsConceded: bowl.runs, ballsBowled, dotBalls: bowl.dots, noBalls: 0, wides: 0 },
              rawPoints: rawPts,
            })
          }
        }
      }

      // ── 6a. Apply resolved fielding credit to statAccum ───────────────────
      // A fielder might be credit-only (never batted/bowled themselves, e.g. a
      // specialist fielder low in the order who didn't get to bat) — ensure
      // they still get a statAccum entry rather than being silently dropped.
      for (const [playerId, fielding] of fieldingByPlayer) {
        const fieldingPts = calcFielding(fielding, rules)
        const existing = statAccum.get(playerId)
        if (existing) {
          existing.fielding = fielding
          existing.rawPoints += fieldingPts
        } else {
          statAccum.set(playerId, { fielding, rawPoints: fieldingPts })
        }
      }

      // ── 6b. Per-player regression guard ────────────────────────────────────
      // The innings-level watermark above only protects the LAST innings's
      // total progress — it says nothing about the first innings or about
      // any individual player. A read that's "fresh enough" on the chasing
      // team's overs can still carry a worse/cached snapshot of an earlier
      // innings (or of one player's row specifically), and the upsert below
      // is a blind overwrite — so without this guard that worse snapshot
      // would silently clobber already-good data. Cricket stats are
      // monotonic within a match (balls faced/bowled never decrease), so any
      // player whose new read has FEWER balls than what's already stored is
      // almost certainly a stale partial read for that player — skip them
      // and leave their existing row untouched.
      const { data: existingStatRows } = await sb
        .from('player_match_stats')
        .select('player_id, batting, bowling, fielding, raw_points, source')
        .eq('match_id', match.id)
      const existingByPlayer = new Map((existingStatRows ?? []).map(r => [r.player_id, r]))

      const regressedPlayers: string[] = []
      for (const [playerId, s] of statAccum) {
        const ex = existingByPlayer.get(playerId)
        if (!ex) continue
        // An admin who manually entered/corrected this player's fielding via
        // the Fielding Review panel (source='scraper_manual') always wins —
        // never let a later auto re-scrape silently overwrite their fielding
        // correction with whatever the (possibly still-imperfect) dismissal
        // parser re-derives from the page.
        if (ex.source === 'scraper_manual') { regressedPlayers.push(playerId); continue }
        const newBattingBalls = (s.batting as any)?.ballsFaced   ?? 0
        const oldBattingBalls = (ex.batting as any)?.ballsFaced  ?? 0
        const newBowlingBalls = (s.bowling as any)?.ballsBowled  ?? 0
        const oldBowlingBalls = (ex.bowling as any)?.ballsBowled ?? 0
        if (newBattingBalls < oldBattingBalls || newBowlingBalls < oldBowlingBalls) {
          regressedPlayers.push(playerId)
        }
      }

      // ── 7. Upsert player_match_stats ──────────────────────────────────────
      const statRows = Array.from(statAccum.entries())
        .filter(([playerId]) => !regressedPlayers.includes(playerId))
        .map(([playerId, s]) => ({
          match_id  : match.id,
          player_id : playerId,
          batting   : s.batting   ?? null,
          bowling   : s.bowling   ?? null,
          // Auto-derived from the dismissal text scraped alongside batting rows
          // (see parseScrapedDismissal / addFieldingCredit above). Any dismissal
          // that couldn't be resolved to exactly one squad player is NOT folded
          // in here — it's queued in `fieldingIssues` for admin review instead.
          fielding  : s.fielding  ?? null,
          raw_points: Math.round(s.rawPoints * 10) / 10,
          source    : 'scraper',
        }))

      if (statRows.length) {
        const CHUNK = 50
        for (let i = 0; i < statRows.length; i += CHUNK) {
          const { error: uErr } = await sb
            .from('player_match_stats')
            .upsert(statRows.slice(i, i + CHUNK), { onConflict: 'match_id,player_id' })
          if (uErr) throw uErr
        }
      }

      // ── 8. Persist fuzzy aliases so next run auto-resolves them ───────────
      // NOTE: none of steps 8/9/9a/9b below used to check the upsert's `error`
      // return value — a constraint violation (bad enum value, FK mismatch,
      // etc.) would fail completely silently: the row just never lands, with
      // no exception, no log line, nothing. That's exactly the shape of bug
      // reported for two run-out fielders (Jahmar Hamilton, Alzari Joseph)
      // that got neither fantasy credit NOR a Review-tab "fielding issue" row
      // — the in-memory match-resolution logic for both traced out correctly
      // in isolation, so if they're still not appearing after this fix ships,
      // the edge function logs will now show exactly why the write failed.
      if (fuzzyAliases.length) {
        const { error: faErr } = await sb.from('player_name_aliases').upsert(
          fuzzyAliases.map(a => ({
            player_id    : a.player_id,
            tournament_id: tournament.id,
            alias        : a.alias,
            source,
          })),
          { onConflict: 'alias,source,tournament_id', ignoreDuplicates: true },
        )
        if (faErr) console.error(`[${match.id}] fuzzyAliases upsert failed:`, faErr.message)
      }

      // ── 9. Persist unmatched names so admin can reconcile ─────────────────
      if (unmatched.length) {
        const { error: umErr } = await sb.from('scraper_unmatched').upsert(
          unmatched.map(u => ({
            tournament_id: tournament.id,
            match_id     : match.id,
            raw_name     : u.name,
            source,
            context      : u.context,
          })),
          { onConflict: 'tournament_id,raw_name,source', ignoreDuplicates: true },
        )
        if (umErr) console.error(`[${match.id}] scraper_unmatched upsert failed:`, umErr.message)
      }

      // ── 9a. Persist recoverable placeholder stats ──────────────────────────
      // Keyed per match+context (not per tournament like scraper_unmatched
      // above) — every match's "Player Not Found" needs its own resolution,
      // never auto-resolved by a prior match's fix. Don't overwrite
      // resolved_at/resolved_by/credited_player_id on a re-scrape — only
      // raw_stats refreshes (the match may still be live).
      if (placeholderRows.size) {
        const { error: psErr } = await sb.from('scraper_placeholder_stats').upsert(
          Array.from(placeholderRows.entries()).map(([context, stats]) => ({
            tournament_id: tournament.id,
            match_id     : match.id,
            source,
            context,
            raw_stats    : stats,
          })),
          { onConflict: 'match_id,source,context' },
        )
        if (psErr) console.error(`[${match.id}] scraper_placeholder_stats upsert failed:`, psErr.message)
      }

      // ── 9b. Persist fielding events the scraper couldn't auto-resolve ─────
      // (unmatched fielder name, or ambiguous — matches 2+ squad players).
      // Mirrors the scraper_unmatched convention: ignoreDuplicates so a row
      // an admin already resolved doesn't get reset back to unresolved by a
      // later re-scrape that reproduces the same unresolved dismissal.
      if (fieldingIssues.length) {
        const { error: fiErr } = await sb.from('scraper_fielding_issues').upsert(
          fieldingIssues.map(fi => ({
            tournament_id : tournament.id,
            match_id      : match.id,
            raw_name      : fi.rawName,
            source,
            field         : fi.field,
            batter_name   : fi.batterName,
            dismissal_text: fi.dismissalText,
            candidates    : fi.candidates,
          })),
          { onConflict: 'match_id,raw_name,field,batter_name', ignoreDuplicates: true },
        )
        if (fiErr) console.error(`[${match.id}] scraper_fielding_issues upsert failed:`, fiErr.message, JSON.stringify(fieldingIssues))
      }

      // ── 9b-2. Flag any bowler on 3+ wickets this innings for Review →
      // 🎩 Potential Hat-tricks — none of our sources report ball-by-ball
      // sequencing, so this is only ever a candidate for an admin to
      // confirm/decline after checking the real scorecard. source is
      // hardcoded 'scraper' (not the cricketaddictor/business_standard
      // `source` var above) to match player_match_stats' own convention.
      const hattrickCandidates = statRows.filter(r => (r.bowling?.wickets ?? 0) >= 3)
      if (hattrickCandidates.length) {
        const { error: htErr } = await sb.from('potential_hattricks').upsert(
          hattrickCandidates.map(r => ({
            tournament_id: tournament.id,
            match_id     : match.id,
            player_id    : r.player_id,
            wickets      : r.bowling!.wickets,
            source       : 'scraper',
          })),
          { onConflict: 'match_id,player_id', ignoreDuplicates: true },
        )
        if (htErr) console.error(`[${match.id}] potential_hattricks upsert failed:`, htErr.message)
      }

      // ── 9c. Let the scraper mark a match completed too ────────────────────
      // Previously only poll-cricapi (CricAPI-driven matches) could flip
      // matches.status to 'completed'. Scraper-only tournaments had no way to
      // ever leave 'live'/'in_progress', which meant locked XIs/squads never
      // got a final "this match is done" signal from this data source. Once
      // flipped, the cron query's `.not('status','in','("completed","delayed")')`
      // filter means this match is never re-scraped again — which is exactly
      // what protects any admin fielding corrections made afterwards (see the
      // scraper_manual regression-guard check above) from being clobbered.
      //
      // stats_verified_at (migration_v59) is stamped unconditionally here —
      // reaching this line means isStale was false, so the stats/scorecard
      // writes above for this run are trustworthy. It's set regardless of
      // whether completion happened this run, so it also works as a general
      // "last time we wrote real data for this match" marker. Combined with
      // `status`, `status = 'completed' AND stats_verified_at IS NULL`
      // uniquely identifies a match that was auto-completed off the 3b
      // staleness-guard bypass (completion detected on a run whose stats
      // were skipped as stale) rather than off a genuinely trustworthy read —
      // that bypass never reaches this line, so it never sets this column.
      // The admin panel surfaces that combination as a "⚠ unverified" badge.
      const matchUpdate: Record<string, unknown> = { stats_verified_at: new Date().toISOString() }
      if (completionInfo.completed && match.status !== 'completed') matchUpdate.status = 'completed'
      await sb.from('matches').update(matchUpdate).eq('id', match.id)

      // ── 10. Distribute raw_points to locked XI scores (SL squads + Daily teams) ──
      // Regressed players keep their existing (already-correct) raw_points
      // here too, so scoring stays consistent with what's actually persisted
      // above rather than re-applying points from the discarded worse read.
      const pointsMap = new Map<string, number>()
      // Same regression-aware selection as pointsMap above, but keeping the
      // full batting/bowling/fielding shape (not just the collapsed number)
      // — scoreXIForMatch needs the raw stats to re-derive points under a
      // contest's custom scoring rules, not just the tournament-level total.
      const statsByPlayer = new Map<string, { batting?: any; bowling?: any; fielding?: FieldRow; rawPoints: number }>()
      for (const [pid, s] of statAccum) {
        if (regressedPlayers.includes(pid)) {
          const ex = existingByPlayer.get(pid)
          pointsMap.set(pid, ex?.raw_points ?? s.rawPoints)
          statsByPlayer.set(pid, {
            batting  : ex?.batting  ?? s.batting,
            bowling  : ex?.bowling  ?? s.bowling,
            fielding : ex?.fielding ?? s.fielding,
            rawPoints: ex?.raw_points ?? s.rawPoints,
          })
        } else {
          pointsMap.set(pid, s.rawPoints)
          statsByPlayer.set(pid, { batting: s.batting, bowling: s.bowling, fielding: s.fielding, rawPoints: s.rawPoints })
        }
      }
      await scoreXIForMatch(match.id, tournament, fmtKey, statsByPlayer)
      const dailyTeamsScored = await scoreDailyTeamsForMatch(match.id, pointsMap)

      // ── 11. Bump the progress watermark now that this read has landed ─────
      if (newProgress.innings !== storedProgress.innings || newProgress.balls !== storedProgress.balls) {
        await sb.from('matches')
          .update({ progress_innings: newProgress.innings, progress_balls: newProgress.balls })
          .eq('id', match.id)
      }

      results.push({
        matchId : match.id,
        status  : 'ok',
        source,
        url,
        matched : statRows.length,
        unmatched: unmatched.map(u => u.name),
        regressedPlayersSkipped: regressedPlayers,
        fuzzyAliasesCreated: fuzzyAliases.length,
        dailyTeamsScored,
        completionDetected: completionInfo.completed,
        completionMarked: completionInfo.completed && match.status !== 'completed',
        fieldingCredited: fieldingByPlayer.size,
        fieldingIssues: fieldingIssues.length,
        // QA signal (see splitNameAndDismissal): every batting row whose name
        // didn't come from a clean profile link, even if it resolved fine —
        // worth a glance in Function Logs, since a 'regex' or 'first_token'
        // entry here is exactly the shape of bug that silently drops a
        // fielder's credit without ever showing up as an "unmatched" row.
        nameSplitFallbacks: (innings as any).nameSplitFallbacks ?? [],
      })
    }

    // The per-match `results` array (status: 'ok' / 'stale_skipped' /
    // 'parse_failed' / 'fetch_failed' / 'url_not_found') used to only ever
    // reach the HTTP response body — invisible from a cron-triggered run,
    // since nothing calls this function's response. That meant a match could
    // silently stop updating (e.g. stuck behind the staleness guard, or a
    // dead scorecard_url) while Supabase's log viewer showed nothing but a
    // clean boot/shutdown, with no way to tell "working" from "silently
    // skipping every match" without manually invoking it via the admin
    // Scrape button. Logging the summary here makes the real reason visible
    // in the Function Logs for every run, cron or manual.
    console.log('[scrape-scorecard] run summary:', JSON.stringify(
      results.map(r => ({ matchId: r.matchId, status: r.status }))
    ))

    return new Response(
      JSON.stringify({ ok: true, results }),
      { status: 200, headers: { ...CORS, 'Content-Type': 'application/json' } },
    )
  } catch (err) {
    console.error('[scrape-scorecard]', err)
    return new Response(
      JSON.stringify({ ok: false, error: (err as Error).message }),
      { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } },
    )
  }
})
