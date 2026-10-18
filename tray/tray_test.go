package main

// The tray without a desktop: the menu it would show for the real agent's
// answers (testdata/, captured from agent 0.3.0 on FakeRuntime), how it finds
// the API and token, the client against a stand-in agent, and the icons.

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"image/png"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func load[T any](t *testing.T, name string) T {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("testdata", name))
	if err != nil {
		t.Fatal(err)
	}
	var value T
	if err := json.Unmarshal(data, &value); err != nil {
		t.Fatal(err)
	}
	return value
}

func history(t *testing.T) []Entry {
	return load[struct {
		Runs []Entry `json:"runs"`
	}](t, "history.json").Runs
}

func TestRunningMenu(t *testing.T) {
	status := load[Status](t, "status-running.json")
	now := status.LastSyncAt.Add(5 * time.Second)
	view := Build(&status, history(t), nil, now, "")
	if view.Icon != IconRunning || view.Title != "gfs +1" {
		t.Fatalf("icon %v title %q", view.Icon, view.Title)
	}
	if !strings.HasPrefix(view.Header, "status-demo: connected · synced ") {
		t.Fatalf("header %q", view.Header)
	}
	if len(view.Running) != 2 || !strings.HasPrefix(view.Running[0], "gfs · running ") || !strings.Contains(view.Running[0], "CPU 72% · 612 MiB of 1.0 GiB") {
		t.Fatalf("running %q", view.Running)
	}
	if view.Notice != "" || !view.Answered || view.Paused {
		t.Fatalf("notice %q answered %v paused %v", view.Notice, view.Answered, view.Paused)
	}
	if !strings.Contains(view.Tooltip, "gfs · running") {
		t.Fatalf("tooltip %q", view.Tooltip)
	}
}

func TestRecentRunsWithTheirErrors(t *testing.T) {
	runs := history(t)
	now := runs[0].FinishedAt.Add(4 * time.Minute)
	view := Build(nil, runs, errors.New("x"), now, "")
	labels := []string{}
	for _, recent := range view.Recent {
		labels = append(labels, recent.Label)
	}
	want := []string{
		"✓ gfs · passed · 4 min ago · 2m 00s",
		"– wind-obs · cancelled · 6 min ago · 20s",
		"✓ icon-eu · published icon-eu 2026101806 · 7 min ago · 3s",
		"✗ harmonie · exit 1 · 7 min ago · 3s",
	}
	if strings.Join(labels, "\n") != strings.Join(want, "\n") {
		t.Fatalf("labels:\n%s", strings.Join(labels, "\n"))
	}
	failed := view.Recent[3]
	if !failed.Failed || failed.Detail[0] != "Traceback (most recent call last):" || !strings.HasPrefix(failed.Detail[1], "  File ") {
		t.Fatalf("detail %q", failed.Detail)
	}
	for _, line := range failed.Detail {
		if len([]rune(line)) > 72 {
			t.Fatalf("line too wide for a menu: %q", line)
		}
	}
	if view.Dot {
		t.Fatal("the newest run passed: no dot")
	}
	if !Build(nil, runs[3:], nil, now, "").Dot {
		t.Fatal("the newest run failed: a dot")
	}
}

