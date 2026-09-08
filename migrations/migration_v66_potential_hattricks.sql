-- migration_v66: potential_hattricks — flags a bowler who took 3+ wickets in a
-- single innings for admin review, so the app's new Hat-trick bonus can be
-- awarded. Run in Supabase SQL Editor.
--
-- Cricket data sources (CricAPI, the scraper, pasted scorecards) reliably
-- report total wickets per bowler, but NOT ball-by-ball sequencing — so
-- there's no reliable way to auto-detect a genuine hat-trick (3 wickets on
-- 3 consecutive deliveries). Instead, whenever a bowler's innings figures
-- reach 3+ wickets, a candidate row is queued here (mirrors
-- scraper_fielding_issues' shape/lifecycle) and an admin confirms or
-- declines it from the Review tab (🎩 Potential Hat-tricks) after checking
-- the real scorecard/highlights. Confirming patches that player's
-- player_match_stats (bowling.hattrick = true, raw_points += hattrick_bonus)
-- via db.js's confirmHattrick, tagged source='scraper_manual' so a later
-- re-finalize doesn't silently overwrite it (same guard fielding credit
-- fixes already rely on).
--
-- Populated from four places, mirroring how scraper_fielding_issues is
-- populated: poll-cricapi and scrape-scorecard (cron finalize paths) insert
-- directly; admin.js's finalizeOneMatch and saveManualScorecardForMatch
-- (manual finalize / pasted-scorecard paths) insert via db.js.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS potential_hattricks (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tournament_id UUID        NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  match_id      UUID        NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  player_id     TEXT        NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  wickets       INTEGER     NOT NULL,
  source        TEXT        NOT NULL
                  CHECK (source IN ('cricapi','scraper','manual','scraper_manual')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at   TIMESTAMPTZ DEFAULT NULL,
  resolved_by   TEXT        DEFAULT NULL
                  CHECK (resolved_by IS NULL OR resolved_by IN ('confirmed','declined')),
  UNIQUE (match_id, player_id)
);

-- Index for fast unresolved lookups per tournament (same pattern as
-- scraper_fielding_issues' sfi_tournament_unresolved_idx).
CREATE INDEX IF NOT EXISTS ph_tournament_unresolved_idx
  ON potential_hattricks(tournament_id)
  WHERE resolved_at IS NULL;

-- ── RLS ───────────────────────────────────────────────────────────────────────
ALTER TABLE potential_hattricks ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "ph_public_read"  ON potential_hattricks;
DROP POLICY IF EXISTS "ph_admin_insert" ON potential_hattricks;
DROP POLICY IF EXISTS "ph_admin_update" ON potential_hattricks;
DROP POLICY IF EXISTS "ph_admin_delete" ON potential_hattricks;

CREATE POLICY "ph_public_read"
  ON potential_hattricks FOR SELECT USING (true);

CREATE POLICY "ph_admin_insert"
  ON potential_hattricks FOR INSERT TO authenticated WITH CHECK (true);

CREATE POLICY "ph_admin_update"
  ON potential_hattricks FOR UPDATE TO authenticated USING (true) WITH CHECK (true);

CREATE POLICY "ph_admin_delete"
  ON potential_hattricks FOR DELETE TO authenticated USING (true);

-- The service-role key used by the edge functions (poll-cricapi,
-- scrape-scorecard) bypasses RLS entirely, so no explicit service-role
-- policy is needed — matches scraper_fielding_issues' setup.
