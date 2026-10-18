# Deploying and running the hosted control plane

The runbook for the deployment of [hosted-control-plane.md](hosted-control-plane.md):
what is deployed, how to change it, the Mac mini's agent, alerts, and the
per-job cut-over from the Bacalhau-era controller (§9). Commands run from a
checkout of this repository with `npm ci` done, and `wrangler login` as the
Cloudflare account's owner.

Throughout, set these once per shell (the real hostnames are in the
deployment's own notes and in `gh variable list`; they are left out of this
public file):

```sh
export HC_CORE=https://hc-core.<subdomain>.workers.dev   # agents, cron, /health
export HC_WEB=https://hc-web.<subdomain>.workers.dev     # the dashboard and /v1, behind Access
```

## 1. What is deployed

| Piece | What | Where it is configured |
| --- | --- | --- |
| D1 `home-compute` | Western Europe (`--location weur`), migrations `0001`–`0006` | `database_id` in both `cloud/wrangler.*.jsonc` |
| Worker `hc-core` | Agent API, `* * * * *` cron (slots, leases, timeouts, retention, alerts), `/health`, `/health/cron` | `cloud/wrangler.core.jsonc`; secrets `VAULT_PRIVATE_KEY`, `ALERT_EMAIL_TO`, `ALERT_EMAIL_FROM`, `DASHBOARD_URL`; binding `ALERT_EMAIL` (`send_email`) |
| Worker `hc-web` | Dashboard (static assets) and `/v1`; validates the Access JWT itself and refuses everything until `ACCESS_TEAM_DOMAIN`/`ACCESS_AUD` are set | `cloud/wrangler.web.jsonc`; secrets `CSRF_KEY`, `BOOTSTRAP_ADMINS`, `CORE_URL`, `VAULT_PUBLIC_KEY`, `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD` |
| Email Routing | Alerts go from an address on a zone with Email Routing on (`sprintengine.ai`) to the owner's verified address | Cloudflare › Email › Email Routing › Destination addresses |
| Dead-man check | `.github/workflows/deadman.yml` every 10 minutes (from `main`) | repository variables `HC_CORE_URL`, `HC_WEB_URL` |
| Mac mini agent | LaunchAgent `dev.homecompute.agent`, Colima profile `home-compute` (cap 2 CPU / 3 GiB, started on demand) | `~/Library/Application Support/home-compute/config.json` |
| Shadow comparison | LaunchAgent `dev.homecompute.shadow-compare`, twice an hour until its 48 hours are done | `~/Library/LaunchAgents/dev.homecompute.shadow-compare.plist` |

Workers' secrets are listed with `npx wrangler secret list -c cloud/wrangler.<web|core>.jsonc`
(names only). Preview URLs are off for both Workers, so each has one public
hostname.

## 2. Deploying a change

```sh
cd cloud
npm test                                                             # workerd, Miniflare and browser tests
npx wrangler d1 migrations apply home-compute --remote -c wrangler.web.jsonc   # first: new code reads new columns
npx wrangler deploy -c wrangler.core.jsonc
npx wrangler deploy -c wrangler.web.jsonc
curl -fsS "$HC_CORE/health/cron"                                     # 200 once the cron ticked in the last 5 minutes
```

The cron trigger never changes on a redeploy (a trigger change takes up to 15
minutes to propagate). Rolling back is `npx wrangler rollback -c
wrangler.<core|web>.jsonc`; migrations only ever add, so an older Worker
runs on the newer schema. D1 Time Travel restores the database to any minute
of the last 7 days (`npx wrangler d1 time-travel restore home-compute
--timestamp …`).

### First deployment (done 2026-10-12; for a new account)

1. `npx wrangler d1 create home-compute --location weur`; put the id in both configs; apply the migrations as above.
2. Set the global pause before anything is imported:
   `npx wrangler d1 execute home-compute --remote -c wrangler.core.jsonc --command "INSERT INTO settings (key, value_json) VALUES ('global_pause','true')"`.
3. Vault keys, made in memory and stored only as Worker secrets (`node --input-type=module -e 'import("./src/core/vault.mjs").then(async (v) => console.log(JSON.stringify(await v.generateVaultKeys())))'`
   into a 0600 file you delete afterwards): `VAULT_PRIVATE_KEY` on hc-core, `VAULT_PUBLIC_KEY` on hc-web
   (`npx wrangler secret bulk <file.json> -c …`). Losing the private key only means putting the secrets again.
