-- Alerts (pulled forward from M8, see docs/hosted-control-plane.md §13): what
-- the owner must hear about without looking. One open alert per key
-- (`job-failing:<job>`, `stale:<job>:<value>`, `no-machine`,
-- `waiting:<job>`, `test:<id>`); hc-core's cron opens, updates and resolves
-- them and sends the email. Resolved rows are history, kept 90 days.
CREATE TABLE alerts (
  id            TEXT PRIMARY KEY,          -- a_<ulid>
  key           TEXT NOT NULL,
  kind          TEXT NOT NULL,             -- job-failing | stale | no-machine | waiting | test
  target        TEXT,
  summary       TEXT NOT NULL,
  detail_json   TEXT NOT NULL DEFAULT '{}',
  opened_at     INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  resolved_at   INTEGER,
  notified_at   INTEGER,                   -- the email that said it opened
  reminded_at   INTEGER,                   -- the last daily reminder while it stays open
  resolve_notified_at INTEGER              -- the email that said it resolved (or that none was needed)
);
CREATE UNIQUE INDEX alerts_open ON alerts(key) WHERE resolved_at IS NULL;
CREATE INDEX alerts_by_opened ON alerts(opened_at DESC);

-- Consecutive failed runs per job, kept where each run settles (complete,
-- the timeout backstop, a claim whose secret could not be given), so the
-- "failed twice in a row" alert reads one row per job instead of its runs.
ALTER TABLE schedule_state ADD COLUMN fail_streak INTEGER NOT NULL DEFAULT 0;
