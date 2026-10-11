# Dashboard, run history and remote access

The controller serves a small web dashboard of its own, for a phone or any
browser: which jobs are running, queued, idle, paused or off, what each last
run did, its history, a run's log with its error lines marked, and Run now,
Pause/Resume and timetable edits. It is static HTML, CSS and JavaScript in
`dashboard/`, served at `/` next to the API. There is no build step and
nothing is fetched from anywhere else, so it works offline on a tailnet.

The controller keeps listening on `127.0.0.1` only. A tailnet reaches it
through `tailscale serve`, on a port of its own, over HTTPS.

## What it shows

- **Overview.** Jobs needing attention come first, in red: a last run that
  failed, a submission Bacalhau refused, or a run whose state can't be read.
  Then what is running or queued (waiting for capacity), then every other
  job: last run time, how long it took, its outcome (Published, No new run,
  Failed, Completed), the model runs it published, peak memory when the job
  reports it, and when it is next due. Jobs switched off in the timetable
  share one line at the end.
- **A job.** Run now, Pause/Resume, the timetable (editable, see below), the
  last published run per model, and its run history: start, duration,
  outcome, queue time, exit code, peak memory, runs published.
- **A run.** Its timing, error and the end of its output when it failed,
  every numeric field its reports carried, each report with its phases, and
  the last 500 lines of its log with error lines (error levels, `*Error:`,
  Python tracebacks, `*_failed` reports) highlighted, an "Errors only"
  filter and a jump to the first error.

It follows `GET /v1/events` and refreshes on every event, with a poll every
minute (every 15 s while the stream is down) and on returning to the tab.

## API additions