4. hc-core's `ALERT_EMAIL_TO` (a verified Email Routing destination), `ALERT_EMAIL_FROM` (an address on a zone with Email Routing on) and `DASHBOARD_URL`; hc-web's `CSRF_KEY` (48 random bytes), `BOOTSTRAP_ADMINS` (the owner's email) and `CORE_URL`.
5. Deploy both Workers, then import (§4) and enrol the agent (§6).

## 2a. Cloudflare Containers (optional, one job at a time)

Not part of the deploy above. Containers need the Workers Paid plan, an image
in Cloudflare's registry (`cloud/scripts/set-container-image.sh`), and a job
whose placement is `runtime=cloudflare-container`. How a run goes, the sizes,
the cost and the checklist are [cloudflare-containers.md](cloudflare-containers.md).
Drain the machine named `cloudflare` to stop new container runs. Do not add an
R2 binding; jobs keep using S3 keys as vault secrets.

## 3. Signing in: Cloudflare Access (owner)

`hc-web` refuses every `/v1` request until Access is set up (the dashboard's
files load, its data does not). The account has no Zero Trust organisation
yet, and the `wrangler login` token has no Access scope, so this is the
owner's, in the Cloudflare dashboard:

1. **Zero Trust › Get started**: pick a team name (it becomes
   `<team>.cloudflareaccess.com`) and the Free plan.
2. **Workers & Pages › hc-web › Settings › Domains & Routes › workers.dev ›
   Enable Cloudflare Access.** Then *Manage Cloudflare Access*: keep the
   policy to the owner's email only (one-time PIN, Google or GitHub as login
   methods), and copy the application's **AUD tag**.
3. Set the team domain and the AUD tag as Worker secrets, from `cloud/`.
   They are the owner's own, so they stay out of `wrangler.web.jsonc`. A
   plain var of the same name cannot exist: `wrangler deploy` replaces vars
   from that file, while secrets survive it.

   ```sh
   npx wrangler secret put ACCESS_TEAM_DOMAIN -c wrangler.web.jsonc
   npx wrangler secret put ACCESS_AUD -c wrangler.web.jsonc
   npx wrangler deploy -c wrangler.web.jsonc
   ```

   `ACCESS_TEAM_DOMAIN` is the team hostname (`<team>.cloudflareaccess.com`).
   A pasted URL is accepted: any scheme and trailing slashes are stripped,
   and the issuer is `https://<host>`. `ACCESS_AUD` is the application's AUD
   tag. `BOOTSTRAP_ADMINS` (already a secret) makes the owner an admin.
4. For the CLI and, later, the menu bar app: **Access › Service auth ›
   Create service token**, add a *Service Auth* rule for it to the
   application's policy, and give it a role in the dashboard (Settings ›
   Roles: `service:<client id>` → `admin` for the CLI). The CLI reads
   `HC_ACCESS_CLIENT_ID` and `HC_ACCESS_CLIENT_SECRET`.

Alternatively, an API token with *Access: Apps and Policies — Edit* and
*Access: Organizations, Identity Providers, and Groups — Edit* lets a
script do steps 2 and 4 (the Zero Trust organisation itself still needs
step 1 once).

Until then, and as a break-glass afterwards, an admin session runs hc-web's
own code locally against the deployed database (the change goes through the
same `/v1` checks and the audit log, as `local-admin@home-compute.invalid`):

```sh
# The public key is only needed to set secrets; on the Mac mini a copy is kept (0600) beside the agent's state.
HC_VAULT_PUBLIC_KEY="$(cat "$HOME/Library/Application Support/home-compute/vault-public-key")" cloud/scripts/local-admin.sh   # http://127.0.0.1:8790
export HC_ADMIN=http://127.0.0.1:8790
HC_URL=$HC_ADMIN node src/cli.mjs cloud secrets list
```

## 4. Jobs and secrets

