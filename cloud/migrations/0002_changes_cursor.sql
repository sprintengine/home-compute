-- Not in the §2 schema: GET /v1/changes reads MAX(runs.updated_at) on every
-- dashboard poll. Without this index that is a scan of the whole runs table
-- (D1 bills rows scanned); with it, one row.
CREATE INDEX runs_by_updated ON runs(updated_at);