| | |
| --- | --- |
| `GET /v1/jobs/:id/runs[?limit=N]` | The job's kept runs, newest first, with reports. |
| `GET /v1/runs/:bacalhauJobId/logs[?lines=N]` | The end of one of this controller's runs' logs: at most 500 lines and 256 KB, redacted, each line `{text, level}` with `level` one of `error`, `warning`, `report`, `info`; plus `errorCount`, `truncated`, `partial` (a running job read so far). A finished run's log is cached. Runs the controller did not submit are 404. |
| `POST /v1/reload` | Re-read the configuration file and apply its jobs now (also `kill -HUP`). Answers `{added, removed, changed, restartRequired}`; `restartRequired` names other sections that changed and need a restart. An invalid file is refused (422) and nothing changes. |
| `POST /v1/jobs/:id/timetable` | `{"enabled": bool, "hours": [..] or "every", "minutes": [..]}`, any subset. Runs the configured timetable command, then reloads. 501 if none is configured, 422 with the command's own error if it refuses. |
| `GET /v1/session` | Who the browser is: `{authenticated, method, login?, csrfToken}`, or how it could sign in. |
| `POST /v1/session` / `DELETE /v1/session` | Sign in with `{"token": ...}` (sets the cookie), sign out. |
| `POST /v1/session/link` | Bearer token only: a one-time sign-in URL, good for 60 s (the menu bar app's "Open dashboard"). `/login?code=...&next=#/job/...` redeems it. |

The snapshot gains, per job, `recentRuns` (the five newest, without reports),
`runsUrl` and, while running, `activeState` (Bacalhau's `Queued`/`Running`);
and `controller.features`, `controller.configLoadedAt`, `timetable.editable`.
The event stream sends `config_reloaded` and a comment line every 25 s so
idle proxies keep it open.

## Run history

Each job's last `history.keep` (default 50) runs live in
`<state directory>/history/<job>.json` (mode 600), written when a run is
submitted, starts, and finishes. A run records `submittedAt`, `startedAt`
and `finishedAt` (from Bacalhau's own job history), `queueSeconds`,
`durationSeconds`, `state`, `outcome`, `exitCode`, `source` (`schedule`,
`manual`), the Bacalhau job id, its JSON-line reports (up to 32 KB, newest
kept), and on failure `error` and `failureDetail`, the last 40 lines of its
output.

`metrics` holds every top-level numeric field of the run's reports, with
nothing named in code: the largest value of a field starting `peak`/`max`
(`peakMemoryMb`), and the sum of the others over the run's reports
(`seconds`, `cpuSeconds`, `objects`), so a field a workload starts reporting
shows up as it is. The dashboard formats names ending `Mb`, `Bytes` and
`Seconds` by their unit.

A job with no history file starts from what its state record says of its
last run (`source: "state"`), so upgrading does not start from nothing.

Everything kept from a run's output, and every log served, passes through
the same redaction: the values of the environment variables jobs are given
(the names `render` redacts) where the name says credential (`KEY`,
`SECRET`, `TOKEN`, `PASSWORD`...) or locator (`URL`, `ENDPOINT`), the API
token, and credential shapes (AWS key ids, `secret=...`, `Bearer ...`,
pre-signed URL signatures, `user:password@`). Short ordinary values such as
`0` or `auto` are left alone; they are not secret and would mangle the log.

## Editing the timetable

A job's timetable belongs to its project: for Wingfoil, `deploy/local/jobs.toml`,
from which `deploy/schedules.py` generates the very file the controller reads.
Editing the generated JSON from the controller would be overwritten at the
next regeneration, and teaching the controller TOML would tie it to one
project. So the controller calls the project's own editor, then reloads:

```json
"timetable": { "command": ["./macmini.sh", "jobs", "set"], "timeoutSeconds": 120 }
```

The command is run directly, never through a shell, from the configuration's
directory (a relative program is resolved against it, and must be a path,
not a bare name looked up on `PATH`), with the arguments

```text
JOB [--enabled true|false] [--hours every|H,H,...] [--minutes M,M,...]
```

built only from a configured job id and validated booleans and whole numbers,
never from request text. It succeeds when it exits 0 and its last JSON line,
if any, is not `{"ok": false, "error": ...}`; that error is shown to the user
(Wingfoil's, for example, insists on five-minute marks). One edit runs at a
time.

The reload that follows is the same as `POST /v1/reload`. It reads and
validates the whole file first and changes nothing if that fails. It then
swaps the job list in between two scheduler passes (the reconcile loop and
every API action share one queue), so a pass never sees half a change. State
is keyed by job id, so a job's last run, pause and history carry over; a job
switched back on is due at its next slot, or at once if a slot passed since
it last ran, as on a restart. Only jobs change in place: a new token, port,
Bacalhau address or dashboard setting is reported in `restartRequired` and
waits for a restart.

Without `timetable.command` the dashboard shows the timetable read-only,
with how to change it.

## Signing in, and the threat model

The dashboard and API are one server on `127.0.0.1:4786`. A request is one of:

| Method | How | Allowed for |
| --- | --- | --- |
| `token` | `Authorization: Bearer <HOME_COMPUTE_API_TOKEN>` | the menu bar app, scripts, `macmini.sh` |
| `tailscale` | `Tailscale-User-Login` added by `tailscale serve` | logins in `dashboard.allowedLogins` |
| `session` | `hc_session` cookie from a token sign-in or a one-time link | a browser that knew the token, or was opened by the menu bar app |
| `local` | no token configured, request straight from this machine | the controller's tokenless behaviour |

**Who can reach it.** Only processes on the Mac, and, through `tailscale
serve`, devices on your tailnet. Never use `tailscale funnel` for it: that
would publish it to the internet (the helper script refuses a funnelled port).

**Tailnet users.** `tailscale serve` connects from loopback and sets
`Tailscale-User-Login` to the tailnet user of the device it proxies for,
replacing any such header the device sent; tagged devices get none. The
controller believes the header only on a loopback connection and only for a
login in the allow-list. Anyone else on the tailnet gets the sign-in page and
needs the token.

**Local processes.** Anything that can open a TCP connection to
127.0.0.1:4786 can also write that header, so it can claim an allowed
login. On a single-user Mac those are your own processes, which could read
the token from `.env` anyway. On a shared machine, leave
`dashboard.allowedLogins` empty and sign in with the token.

**Browsers.** Browser identities (tailscale, session, local) are accepted only
for a `Host` this controller answers to (`127.0.0.1`, `localhost`, `*.ts.net`,
`dashboard.hosts`), which defeats DNS rebinding: a hostile page cannot rename
itself to reach the loopback API. Every state-changing browser request must
come from its own origin (`Origin`, `Sec-Fetch-Site`) and carry the CSRF
token `GET /v1/session` handed out; the token is an HMAC of the login (for
tailnet users) or random per session, and is never in a cookie. Cross-origin
reads are blocked by the browser, as the API sends no CORS headers.

**Cookies.** `HttpOnly; SameSite=Strict; Path=/`, kept in memory (a restart
signs token sessions out) and good for `dashboard.sessionHours` (a week).
Over `tailscale serve --https` it is `__Host-hc_session` with `Secure`. On
`http://127.0.0.1:4786` it is not `Secure` (not every browser keeps a Secure
cookie from plain http); it never leaves the machine there. Cookies are per host, not per port,
so another local service on 127.0.0.1, or the service `tailscale serve`
already puts on the same tailnet name, would be sent it; both are yours.

**Token sign-in** is throttled after 10 failures in 10 minutes. The one-time
links the menu bar app opens are 256-bit, single-use and expire in a minute.

**Responses** carry a strict Content-Security-Policy (scripts, styles and
connections only from the dashboard itself, no framing), `nosniff`, no
referrer, and the dashboard writes every value as text, never markup.

**Tokenless controllers** (no `api.tokenEnv`) used to accept any request.
They now accept only direct local requests: not proxied ones (so `tailscale
serve` does not open them to the tailnet), not a foreign `Host`, and not a
cross-site browser post.

## Configuration

```json
"history": { "keep": 50 },
"dashboard": {
  "allowedLoginsEnv": "HOME_COMPUTE_DASHBOARD_LOGINS",
  "allowedLogins": [],
  "hosts": [],
  "sessionHours": 168,
  "enabled": true
},
"timetable": { "command": ["./macmini.sh", "jobs", "set"], "timeoutSeconds": 120 }
```

All optional. `allowedLoginsEnv` names an environment variable (or `.env`
entry) with comma-separated logins, keeping addresses out of versioned
configuration; `allowedLogins` lists them inline; both add up. `hosts` adds
host names the dashboard may be reached by, beyond loopback and `*.ts.net`.
`enabled: false` serves the API only.

## Reaching it from your phone over Tailscale

1. **Enable HTTPS certificates for the tailnet, once:** Tailscale admin
   console › DNS › HTTPS Certificates › Enable. (This tailnet has none yet:
   `tailscale status --json` shows no `CertDomains`.) The machine's name then
   appears in public Certificate Transparency logs; its address does not.
2. **Serve the controller on its own HTTPS port:**

   ```sh
   scripts/tailscale-dashboard.sh          # shows what it would do and the current serve config
   scripts/tailscale-dashboard.sh on       # = tailscale serve --bg --https=8443 http://127.0.0.1:4786
   ```

   On macOS with the app, `tailscale` is
   `/Applications/Tailscale.app/Contents/MacOS/Tailscale`. The script uses
   port 8443 (`HC_TAILNET_PORT` to change it), refuses a port that already
   serves something else, and never funnels. Other `serve` entries, such as
   the one on port 80, are left as they are. `scripts/tailscale-dashboard.sh
   off` (`tailscale serve --https=8443 off`) undoes it; `--bg` makes it
   persist across restarts until then.
3. **On the phone**, with Tailscale connected, open
   `https://<machine>.<tailnet>.ts.net:8443/` and add it to the home screen.
   An allowed login goes straight in; otherwise paste the API token once.

If HTTPS certificates must stay off, `tailscale serve --bg --http=8780
http://127.0.0.1:4786` works too (WireGuard still encrypts it between
devices), but the browser treats the page as insecure and the cookie cannot
be `Secure`.

## On the Mac

The menu bar app's **Open dashboard** opens `http://127.0.0.1:4786/` already
signed in (a one-time link minted with its token), and its "Recent runs" rows
open that run's page.

## On the hosted control plane (M4)

The same `dashboard/` is the hosted control plane's web app: `hc-web` serves
it as static assets behind Cloudflare Access (see
[cloud/README.md](../cloud/README.md#the-dashboard-m4) for how it signs in,
polls and works offline). It notices which it is talking to: against the
local controller it keeps the token sign-in, the event stream and the pages
above; against `hc-web` it adds machines, the timetable grid, settings and
the audit log. Every page is laid out for a 390-pixel phone first, with a
tab bar at the bottom, and for a desktop with a sidebar.

- **Overview.** *Needs attention* first, the critical items before the
  warnings: a last run that failed (with its error), a run lost in the last
  day that no later run has settled, a run waiting more than ten minutes
  (with why: `no machine has labels gpu=yes`, `preferred mac-mini busy`), a
  machine offline, unhealthy or whose VM failed to start (with Colima's
  error), a clock more than 30 s off, an agent older than the desired
  version, and jobs blocked on vault secrets (one line per reason). Then
  *Running now* (job, machine, phase including starting the VM and pulling,
  elapsed time, peak memory against the limit), *Next up* (the next six
  slots, in UTC and Irish time, with the machine expected to take each), and
  a card per job: its schedule in UTC with Irish time beside it, last
  outcome, published model runs, and a sparkline of its last 20 runs'
  durations (failures in red). Jobs switched off fold into one line.
- **A job.** Run now (with optional extra arguments, quoted as in a shell),
  Pause/Resume, Enable/Switch off; the timetable editor (hour chips, minute
  chips, every hour, with the resulting slots previewed in UTC and Irish
  time); placement (required labels, preferred machine, how long to wait for
  it); resources (CPU, disk, and a memory picker with "peak 410 MiB over 20
  runs; limit 1 GiB", warning below the peak plus 10%); the image, the digest
  that last ran and, for an admin, "pin to the digest that last ran"; the
  rest of the definition (arguments, environment and secret names, timeout,
  policy, reports, revision); and the run history (time, machine, queue
  wait, duration, peak memory, outcome, error), loaded as it scrolls.
- **A run.** Its phases (due, claimed, VM, pull, run, report, finished) with
  the time each began and how long it took (the agent's own measurements for
  VM wait, pull and run), stats (peak memory, the workload's own peak when it
  reports one, CPU, samples, exit code, image digest), reports, the error
  with its traceback, the log tail with errors highlighted, errors only and a
  jump to the first; Cancel (with a confirmation) or Retry.
- **Machines.** Status (online, offline, draining, unhealthy), the VM (state,
  size, up since), current runs, caps, labels, agent version, last seen and
  clock skew; Drain/Undrain. A machine's page adds the VM's boot time and
  uptime over the last day, free capacity, OS and runtime, last IP,
  credential age, a 24-hour timeline of its VM and runs, and its runs; an
  admin can edit its name, labels and caps, and revoke it after typing its
  name. **Add machine** makes a join token, shows it once with the install
  and enrol commands for macOS and Linux (agent/README.md, "Install by
  hand"), and forgets it when the page is left; installing over SSH is M6.
- **Timetable.** Every job on a 24-hour UTC grid with the Irish hour under
  each column (a list by hour on a phone), hourly and interval jobs on a
  line each, switched-off jobs folded.
- **Settings and audit.** The global pause (operators), retention, the
  agent version machines should run and roles (admins), who you are and
  Access's sign-out; the audit log, newest first, loaded as it scrolls.
  Secrets get their page with the vault (M5).
