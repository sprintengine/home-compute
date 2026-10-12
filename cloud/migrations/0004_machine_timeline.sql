-- M4 (the dashboard), not in the §2 schema: a machine's page shows what it
-- ran in the last 24 hours. runs_by_machine is (machine_id, state), so that
-- query would read every run the machine ever held (D1 bills rows scanned);
-- with this index it reads only the day's.
CREATE INDEX runs_by_machine_claimed ON runs(machine_id, claimed_at);
