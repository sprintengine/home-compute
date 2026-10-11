# Home Compute Bar

A small native macOS menu bar app that monitors a Home Compute controller: which forecast jobs
are running, when each runs next, what the last run did, and which model runs were last published.
It can also run, pause and resume jobs, and its settings window is a control panel that sets up,
starts, stops and configures Home Compute on this Mac (services, R2 storage, the worker image and the
job timetable) through wingfoil's setup script.

The app is a client only. Quitting it, or never starting it, does not affect scheduling: the
Home Compute daemon and its launch agents keep running jobs either way.

## Requirements

- macOS 14 or later (built and tested on macOS 26, Apple silicon)
- Xcode or the Swift 6 toolchain, to build it

## Build

```sh
cd macos
swift build                  # debug build: .build/debug/HomeComputeBar
swift test                   # decoding, line splitting, timetable drafts, and the runner against dev/fake-setup.sh
./build-app.sh               # release build + "build/Home Compute Bar.app" (ad-hoc signed)
./build-app.sh --install     # same, then copies the app to ~/Applications
```

The app bundle has `LSUIElement` set, so it shows only a menu bar icon and no Dock icon.
Bundle id: `dev.sprintengine.home-compute-bar`. If the app is running when you reinstall it,
quit it from its popover and open it again.

## Configure

The controller URL and API token are read from `~/.config/home-compute/menubar.json`:

```json
{ "url": "http://127.0.0.1:4786", "token": "<HOME_COMPUTE_API_TOKEN>",
  "setupScript": "/path/to/wingfoil/deploy/home-compute/macmini.sh" }
```

If the file is missing, the app uses `http://127.0.0.1:4786` with no token and no setup script.
The setup script may write this file for you. You can also edit the values in **Settings… ›
Connection** in the popover. Saving writes them back to the same file (the directory is created if
needed and the file gets mode 600), and keeps any other keys already in the file. If the setup
script rewrites the file without `setupScript`, the app puts the path back. To use a different
file, set `HOME_COMPUTE_BAR_CONFIG=/path/to/menubar.json`, which is mainly for testing. The app
passes this variable on to the setup script.

The Connection tab also has:
- **Setup script**: **Choose…** opens a file picker for `macmini.sh` and saves the path at once.
- **Launch at login**, which uses `SMAppService`. It works only for the `.app` bundle and asks for
  approval in System Settings › General › Login Items when macOS requires it.
- **Also notify when a new forecast is published**. Failed jobs always post a notification. The
  first notification asks for permission. Notifications need the `.app` bundle; they are skipped
  when you run the bare `swift build` binary.

## Control panel

The settings window (**Settings…** in the popover, or ⌘,) has five tabs. Every action in the first
four runs the setup script as `/bin/bash <script> <args…>`. The script gets a fixed `PATH` that
includes Homebrew and `~/.local/bin`. Secrets go to the script on stdin, never in arguments.
Nothing runs on the main thread.

- **Services**: Colima, Bacalhau and the scheduler (the Home Compute controller), each with a
  coloured state and details (Colima's CPUs and memory, Bacalhau's node count). Buttons: **Start
  all**, **Stop all…**, **Restart** and **Restart scheduler only**. **Stop all…** asks you to
  confirm first. An import that is already running keeps going, but no new jobs are submitted.
  The tab also has a **Start Colima at login** toggle and buttons that open the scheduler log, the
  Bacalhau log and the logs folder in Console or Finder. Until setup is complete, a **Set up…**
  card explains what setup does (installs dependencies, builds the image, and writes `.env`, the
  token, `menubar.json` and the launch agents; it starts nothing), lists missing tools and shows
  what is already done. The state refreshes every 5 s while the window is open.
- **Storage**: the R2 bucket, endpoint, prefix and region, plus ECMWF source. The access key ID
  and secret are secure fields. They show only whether a key is stored and, for the key ID, its
  last characters. They are sent only when you type a new value. **Save** sends each changed field
  with `env set NAME`. **Test connection** runs `r2-test` and lists each model's published run and
  how long ago it was updated, and marks missing manifests. **Rotate API token…** asks you to
  confirm, then reloads the new token from `menubar.json`.
- **Worker image**: the image's name, when it was built, its size, and whether it is up to date or
  the code has changed since the build. **Rebuild image** rebuilds it. The next job submission
  uses the new image automatically.
- **Timetable**: one editor per job from `jobs --json`. Each job has an Enabled switch, an **Every
  hour** checkbox or a 24-hour grid of hour chips, minute chips in steps of `cronStepMinutes`, a
  memory picker that marks the default, and a summary such as "03:30, 09:30, 15:30, 21:30 UTC".
  **Save** sends only the changed options with `jobs set`. Validation errors from the script
  appear under the job. Jobs with a fixed schedule (prune) let you change only Enabled and memory.
- **Connection**: the controller URL and token, the setup script, launch at login and
  notifications, as described above.

After you save storage settings, rotate the token or edit the timetable, the tab shows a banner:
"Restart the scheduler to apply your changes". Its button runs `restart controller`.

Long commands (`setup`, `start`, `stop`, `restart`, `restart controller`, `image`,
`colima-autostart on|off`) stream their output into a log sheet with a spinner. ANSI colours are
stripped, and only the final state of `\r` progress lines is kept. There is no timeout. You can hide
the sheet while a command runs; a banner then shows its progress. When it finishes, the sheet
shows success or the exit code. Only one long command runs at a time.