```sh
# The Wingfoil timetable, from Wingfoil's generated file (jobs.toml → deploy/schedules.py → home-compute.json).
HC_URL=$HC_ADMIN node src/cli.mjs cloud import ../wingfoil/deploy/home-compute/home-compute.json --preset wingfoil --dry-run
HC_URL=$HC_ADMIN node src/cli.mjs cloud import ../wingfoil/deploy/home-compute/home-compute.json --preset wingfoil \
  [--paused] [--env-file ../wingfoil/deploy/home-compute/.env --upload-secrets --labels site=home]
```

`--paused` pauses jobs it creates (existing jobs keep their pause). With
`--upload-secrets` the preset's four R2 values are read from the env file and
sealed by hc-web; only their names are printed. `--labels site=home` means
only machines labelled `site=home` ever receive them.

Secrets one at a time (values only from stdin, never argv):

```sh
HC_URL=$HC_ADMIN node src/cli.mjs cloud secrets list
printf '%s' "$VALUE" | HC_URL=$HC_ADMIN node src/cli.mjs cloud secrets put NAME [--labels site=home]
HC_URL=$HC_ADMIN node src/cli.mjs cloud secrets delete NAME
```

A private registry's credential is a secret whose value is
`{"server":"ghcr.io","username":"…","password":"<read:packages token>"}`;
a job names it with `registryAuth: "vault:<name>"` (`PATCH
/v1/jobs/<id>/image {"registryAuth": "vault:ghcr-read"}`, admin).

**Rotating the vault key pair:** make a new pair (§2, step 3), set both
Worker secrets, deploy, then put every secret again (`secrets put-env` for
Wingfoil). Until a secret is put again it is listed as sealed under an older
key and its jobs' claims fail with `wrong_key`, never run without it.

## 5. Alerts

The owner is emailed, with no need to look:

| Alert | When | Resolves |
| --- | --- | --- |
| `job-failing:<job>` | its last two runs failed (exit code, OOM, timeout, a secret it could not get) | a run succeeds |
| `stale:<job>:<model>` | the model's published `run` is older than its `maxAgeHours` (Wingfoil's `registry.py`) **and** the job's first slot after that, plus an hour, did not fix it; read from the job's own published reports and from the public pointer every 15 minutes, so it works for jobs still on the old controller | a newer run is published |
| `no-machine` | no enrolled machine has synced for 10 minutes | a sync |
| `waiting:<job>` | a run due more than 15 minutes ago is still waiting (not counting scheduled runs held by a pause) | it is claimed |
| the cron itself | hc-core's cron has not ticked for 5 minutes | the dead-man check (below), not email |

One email when problems start, one when they end, a reminder each day while
they last; changes within 5 minutes share one email. Every page of the
dashboard shows the open alerts, a stopped cron, and failing email delivery,
at the top. Settings › Alerts has *Send a test alert*; from the CLI:
`HC_URL=$HC_ADMIN node src/cli.mjs cloud alert-test` (the next cron minute
emails it). If email fails (an unverified destination, a missing binding),
the dashboard says why and hc-core retries every 10 minutes.

**Dead-man check.** `.github/workflows/deadman.yml` runs every 10 minutes from
`main` and asks `$HC_CORE/health/cron` (503 unless the cron ticked in the
last 5 minutes and D1 answers) and whether `$HC_WEB` answers at all. A
failure still there a minute later opens the issue *Home Compute control
plane is not answering* (label `deadman`), which GitHub emails to watchers;
the next good check closes it. Run it by hand from the Actions tab
(*Run workflow*).

## 6. The Mac mini agent

Installed by hand (agent/README.md, "Install by hand"):

- Agent `~/Library/Application Support/home-compute/agent/current/home-compute-agent.mjs`,
  Node linked from Homebrew, state and credential (0600) beside it, log
  `~/Library/Logs/home-compute/agent.log`.
- LaunchAgent `dev.homecompute.agent` (`RunAtLoad`, `KeepAlive`,
  `AbandonProcessGroup` so the VM outlives an agent restart).
- Labels `arch=arm64, os=darwin, runtime=colima, site=home`; caps 2 CPU,
  3072 MiB, 2 runs; Colima profile `home-compute`, never `default`.
- `allowImages`: `ghcr.io/sprintengine/*`, `docker.io/library/alpine*`,
  `wingfoil-forecast:local` (with `allowLocalImages`).

