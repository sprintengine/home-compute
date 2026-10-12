-- migrations/0001_init.sql: the schema of docs/hosted-control-plane.md §2, verbatim.
-- Changes go in later migrations, never here, once this has been applied anywhere.
CREATE TABLE jobs (
  id               TEXT PRIMARY KEY,             -- ^[a-z0-9][a-z0-9-]{0,62}$, as today
  description      TEXT,
  enabled          INTEGER NOT NULL DEFAULT 1,   -- configuration switch (jobs.toml enabled)
  paused           INTEGER NOT NULL DEFAULT 0,   -- operator pause (today's record.paused)
  image            TEXT NOT NULL,                -- repo@sha256:… (preferred) or repo:tag
  entrypoint_json  TEXT,                         -- ["sh","-c","…"] or NULL
  args_json        TEXT NOT NULL DEFAULT '[]',
  env_json         TEXT NOT NULL DEFAULT '{}',   -- non-secret NAME -> value
  secret_env_json  TEXT NOT NULL DEFAULT '{}',   -- NAME -> "vault:<secret>" | "local:<NAME>"
  resources_json   TEXT NOT NULL,                -- {"cpus":1,"memoryMiB":1024,"diskMiB":12288}
  timeouts_json    TEXT NOT NULL,                -- {"runSeconds":3900,"maxLatenessSeconds":null}
  schedule_json    TEXT,                         -- {"at":{"hours":[8,10],"minutes":[20]}} | {"every":"6h"} | NULL
  placement_json   TEXT NOT NULL DEFAULT '{}',   -- {"requireLabels":{"arch":"arm64"},"preferMachines":["mac-mini"],"preferWaitSeconds":300}
  policy_json      TEXT NOT NULL DEFAULT '{}',   -- {"overlap":"coalesce","catchUp":"latest","retry":{…},"priority":0}
  report_json      TEXT,                         -- {"format":"json-lines","trackEvent":"forecast_complete","trackBy":"model"}
  network          TEXT NOT NULL DEFAULT 'bridge', -- bridge | none (never host)
  labels_json      TEXT NOT NULL DEFAULT '{}',
  preset           TEXT,                         -- "wingfoil" when imported from a preset
  revision         INTEGER NOT NULL DEFAULT 1,   -- optimistic concurrency (If-Match)
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, updated_by TEXT
);

CREATE TABLE schedule_state (
  job_id           TEXT PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
  last_slot_at     INTEGER,     -- newest slot materialised or deliberately skipped
  next_due_at      INTEGER,     -- denormalised for the overview and agent look-ahead
  last_run_id TEXT, last_state TEXT, last_outcome TEXT, last_finished_at INTEGER,
  published_json   TEXT NOT NULL DEFAULT '{}'  -- trackBy value -> {run, at, seconds, runId}
);

CREATE TABLE machines (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL UNIQUE,         -- "mac-mini"
  labels_json      TEXT NOT NULL DEFAULT '{}',   -- {"os":"darwin","arch":"arm64","runtime":"colima","site":"home"}
  capabilities     TEXT NOT NULL DEFAULT '',     -- "provisioner" or empty
  capacity_json    TEXT NOT NULL DEFAULT '{}',   -- caps: {"cpus":4,"memoryMiB":6144,"diskMiB":40960,"maxRuns":2}
  facts_json       TEXT NOT NULL DEFAULT '{}',   -- os version, docker version, colima version, VM state/size
  health_json      TEXT NOT NULL DEFAULT '{}',   -- {"docker":"ok","diskFreeMiB":…,"lastError":…,"vmBootSeconds":28}
  agent_version    TEXT,
  credential_hash  TEXT,                         -- sha256(credential); NULL once revoked
  credential_next_hash TEXT,                     -- during rotation
  drain            INTEGER NOT NULL DEFAULT 0,   -- finish current work, claim nothing new
  last_seen_at     INTEGER,                      -- written at most every 5 min unless state changes
  last_ip          TEXT, clock_skew_ms INTEGER,
  enrolled_at INTEGER NOT NULL, revoked_at INTEGER
);

CREATE TABLE join_tokens (
  token_hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL, used_at INTEGER,
  machine_name TEXT, labels_json TEXT, capabilities TEXT NOT NULL DEFAULT '',
  provisioning_task_id TEXT, created_by TEXT NOT NULL, created_at INTEGER NOT NULL
);

CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id),
  job_revision INTEGER NOT NULL,           -- what definition it ran
  slot_at INTEGER,                        -- NULL for manual runs
  source TEXT NOT NULL,                   -- schedule | manual | retry | import
  state TEXT NOT NULL,                    -- see §3 state machine
  skip_reason TEXT,                       -- coalesced | overlap | expired | paused-at-slot
  outcome TEXT,                           -- published | unchanged | completed | failed (outcomeOf)
  attempt INTEGER NOT NULL DEFAULT 1, retry_of TEXT,
  due_at INTEGER NOT NULL, preferred_until INTEGER,
  machine_id TEXT, lease_expires_at INTEGER,
  claimed_at INTEGER, vm_started_at INTEGER, pull_started_at INTEGER,
  started_at INTEGER, reporting_at INTEGER, finished_at INTEGER,
  queue_ms INTEGER, duration_ms INTEGER, vm_wait_ms INTEGER, pull_ms INTEGER,
  exit_code INTEGER, oom_killed INTEGER, timed_out INTEGER,
  peak_memory_bytes INTEGER, memory_limit_bytes INTEGER,
  avg_cpu_pct REAL, peak_cpu_pct REAL, cpu_seconds REAL, stats_samples INTEGER,
  image_ref TEXT, image_digest TEXT,      -- what actually ran
  parameters_json TEXT,                   -- manual extraParameters
  error TEXT,                             -- one line, redacted
  error_detail TEXT,                      -- <= 4 KB: traceback / last error lines, redacted
  reports_json TEXT,                      -- <= 32 KB, boundedReports(), redacted
  metrics_json TEXT,                      -- reportMetrics()
  published_json TEXT,
  recovered INTEGER NOT NULL DEFAULT 0,   -- a late report arrived after the run was marked lost
  requested_by TEXT,                      -- email / service token / "schedule"
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX runs_slot       ON runs(job_id, slot_at) WHERE slot_at IS NOT NULL;   -- idempotent materialisation
CREATE UNIQUE INDEX runs_one_due    ON runs(job_id) WHERE state = 'due';                 -- coalescing
CREATE UNIQUE INDEX runs_one_active ON runs(job_id)
  WHERE state IN ('claimed','starting-vm','pulling','running','reporting');              -- no overlap
