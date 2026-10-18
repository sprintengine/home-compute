package main

// The tray icon and its menu. systray menus are built once, so every line is
// a slot that is shown, hidden and retitled as the agent's answers change.

import (
	"context"
	"fmt"
	"log"
	"net/url"
	"strings"
	"sync"
	"time"

	"fyne.io/systray"
)

const (
	MaxRunning    = 4
	MaxRecent     = 8
	detailLines   = 12
	busyInterval  = 2 * time.Second
	idleInterval  = 5 * time.Second
	historyLimit  = 20
	messageMaxAge = 30 * time.Second
)

type recentSlot struct {
	item  *systray.MenuItem
	lines [detailLines]*systray.MenuItem
	open  *systray.MenuItem
	run   string
}

type trayApp struct {
	env        Env
	configPath string
	overrides  Config

	mu        sync.Mutex
	config    Config
	status    *Status
	history   []Entry
	problem   error
	seen      map[string]bool
	baseline  bool
	frame     int
	iconKey   string
	message   string
	messageAt time.Time

	refresh chan struct{}

	header, notice, hint            *systray.MenuItem
	runningTitle                    *systray.MenuItem
	running                         [MaxRunning]*systray.MenuItem
	recentTitle                     *systray.MenuItem
	recent                          [MaxRecent]*recentSlot
	pause, restart                  *systray.MenuItem
	restartNow, restartIdle         *systray.MenuItem
	dashboard, logItem              *systray.MenuItem
	notifyItem, autostartItem, quit *systray.MenuItem
}

func newTrayApp(env Env, configPath string, overrides Config) *trayApp {
	return &trayApp{env: env, configPath: configPath, overrides: overrides, seen: map[string]bool{}, refresh: make(chan struct{}, 1)}
}

// effective is tray.json with the command line's flags on top.
func (a *trayApp) effective() Config {
	config := a.config
	if a.overrides.StateDir != "" {
		config.StateDir = a.overrides.StateDir
	}
	if a.overrides.Port != 0 {
		config.Port = a.overrides.Port
	}
	if a.overrides.TokenFile != "" {
		config.TokenFile = a.overrides.TokenFile
	}
	return config
}

func (a *trayApp) onReady() {
	config, err := LoadConfig(a.configPath)
	if err != nil {
		log.Printf("tray: %v", err)
	}
	a.config = config
	a.setIcon(IconIdle, false)
	systray.SetTitle("")
	systray.SetTooltip("Home Compute")

	a.header = systray.AddMenuItem("Home Compute: asking the agent…", "")
	a.header.Disable()
	a.notice = systray.AddMenuItem("", "")
	a.notice.Disable()
	a.notice.Hide()
	a.hint = systray.AddMenuItem("", "")
	a.hint.Disable()
	a.hint.Hide()
	systray.AddSeparator()
	a.runningTitle = systray.AddMenuItem("Running now", "")
	a.runningTitle.Disable()
	for i := range a.running {
		a.running[i] = systray.AddMenuItem("", "")
		a.running[i].Disable()
		a.running[i].Hide()
	}
	a.recentTitle = systray.AddMenuItem("Recent runs", "")
	a.recentTitle.Disable()
	for i := range a.recent {
		slot := &recentSlot{item: systray.AddMenuItem("", "")}
		for j := range slot.lines {
			slot.lines[j] = slot.item.AddSubMenuItem("", "")
			slot.lines[j].Disable()
			slot.lines[j].Hide()
		}
		slot.open = slot.item.AddSubMenuItem("Open in dashboard", "")
		slot.item.Hide()
		a.recent[i] = slot
		go a.on(slot.open, func() { a.openDashboard("#/run/" + url.PathEscape(slot.run)) })
	}
	systray.AddSeparator()
	a.pause = systray.AddMenuItem("Pause taking jobs", "Claim nothing new until resumed, across restarts. Running jobs finish.")
	a.restart = systray.AddMenuItem("Restart agent", "")
	a.restartNow = a.restart.AddSubMenuItem("Restart now", "Running jobs carry on; the agent picks them up again when it is back.")
	a.restartIdle = a.restart.AddSubMenuItem("Restart when the running jobs finish", "Claims nothing new meanwhile.")
	a.dashboard = systray.AddMenuItem("Open dashboard", "")
	a.logItem = systray.AddMenuItem("Open log", "")
	systray.AddSeparator()
	a.notifyItem = systray.AddMenuItemCheckbox("Notify when a job fails", "", a.config.NotifyOnFailure)
	a.autostartItem = systray.AddMenuItemCheckbox("Start at login", "", autostartEnabled())
	a.quit = systray.AddMenuItem("Quit", "Quits this tray app; the agent keeps running.")

	go a.on(a.pause, func() { a.act("pause", func(c *Client, ctx context.Context) error { return a.togglePause(c, ctx) }) })
	go a.on(a.restartNow, func() { a.act("restart", func(c *Client, ctx context.Context) error { return c.Restart(ctx) }) })
	go a.on(a.restartIdle, func() {
		a.act("drain", func(c *Client, ctx context.Context) error {
			a.mu.Lock()
			draining := a.status != nil && a.status.Draining
			a.mu.Unlock()
			return c.Drain(ctx, !draining)
		})
	})
	go a.on(a.dashboard, func() { a.openDashboard("") })
	go a.on(a.logItem, a.openLog)
	go a.on(a.notifyItem, a.toggleNotify)
	go a.on(a.autostartItem, a.toggleAutostart)
	go a.on(a.quit, systray.Quit)
	go a.poll()
}