```sh
A="$HOME/Library/Application Support/home-compute"
"$A/node/bin/node" "$A/agent/current/home-compute-agent.mjs" status     # connection, VM, runs, outbox
"$A/node/bin/node" "$A/agent/current/home-compute-agent.mjs" doctor     # add --start-vm to boot and time the VM
launchctl kickstart -k gui/$(id -u)/dev.homecompute.agent             # restart (runs are adopted)
```

Updating the agent: `npm run build:agent`, copy `agent/dist/home-compute-agent.mjs`
over the installed one, `launchctl kickstart -k …` (runs in progress are adopted).

**Unattended operation.** The Mac never sleeps (`pmset sleep 0`) and restarts
after a power failure (`autorestart 1`); while a run is active or due on
this machine within 15 minutes the agent also holds `caffeinate -i`. The VM
starts on demand (a claim, or a pre-warm before a slot) and stops after 5
idle minutes. After a reboot the LaunchAgent starts only once the owner's
user session exists: **turn on automatic login** (System Settings › Users &
Groups › Automatically log in as; FileVault is off, which it requires), or
nothing runs until someone logs in. The same holds for the old controller
and Bacalhau, which are LaunchAgents too.

What was tested on 2026-10-12 (no reboot):

| Test | What happened |
| --- | --- |
| `kickstart -k` while idle and mid-run | Restarted within seconds; the run's container was adopted and the run finished normally. |
| `kill -9` of the agent mid-run | launchd restarted it in about a second; adopted; finished `succeeded`, never `lost`. |
| Network cut for 4 min 16 s mid-run (the agent's traffic only, through a proxy that refused connections) | The container ran on and finished; its result waited in the outbox; the lease ran out and hc-core marked the run `lost`; when the network came back the result arrived and the run became `succeeded` with `recovered`. |
| Simulated reboot mid-run (agent unloaded, `home-compute` VM stopped, agent loaded again) | The agent started the VM because its run records expected a container (the boot took 104 s on a loaded Mac, during which it did not sync, so hc-core marked the run `lost`), found the container killed (exit 143) and reported `failed` (`recovered`). For Wingfoil the next slot does the work. |

## 7. Shadow mode (§9 phase 0)

All Wingfoil jobs are imported paused, under the global pause: each slot is
recorded as `skipped (paused-at-slot)` and nothing runs. The comparison
`cloud/scripts/shadow-compare.mjs` runs at :27 and :57 under the LaunchAgent
`dev.homecompute.shadow-compare`: it adds the controller's submissions
(its history files and `bacalhau job list`: job name, label and creation
time only, since Bacalhau's job specs hold the secrets) to a ledger and
compares them with the hosted slots for the window. Reports:
`~/Library/Application Support/home-compute/shadow/latest.md` while it runs,
`final.md` once the 48 hours have passed (and a comment on the pull request,
when started with `--pr`). Exit status 1 means differences.

```sh
node cloud/scripts/shadow-compare.mjs --start 2026-10-12T15:50:00Z --hours 48   # by hand, any time
launchctl bootout gui/$(id -u)/dev.homecompute.shadow-compare                   # when done
```

## 8. Cut-over, one job at a time (§9 phases 2–4)

Not started. Each job is enabled in exactly one system at a time: paused on
the old controller first, then resumed hosted, between two of its slots.
Every step is reversible on its own.

### Before the first job

1. The shadow comparison's `final.md` says *No differences* (or each
   difference is explained).
2. Access is set up (§3), or use the local admin session.
3. Choose what image the hosted jobs run. Today they name
   `ghcr.io/sprintengine/wingfoil-forecast:production`, which is private and
   for which the Mac has no login, while the old controller runs the locally
   built `wingfoil-forecast:local`. Either:
   - **(designed) the released image:** make a token with `read:packages`,
     `printf '%s' '{"server":"ghcr.io","username":"<github user>","password":"<token>"}' | HC_URL=$HC_ADMIN node src/cli.mjs cloud secrets put ghcr-read --labels site=home`,
     then for each Wingfoil job `curl -fsS -X PATCH "$HC_ADMIN/v1/jobs/<id>/image" -H 'content-type: application/json' -d '{"image":"ghcr.io/sprintengine/wingfoil-forecast@sha256:<production digest>","registryAuth":"vault:ghcr-read"}'`
     (the digest: `docker buildx imagetools inspect ghcr.io/sprintengine/wingfoil-forecast:production` after `docker login ghcr.io`); or
   - **(what runs today) the local build:** for each Wingfoil job
     `curl -fsS -X PATCH "$HC_ADMIN/v1/jobs/<id>/image" -H 'content-type: application/json' -d '{"image":"wingfoil-forecast:local"}'`
     and `curl -fsS -X PATCH "$HC_ADMIN/v1/jobs/<id>/placement" -H 'content-type: application/json' -d '{"requireLabels":{"site":"home"}}'`,
     and after every rebuild copy it into the agent's profile while its VM runs:
     `DOCKER_HOST=unix://$HOME/.colima/default/docker.sock docker save wingfoil-forecast:local | DOCKER_HOST=unix://$HOME/.colima/home-compute/docker.sock docker load`.
4. Lift the hosted global pause. Every job stays paused on its own, so
   nothing runs yet: `curl -fsS -X POST "$HC_ADMIN/v1/resume-all" -H 'content-type: application/json' -d '{}'`.

### Helpers

```sh
OLD=http://127.0.0.1:4786
OLD_TOKEN=$(sed -n 's/^HOME_COMPUTE_API_TOKEN=//p' /Volumes/workdrive/wingfoil/deploy/home-compute/.env)
old()    { curl -fsS -X POST -H "Authorization: Bearer $OLD_TOKEN" "$OLD/v1/jobs/$1/$2"; echo; }        # old <job> pause|resume
hosted() { curl -fsS -X POST "$HC_ADMIN/v1/jobs/$1/$2" -H 'content-type: application/json' -d '{}'; echo; }  # hosted <job> pause|resume
where()  {                                                                                             # where <job>: who has it
  curl -fsS -H "Authorization: Bearer $OLD_TOKEN" "$OLD/v1/snapshot" | node -pe "const j=JSON.parse(require('fs').readFileSync(0)).jobs.find(j=>j.id==='$1'); 'old: '+(j.paused?'paused':'ACTIVE')+', next '+j.nextDueAt"
  curl -fsS "$HC_ADMIN/v1/jobs/$1" | node -pe "const j=JSON.parse(require('fs').readFileSync(0)); 'hosted: '+(j.paused?'paused':'ACTIVE')"
}
```

(With Access instead of the local session, `hosted` adds `-H "cf-access-client-id: $HC_ACCESS_CLIENT_ID" -H "cf-access-client-secret: $HC_ACCESS_CLIENT_SECRET"` and uses `$HC_WEB`.)

### Per job

Between two of its slots (not within 2 minutes of one):

1. `old <job> pause`, then `where <job>` says `old: paused`.
2. `hosted <job> resume`, then `where <job>` says `hosted: ACTIVE`.
3. After its next slot: the dashboard shows the run `succeeded` on
   `mac-mini`, and the model's pointer moved on, e.g.
   `curl -s https://data.wingfoil.ie/weather/gfs.json | node -pe 'JSON.parse(require("fs").readFileSync(0)).run'`.
4. Rollback, at any time: `hosted <job> pause`, then `old <job> resume`.

| Phase | Jobs, in order | Check before the next phase |
| --- | --- | --- |
| 2. Low risk | `verify`, `tides`, `icon-eu-weather`, `icon-eu` | each model's `run` advances on schedule and stays within `maxAgeHours` (no `stale` alert) |
| 3. Hourly | `blend`, `wind-obs`, `forecast-archive`, `sea-temperature`, `mi-swan`, `gfs`, `gfs-wave`, `harmonie`, `ecmwf` | no `waiting` alert (nothing waits more than 15 minutes; §9 asks 5); `memory_pressure` stays normal. Bacalhau's `default` profile is already 2 CPU / 3 GiB, so §9's shrink is not needed. |
| 4. Prune last, alone | `prune` | superseded runs are still removed 6–7 hours after replacement; never active in both systems |
| 5. Soak | all hosted, Bacalhau idle but installed, 7 days | no `lost` without recovery; no `stale` alert |

Whole rollback (about 2 minutes): `curl -fsS -X POST "$HC_ADMIN/v1/pause-all" -H 'content-type: application/json' -d '{}'`,
then `old <job> resume` for every job paused on the old controller. Never
resume a job on the old controller while it is active hosted.

Phase 6 (decommissioning Bacalhau, the old controller and `default`) is
M7's, after the soak.
