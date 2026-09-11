-- Adds two independent "what does this source say the match status is right
-- now" signals, sourced from Cricbuzz and CricketAddictor respectively, both
-- already fetched by check-toss for toss detection. Purely observational --
-- matches.status itself stays driven exclusively by poll-cricapi (CricAPI's
-- `stage` field) and scrape-scorecard (CricketAddictor/Business Standard
-- scorecard scraping). These columns let those be cross-checked against two
-- more independent sources without three writers fighting over one column.

alter table public.matches
  add column if not exists cricbuzz_status text,
  add column if not exists cricketaddictor_status text;

comment on column public.matches.cricbuzz_status is
  'Cricbuzz''s own match state as last seen by check-toss (Preview/Toss/In Progress/Complete/etc). Observational only -- does not drive matches.status.';
comment on column public.matches.cricketaddictor_status is
  'CricketAddictor''s own status badge as last seen by check-toss (SCHEDULED/LIVE/COMPLETED/etc). Observational only -- does not drive matches.status.';