func (a *trayApp) on(item *systray.MenuItem, do func()) {
	for range item.ClickedCh {
		do()
	}
}

func (a *trayApp) say(message string) {
	a.mu.Lock()
	a.message, a.messageAt = message, time.Now()
	a.mu.Unlock()
	a.render()
}

func (a *trayApp) poll() {
	for {
		a.fetch()
		interval := idleInterval
		a.mu.Lock()
		if a.status != nil && len(a.status.Running()) > 0 {
			interval = busyInterval
		}
		a.mu.Unlock()
		select {
		case <-time.After(interval):
		case <-a.refresh:
		}
	}
}

func (a *trayApp) fetch() {
	endpoint, err := Resolve(a.effective(), a.env)
	var status *Status
	var history []Entry
	if err == nil {
		client := NewClient(endpoint)
		ctx, cancel := context.WithTimeout(context.Background(), 6*time.Second)
		answer, statusErr := client.Status(ctx)
		if statusErr == nil {
			status = &answer
			history, err = client.History(ctx, historyLimit)
		} else {
			err = statusErr
		}
		cancel()
	}
	a.mu.Lock()
	a.status, a.problem = status, err
	if status != nil && history != nil {
		a.history = history
	}
	fresh := NewFailures(a.history, a.seen)
	for _, entry := range fresh {
		a.seen[entry.Run] = true
	}
	notifyThese := []Entry{}
	if a.baseline && a.config.NotifyOnFailure {
		notifyThese = fresh
	}
	if status != nil {
		a.baseline = true
	}
	name := "this machine"
	if status != nil && status.Name != "" {
		name = status.Name
	}
	a.frame++
	a.mu.Unlock()
	for _, entry := range notifyThese {
		body := entry.Error
		if body == "" {
			body = OutcomeText(entry)
		}
		if err := notify(fmt.Sprintf("%s failed on %s", entry.Job, name), body); err != nil {
			log.Printf("tray: notification: %v", err)
		}
	}
	a.render()
}

func (a *trayApp) setIcon(kind IconKind, dot bool) {
	key := fmt.Sprintf("%d-%d-%v", kind, a.frame%2, dot)
	if key == a.iconKey {
		return
	}
	a.iconKey = key
	data := IconPNG(kind, a.frame, dot)
	if platformIconIsICO {
		data = ICO(data)
	}
	systray.SetIcon(data)
}

func setLine(item *systray.MenuItem, text string) {
	if text == "" {
		item.Hide()
		return
	}
	item.SetTitle(menuText(text))
	item.Show()
}