CREATE INDEX runs_by_state   ON runs(state, due_at);
CREATE INDEX runs_by_job     ON runs(job_id, due_at DESC);
CREATE INDEX runs_by_machine ON runs(machine_id, state);

CREATE TABLE run_logs (            -- separate so listing runs never touches big rows
  run_id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
  tail TEXT NOT NULL,              -- redacted, <= 64 KB, <= 500 lines
  bytes_total INTEGER, lines_total INTEGER, truncated INTEGER,
  error_count INTEGER, final INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL
);

CREATE TABLE secrets (
  name TEXT PRIMARY KEY,           -- "wingfoil-r2-secret-key"
  envelope TEXT NOT NULL,          -- base64(RSA-OAEP(aesKey)) . base64(iv) . base64(AES-GCM(value))
  key_id TEXT NOT NULL,            -- vault key version
  hint TEXT,                       -- "…7Q2A" for key ids; NULL for secret keys
  allowed_labels_json TEXT NOT NULL DEFAULT '{}', -- only machines matching may receive it
  updated_at INTEGER NOT NULL, updated_by TEXT NOT NULL
);

CREATE TABLE provisioning_tasks (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL,      -- install | upgrade | uninstall
  target_host TEXT NOT NULL, ssh_user TEXT NOT NULL, ssh_method TEXT NOT NULL, -- tailscale | openssh
  os_hint TEXT, machine_name TEXT NOT NULL, labels_json TEXT NOT NULL DEFAULT '{}',
  provisioner_id TEXT NOT NULL REFERENCES machines(id),
  state TEXT NOT NULL,                          -- queued|claimed|running|waiting-enrol|succeeded|failed|cancelled
  steps_json TEXT NOT NULL DEFAULT '[]',        -- [{step,status,detail,at}]
  log_tail TEXT, error TEXT, result_machine_id TEXT,
  created_by TEXT NOT NULL, created_at INTEGER NOT NULL, started_at INTEGER, finished_at INTEGER
);

CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL,
  actor TEXT NOT NULL,             -- "conal@…", "service:menubar", "machine:m_…", "system"
  action TEXT NOT NULL,            -- job.update, job.run, secret.put, machine.revoke, provision.create …
  target TEXT, before_json TEXT, after_json TEXT, ip TEXT
);
CREATE INDEX audit_at ON audit_log(at DESC);

CREATE TABLE settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL);
-- global_pause, retention, agent_channel/desired_version, jobs_version (cache key), vault_public_key