JSON commands (`state`, `env`, `r2-test`, `token rotate`, `jobs`, `env set`, `jobs set`) must print
one JSON object. Exit 2 means a validation error: the app shows the `error` from
`{"ok": false, "error": …}`. Any other non-zero exit shows the script's stderr. These commands time
out after 30–120 s.

## What it shows

- **Menu bar icon**: `cloud.sun` when idle. When a job is running, it cycles through rain-cloud
  symbols, with a count when more than one job is running. `icloud.slash` means the controller is
  unreachable or rejected the token. A red dot means a job has failed since you last opened the
  popover.
- **Popover**:
  - When the scheduler is stopped or unreachable, a card at the top says so and has **Start** (runs
    `start` and shows its progress in place) and **Open settings**. When setup isn't complete,
    the card says "Not set up yet" and has **Set up…** instead. The app reads the services state at
    launch and each time the popover opens.
  - The header shows controller status (online, degraded or unreachable), the node count, the
    last update time, whether the event stream is live, and a refresh button.
  - "Running now" shows each running job with elapsed time.
  - The job list shows each job's models, schedule, next run, last result and the last fetched
    model run for each model.
  - Each job has a ⋯ menu (or right-click) with Run now, Pause and Resume.

The app follows `GET /v1/events` (Server-Sent Events) and fetches the snapshot again on every
event. If the stream drops, it reconnects with backoff. It also polls `GET /v1/snapshot` every
15 s in case events are missed.

## Develop against a fake controller

```sh
node dev/fake-controller.mjs --port 4799 --token dev-token --write-config /tmp/hcb/menubar.json
HOME_COMPUTE_BAR_CONFIG=/tmp/hcb/menubar.json "build/Home Compute Bar.app/Contents/MacOS/HomeComputeBar"
```

The fake controller serves three jobs: one running, one idle and one paused that failed.
Every 20 s the running job finishes, alternating between `failed` and `published`, and it is
resubmitted 5 s later. The fake controller logs every request. The app logs to stdout with the
prefix `[home-compute-bar]` and to the unified log (subsystem
`dev.sprintengine.home-compute-bar`).

## Develop against a fake setup script

`dev/fake-setup.sh` answers the same contract as `macmini.sh` without touching Colima, Bacalhau,
launchd or R2. Its state lives in `fake-setup/` next to `$HOME_COMPUTE_BAR_CONFIG`; delete that
directory to start over. It starts as not set up and stopped. Long commands stream output
with ANSI codes and `\r` progress lines. Some inputs deliberately fail with exit 2:
`env set S3_ENDPOINT_URL` without `https://`, and `jobs set` with minutes that aren't multiples
of 5 or a schedule change on `prune`. A `fail-image` file in the state directory makes `image`
fail, and the bucket name `bad` makes `r2-test` fail.

```sh
mkdir -p /tmp/hcb
echo '{"url": "http://127.0.0.1:4799", "token": "dev-token", "setupScript": "'"$PWD"'/dev/fake-setup.sh"}' > /tmp/hcb/menubar.json
HOME_COMPUTE_BAR_CONFIG=/tmp/hcb/menubar.json HOME_COMPUTE_BAR_OPEN_SETTINGS=services \
  "build/Home Compute Bar.app/Contents/MacOS/HomeComputeBar"
```

`HOME_COMPUTE_BAR_OPEN_SETTINGS=services|storage|image|timetable|connection` opens the settings
window on that tab at launch. To review the control panel's layout without a screen,
`HCB_SNAPSHOTS=/tmp/hcb-snapshots swift test --filter SnapshotTests` renders each tab, the popover
card and the log sheet to PNGs, driven by the fake script.

## Layout

| File | Purpose |
| --- | --- |
| `Sources/HomeComputeBar/App.swift` | `@main`, `MenuBarExtra` + `Settings` scenes, status icon rendering, launch-time state read |
| `Sources/HomeComputeBar/Store.swift` | `@MainActor @Observable` state, polling, SSE loop, failure tracking, notifications |
| `Sources/HomeComputeBar/APIClient.swift` | URLSession client and SSE parser |
| `Sources/HomeComputeBar/Models.swift` | Lenient snapshot / event decoding |
| `Sources/HomeComputeBar/Views.swift` | Popover UI |
| `Sources/HomeComputeBar/SettingsView.swift` | Settings window (tab view, log sheet host) and the Connection tab |
| `Sources/HomeComputeBar/ServicesView.swift` | Services and Worker image tabs, log sheet, shared control pieces |
| `Sources/HomeComputeBar/StorageView.swift` | Storage (R2) tab |
| `Sources/HomeComputeBar/TimetableView.swift` | Timetable tab and `JobDraft` (`jobs set` arguments) |
| `Sources/HomeComputeBar/ControlStore.swift` | `@MainActor @Observable` control panel state: script commands, polling, long runs |
| `Sources/HomeComputeBar/ControlModels.swift` | Lenient decoding of the setup script's JSON |
| `Sources/HomeComputeBar/SetupScript.swift` | Runs the setup script: JSON commands, streamed long commands, output cleaning |
| `Sources/HomeComputeBar/Config.swift` | `menubar.json` load/save, logging |
| `Sources/HomeComputeBar/Formatting.swift` | Schedule / time / model-run formatting |
| `build-app.sh` | Builds and signs the `.app` bundle |
| `dev/fake-controller.mjs` | Fake controller for local testing |
| `dev/fake-setup.sh` | Fake setup script for local testing |
| `Tests/HomeComputeBarTests/` | swift-testing tests (`swift test`); `SnapshotTests` is opt-in |