func (a *trayApp) render() {
	a.mu.Lock()
	defer a.mu.Unlock()
	hint := ""
	if a.status == nil {
		hint = serviceHint()
	}
	view := Build(a.status, a.history, a.problem, time.Now(), hint)
	if a.message != "" && time.Since(a.messageAt) < messageMaxAge {
		view.Hint = a.message
	}
	a.setIcon(view.Icon, view.Dot)
	systray.SetTitle(view.Title)
	systray.SetTooltip(view.Tooltip)
	a.header.SetTitle(menuText(view.Header))
	setLine(a.notice, view.Notice)
	setLine(a.hint, view.Hint)
	if len(view.Running) == 0 {
		a.runningTitle.Hide()
	} else {
		a.runningTitle.Show()
	}
	for i, item := range a.running {
		if i < len(view.Running) {
			setLine(item, view.Running[i])
		} else {
			item.Hide()
		}
	}
	dashboard := a.dashboardURL()
	if len(view.Recent) == 0 {
		a.recentTitle.SetTitle("Recent runs: none yet")
	} else {
		a.recentTitle.SetTitle("Recent runs")
	}
	for i, slot := range a.recent {
		if i >= len(view.Recent) {
			slot.item.Hide()
			continue
		}
		recent := view.Recent[i]
		slot.run = recent.Run
		setLine(slot.item, recent.Label)
		for j, line := range slot.lines {
			if j < len(recent.Detail) {
				setLine(line, recent.Detail[j])
			} else {
				line.Hide()
			}
		}
		if dashboard == "" {
			slot.open.Disable()
		} else {
			slot.open.Enable()
		}
	}
	if view.Paused {
		a.pause.SetTitle("Resume taking jobs")
	} else {
		a.pause.SetTitle("Pause taking jobs")
	}
	if view.Draining {
		a.restartIdle.SetTitle("Cancel restart when idle")
	} else {
		a.restartIdle.SetTitle("Restart when the running jobs finish")
	}
	for _, item := range []*systray.MenuItem{a.pause, a.restart, a.restartNow, a.restartIdle} {
		if view.Answered {
			item.Enable()
		} else {
			item.Disable()
		}
	}
	if dashboard == "" {
		a.dashboard.Disable()
	} else {
		a.dashboard.Enable()
	}
}

func (a *trayApp) act(name string, do func(*Client, context.Context) error) {
	endpoint, err := Resolve(a.effective(), a.env)
	if err == nil {
		ctx, cancel := context.WithTimeout(context.Background(), 6*time.Second)
		err = do(NewClient(endpoint), ctx)
		cancel()
	}
	if err != nil {
		a.say(fmt.Sprintf("%s: %v", name, err))
	} else {
		a.say("")
	}
	select {
	case a.refresh <- struct{}{}:
	default:
	}
}

func (a *trayApp) togglePause(client *Client, ctx context.Context) error {
	a.mu.Lock()
	paused := a.status != nil && a.status.IsPaused()
	a.mu.Unlock()
	if paused {
		return client.Resume(ctx)
	}
	return client.Pause(ctx)
}

// dashboardURL is tray.json's, else the agent's; only http(s). Callers hold a.mu.
func (a *trayApp) dashboardURL() string {
	candidate := a.config.DashboardURL
	if candidate == "" && a.status != nil {
		candidate = a.status.DashboardURL
	}
	parsed, err := url.Parse(candidate)
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" {
		return ""
	}
	return parsed.String()
}

func (a *trayApp) openDashboard(fragment string) {
	a.mu.Lock()
	base := a.dashboardURL()
	a.mu.Unlock()
	if base == "" {
		a.say("The agent does not know the dashboard's address; set dashboardUrl in " + a.configPath)
		return
	}
	target := base
	if fragment != "" {
		target = strings.SplitN(base, "#", 2)[0] + fragment
	}
	if err := openURL(target); err != nil {
		a.say("Open dashboard: " + err.Error())
	}
}

func (a *trayApp) openLog() {
	a.mu.Lock()
	file, hint := a.config.LogFile, ""
	if a.status != nil {
		if file == "" {
			file = a.status.Agent.LogFile
		}
		hint = a.status.Agent.LogHint
	}
	a.mu.Unlock()
	if file == "" && hint == "" {
		hint = "journalctl -u home-compute-agent -f"
	}
	if err := openLog(file, hint); err != nil {
		a.say("Open log: " + err.Error())
	}
}

func (a *trayApp) toggleNotify() {
	a.mu.Lock()
	a.config.NotifyOnFailure = !a.config.NotifyOnFailure
	config := a.config
	a.mu.Unlock()
	if config.NotifyOnFailure {
		a.notifyItem.Check()
	} else {
		a.notifyItem.Uncheck()
	}
	if err := SaveConfig(a.configPath, config); err != nil {
		a.say("Could not save " + a.configPath + ": " + err.Error())
	}
}

func (a *trayApp) toggleAutostart() {
	on := !autostartEnabled()
	if err := setAutostart(on); err != nil {
		a.say("Start at login: " + err.Error())
	}
	if autostartEnabled() {
		a.autostartItem.Check()
	} else {
		a.autostartItem.Uncheck()
	}
}
