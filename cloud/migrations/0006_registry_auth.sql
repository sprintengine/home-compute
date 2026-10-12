-- M5 (§4.5): a job pulling from a private registry names its credential in
-- the vault, `"vault:<secret>"` (JSON-encoded like the other definition
-- columns). The secret's value is `{"server", "username", "password"}`; hc-core
-- opens it into the claim's `spec.registryAuth`, for that pull only.
ALTER TABLE jobs ADD COLUMN registry_auth_json TEXT;
