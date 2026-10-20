#!/bin/sh
# A local admin session against the DEPLOYED database, for when Access is not
# (yet) in front of hc-web or no service token exists: hc-web's own code runs
# under `wrangler dev` on 127.0.0.1, with its D1 binding pointed at the remote
# database ("remote": true). DEV_ACCESS_EMAIL signs every loopback request in
# as LOCAL_ADMIN, an admin through BOOTSTRAP_ADMINS, so every change still goes
# through the /v1 API's checks and lands in the audit log under that name.
# Needs `wrangler login` (whoever can run this can already edit the database).
#
#   cloud/scripts/local-admin.sh            # http://127.0.0.1:8790 until Ctrl-C
#   HC_URL=http://127.0.0.1:8790 node src/cli.mjs cloud import …
#
# Never set DEV_ACCESS_EMAIL on a deployed Worker (it is ignored there anyway:
# it only applies to loopback host names).
set -eu
cd "$(dirname "$0")/.."
PORT="${HC_ADMIN_PORT:-8790}"
LOCAL_ADMIN="${HC_LOCAL_ADMIN:-local-admin@home-compute.invalid}"
mkdir -p .admin
node -e '
const fs = require("fs");
const text = fs.readFileSync("wrangler.web.jsonc", "utf8").replace(/^\s*\/\/.*$/gm, "");
const config = JSON.parse(text);
config.main = "../src/hc-web.mjs";
// Its own name: wrangler reaches the remote database through a proxy on the Worker workers.dev
// host, and the hc-web host is behind Access, which a local session has no token for.
config.name = `${config.name}-local-admin`;
config.assets.directory = "../../dashboard";
config.d1_databases = config.d1_databases.map((database) => ({ ...database, migrations_dir: "../migrations", remote: true }));
config.$schema = undefined;
fs.writeFileSync(".admin/wrangler.jsonc", JSON.stringify(config, null, 2));
'
# The vault public key (if any) comes from the deployed Worker's own value, which
# `wrangler dev` cannot read; pass it as HC_VAULT_PUBLIC_KEY to encrypt locally.
exec npx wrangler dev -c .admin/wrangler.jsonc --ip 127.0.0.1 --port "$PORT" --inspector-port 0 \
  --var "DEV_ACCESS_EMAIL:$LOCAL_ADMIN" --var "BOOTSTRAP_ADMINS:$LOCAL_ADMIN" --var "CSRF_KEY:local-admin-session" \
  ${HC_VAULT_PUBLIC_KEY:+--var "VAULT_PUBLIC_KEY:$HC_VAULT_PUBLIC_KEY"}
