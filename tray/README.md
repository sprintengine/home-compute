# Home Compute tray (Windows and Linux)

A tray icon for a Home Compute worker, over the agent's
[local status API](../agent/README.md#local-status-api). It is the Windows and Linux
counterpart of the Mac's menu bar app ([macos/](../macos/README.md)), with the same menu:

- **Icon**: a box: grey when idle, blue while a job runs (it pulses, and on Linux panels that
  show titles the job's name is beside it), orange with two bars when the machine takes no jobs
  (paused here, drained on the dashboard, or draining), grey with a slash when the agent cannot
  reach the control plane, red with "!" when the agent does not answer. A red dot means the newest
  finished run failed. The tooltip repeats the header, what runs and the last run.
- **Menu**: the machine, connected or not and when it last synced; why it takes no jobs; **Running
  now** (job, phase, elapsed, CPU, memory against its limit); **Recent runs** with ✓, ✗ or –
  (cancelled), outcome or exit code, when and how long, each with a submenu holding a failure's
  error and traceback and **Open in dashboard**; **Pause taking jobs** / **Resume taking jobs**;
  **Restart agent** › Restart now / Restart when the running jobs finish; **Open dashboard**;
  **Open log**; **Notify when a job fails** (off by default); **Start at login**; **Quit** (the
  agent keeps running).

`home-compute-tray --once` prints what the menu would show and exits (1 when the agent does not
answer): a check on a machine without a desktop. There, `home-compute-agent status`, `history`
and `watch` do the same job in a terminal.

## Why Go and systray

One static binary per platform (7–9 MB, no runtime, no installer) from
[`fyne.io/systray`](https://github.com/fyne-io/systray), the maintained fork of
`getlantern/systray`. It is pure Go on Linux (the StatusNotifierItem and DBusMenu protocols over
D-Bus) and on Windows (Win32 calls), so `CGO_ENABLED=0` cross-compiles every target from any
machine, and the only other dependencies are `godbus/dbus` (which it already uses, and which
also posts Linux notifications) and `golang.org/x/sys` (the Windows registry for Start at
login). Tauri or Electron would bring a web view and a much larger toolchain for a menu of text
lines; Node's tray libraries ship prebuilt helpers per platform and are thinly maintained.

## Build

```sh
cd tray
go test ./...
./build.sh        # dist/home-compute-tray-{windows-amd64.exe,linux-amd64,linux-arm64} and SHA256SUMS
```

[ci-job.yml](ci-job.yml) is the `tray` job for `.github/workflows/ci.yml`: it vets every target,
runs the tests, builds the three binaries and keeps them as the `home-compute-tray` artifact of
each run. It is not in the workflow yet: changing a workflow needs a token with the `workflow`
scope.

## Install

### Linux

The desktop needs a StatusNotifierItem host: KDE Plasma, Xfce (4.16 or later), Cinnamon, MATE,
LXQt and Budgie have one; GNOME needs the "AppIndicator and KStatusNotifierItem Support"
extension (Ubuntu ships it on).

```sh
install -D -m 0755 home-compute-tray-linux-amd64 ~/.local/bin/home-compute-tray   # or -linux-arm64
```

If the agent runs as you (a state directory under `~/.local/state/home-compute`), that is all.
If it is the systemd service (user `hcagent`, `/etc/home-compute`), give yourself a copy of its
token that only you can read; it never changes once made:

```sh
mkdir -p -m 0700 ~/.config/home-compute
(umask 077; sudo cat /etc/home-compute/status-token > ~/.config/home-compute/agent-status-token)
```

Then run `home-compute-tray &` once and tick **Start at login** (an XDG autostart entry,
`~/.config/autostart/home-compute-tray.desktop`). **Open log** opens the agent's log file when it
writes one, else a terminal following `journalctl -u home-compute-agent -f` (reading a system
unit's journal needs membership of `systemd-journal` or `adm`).

### Windows

The agent runs in WSL 2 (docs/hosted-control-plane.md §4.7). WSL forwards the agent's
127.0.0.1:4787 to Windows' own localhost, so the tray reaches it there. Copy the token out of
the distro once, into your profile (which only you can read):

```bat
mkdir "%APPDATA%\home-compute"
wsl -u root cat /etc/home-compute/status-token > "%APPDATA%\home-compute\agent-status-token"
```

Put `home-compute-tray-windows-amd64.exe` somewhere of yours (say
`%LOCALAPPDATA%\Programs\home-compute\`), run it, and tick **Start at login** (a value under
`HKCU\Software\Microsoft\Windows\CurrentVersion\Run`). **Open log** opens a console following the
agent's journal in WSL; notifications are Windows toasts sent through PowerShell.

## Settings

`tray.json` in `~/.config/home-compute/` (Linux) or `%APPDATA%\home-compute\` (Windows); every field
is optional, and the menu's checkboxes write it:

```json
{ "stateDir": "", "port": 4787, "tokenFile": "", "dashboardUrl": "", "logFile": "", "notifyOnFailure": false }
```

- `port`: else `statusPort` from the agent's `config.json` when this user can read it, else 4787.
- `tokenFile`: else `agent-status-token` beside `tray.json`, else `status-token` in the first
  readable state directory (`stateDir`, `$HC_AGENT_STATE_DIR`, `~/.local/state/home-compute`,
  `/var/lib/home-compute`, `/etc/home-compute`).
- `dashboardUrl`: else the address the agent reports (hc-core's `DASHBOARD_URL`).

`--config`, `--state-dir`, `--port` and `--token-file` override them for one run.

## What is tested where

- `go test` (on a Mac, and on Linux arm64 in a container): the menu for the real agent's answers in `testdata/`
  (captured from agent 0.3.0), every icon state, finding the port and token on Linux and Windows,
  `tray.json`, and the client against a stand-in agent that checks the token.
- `build.sh` builds the Linux amd64 and arm64 and Windows amd64 binaries. The Linux arm64 one
  was run under Xvfb with an Xfce panel in a container, against a real agent there (see the pull
  request for the screenshots). The Linux amd64 one has not been run.
- **Windows is untested**: the binary builds and vets, but nobody has run it. The WSL port
  forwarding, the toast notification, Open log and Start at login on Windows have not been seen
  working.