func TestStatesOfTheIcon(t *testing.T) {
	idle := load[Status](t, "status-idle.json")
	now := idle.LastSyncAt.Add(time.Second)
	if view := Build(&idle, nil, nil, now, ""); view.Icon != IconIdle || view.Title != "" {
		t.Fatalf("idle: %v %q", view.Icon, view.Title)
	}
	paused := idle
	yes := true
	at := now.Add(-time.Hour)
	paused.Paused, paused.PausedAt, paused.NotClaimingBecause = &yes, &at, []string{"paused"}
	view := Build(&paused, nil, nil, now, "")
	if view.Icon != IconPaused || !view.Paused || !strings.HasPrefix(view.Notice, "Not taking jobs: paused on this machine since ") {
		t.Fatalf("paused: %v %q", view.Icon, view.Notice)
	}
	drained := idle
	drained.ServerDrain, drained.NotClaimingBecause = &yes, []string{"drained-on-dashboard", "full"}
	if view := Build(&drained, nil, nil, now, ""); view.Icon != IconPaused || view.Notice != "Not taking jobs: drained from the dashboard" {
		t.Fatalf("drained: %v %q", view.Icon, view.Notice)
	}
	offline := idle
	no := false
	offline.Connected, offline.LastError, offline.Outbox = &no, "https://core is unreachable: ENOTFOUND", 2
	view = Build(&offline, nil, nil, now, "")
	if view.Icon != IconOffline || !strings.Contains(view.Header, "can't reach the control plane") || !strings.Contains(view.Notice, "ENOTFOUND · 2 result(s) waiting to send") {
		t.Fatalf("offline: %v %q %q", view.Icon, view.Header, view.Notice)
	}
	down := Build(nil, nil, ErrNotRunning, now, "Start it: sudo systemctl start home-compute-agent")
	notRunning := fmt.Errorf("%w (nothing answers on 127.0.0.1:4787)", ErrNotRunning)
	if view := Build(nil, nil, notRunning, now, ""); view.Notice != "Nothing answers on 127.0.0.1:4787" {
		t.Fatalf("notice %q", view.Notice)
	}
	if down.Icon != IconDown || down.Answered || down.Hint == "" || !strings.Contains(down.Text(), "not running") {
		t.Fatalf("down: %+v", down)
	}
	// An agent before 0.3: `drain` is the pause switch.
	var old Status
	_ = json.Unmarshal([]byte(`{"connection":"online","drain":true}`), &old)
	if !old.IsPaused() || !old.IsConnected() {
		t.Fatal("old agents' fields")
	}
}

func TestNewFailuresOldestFirst(t *testing.T) {
	runs := history(t)
	fresh := NewFailures(runs, map[string]bool{})
	if len(fresh) != 1 || fresh[0].Job != "harmonie" {
		t.Fatalf("%+v", fresh)
	}
	if len(NewFailures(runs, map[string]bool{fresh[0].Run: true})) != 0 {
		t.Fatal("seen once")
	}
}

func testEnv(t *testing.T, goos string) Env {
	home := t.TempDir()
	return Env{GOOS: goos, Home: home, ConfigDir: filepath.Join(home, ".config"), Getenv: func(string) string { return "" }}
}

func write(t *testing.T, path, text string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(text), 0o600); err != nil {
		t.Fatal(err)
	}
}

func TestResolveFindsPortAndToken(t *testing.T) {
	env := testEnv(t, "linux")
	if _, err := Resolve(Config{}, env); err == nil || !strings.Contains(err.Error(), "agent-status-token") {
		t.Fatalf("no token anywhere: %v", err)
	}
	// The user's own agent: ~/.local/state/home-compute.
	state := filepath.Join(env.Home, ".local", "state", "home-compute")
	write(t, filepath.Join(state, "config.json"), `{"statusPort": 4797}`)
	write(t, filepath.Join(state, "status-token"), "tok-own\n")
	endpoint, err := Resolve(Config{}, env)
	if err != nil || endpoint.Port != 4797 || endpoint.Token != "tok-own" || endpoint.Base() != "http://127.0.0.1:4797" {
		t.Fatalf("%+v %v", endpoint, err)
	}
	// A copy of another user's token wins over the state directory.
	write(t, TokenCopyPath(env), "tok-copy")
	if endpoint, _ := Resolve(Config{}, env); endpoint.Token != "tok-copy" {
		t.Fatalf("%+v", endpoint)
	}
	// tray.json's choices win over both.
	write(t, filepath.Join(env.Home, "elsewhere"), "tok-file")
	if endpoint, _ := Resolve(Config{Port: 4801, TokenFile: filepath.Join(env.Home, "elsewhere")}, env); endpoint.Port != 4801 || endpoint.Token != "tok-file" {
		t.Fatalf("%+v", endpoint)
	}
	write(t, filepath.Join(state, "config.json"), `{"statusPort": 0}`)
	if _, err := Resolve(Config{}, env); err == nil || !strings.Contains(err.Error(), "off") {
		t.Fatalf("status API off: %v", err)
	}
	// Windows: the agent is in WSL, so only a copy of its token, on the default port.
	windows := testEnv(t, "windows")
	write(t, TokenCopyPath(windows), "tok-wsl")
	if endpoint, err := Resolve(Config{}, windows); err != nil || endpoint.Port != DefaultPort || endpoint.Token != "tok-wsl" {
		t.Fatalf("%+v %v", endpoint, err)
	}
}

