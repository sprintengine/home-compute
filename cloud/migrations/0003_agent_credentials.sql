-- M2 (the agent protocol), not in the §2 schema: when a machine's credential
-- was issued, so hc-core can rotate old ones (§5), and when someone asked for
-- a rotation from the dashboard. The new credential itself can only be made
-- by hc-core, in its answer to the machine's next sync.
ALTER TABLE machines ADD COLUMN credential_issued_at INTEGER;
ALTER TABLE machines ADD COLUMN rotate_requested_at INTEGER;