func TestConfigRoundTrip(t *testing.T) {
	path := filepath.Join(t.TempDir(), "home-compute", "tray.json")
	if config, err := LoadConfig(path); err != nil || config != (Config{}) {
		t.Fatalf("missing file: %+v %v", config, err)
	}
	if err := SaveConfig(path, Config{Port: 4797, NotifyOnFailure: true}); err != nil {
		t.Fatal(err)
	}
	info, _ := os.Stat(path)
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("mode %v", info.Mode())
	}
	if config, _ := LoadConfig(path); config.Port != 4797 || !config.NotifyOnFailure {
		t.Fatalf("%+v", config)
	}
}

// A stand-in agent that checks what the real one checks.
func standIn(t *testing.T, token string) (*Client, *[]string) {
	seen := []string{}
	server := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen = append(seen, r.Method+" "+r.URL.RequestURI())
		if r.Header.Get("Authorization") != "Bearer "+token || r.Header.Get("Origin") != "" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		if r.Method == http.MethodPost && r.Header.Get("Content-Type") != "application/json" {
			w.WriteHeader(http.StatusUnsupportedMediaType)
			return
		}
		switch r.URL.Path {
		case "/v1/status":
			data, _ := os.ReadFile("testdata/status-running.json")
			w.Write(data)
		case "/v1/history":
			data, _ := os.ReadFile("testdata/history.json")
			w.Write(data)
		default:
			w.Write([]byte(`{}`))
		}
	}))
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	server.Listener = listener
	server.Start()
	t.Cleanup(server.Close)
	port := listener.Addr().(*net.TCPAddr).Port
	return NewClient(Endpoint{Port: port, Token: token}), &seen
}

func TestClient(t *testing.T) {
	client, seen := standIn(t, "secret-token")
	ctx := context.Background()
	status, err := client.Status(ctx)
	if err != nil || status.Name != "status-demo" || len(status.Running()) != 2 {
		t.Fatalf("%+v %v", status, err)
	}
	runs, err := client.History(ctx, 8)
	if err != nil || len(runs) != 4 {
		t.Fatalf("%d %v", len(runs), err)
	}
	for _, action := range []func(context.Context) error{client.Pause, client.Resume, client.Restart, func(ctx context.Context) error { return client.Drain(ctx, true) }} {
		if err := action(ctx); err != nil {
			t.Fatal(err)
		}
	}
	want := "GET /v1/status|GET /v1/history?limit=8|POST /v1/pause|POST /v1/resume|POST /v1/restart|POST /v1/drain"
	if strings.Join(*seen, "|") != want {
		t.Fatalf("%s", strings.Join(*seen, "|"))
	}
	wrong := NewClient(Endpoint{Port: client.Endpoint.Port, Token: "wrong"})
	if _, err := wrong.Status(ctx); !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("%v", err)
	}
	closed, _ := net.Listen("tcp", "127.0.0.1:0")
	port := closed.Addr().(*net.TCPAddr).Port
	closed.Close()
	if _, err := NewClient(Endpoint{Port: port, Token: "x"}).Status(ctx); !errors.Is(err, ErrNotRunning) {
		t.Fatalf("%v", err)
	}
}

func TestIcons(t *testing.T) {
	seen := map[string]bool{}
	for _, kind := range []IconKind{IconIdle, IconRunning, IconPaused, IconOffline, IconDown} {
		for _, dot := range []bool{false, true} {
			data := IconPNG(kind, 0, dot)
			image, err := png.Decode(bytes.NewReader(data))
			if err != nil || image.Bounds().Dx() != iconSize {
				t.Fatalf("%v: %v", kind, err)
			}
			seen[string(data)] = true
		}
	}
	if len(seen) < 9 {
		t.Fatalf("states look alike: %d distinct icons", len(seen))
	}
	if bytes.Equal(IconPNG(IconRunning, 0, false), IconPNG(IconRunning, 1, false)) {
		t.Fatal("running has two frames")
	}
	ico := ICO(IconPNG(IconIdle, 0, false))
	if !bytes.Equal(ico[:6], []byte{0, 0, 1, 0, 1, 0}) || !bytes.Equal(ico[22:30], []byte("\x89PNG\r\n\x1a\n")) {
		t.Fatalf("ico header % x", ico[:30])
	}
}

func TestMenuTextEscapesAccessKeys(t *testing.T) {
	want := map[string]string{
		"linux":   "response.raise__for__status() & co",
		"windows": "response.raise_for_status() && co",
	}[runtime.GOOS]
	if want == "" {
		want = "response.raise_for_status() & co"
	}
	if got := menuText("response.raise_for_status() & co"); got != want {
		t.Fatalf("%s: %q", runtime.GOOS, got)
	}
}
