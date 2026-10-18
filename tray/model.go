package main

// What the tray shows, worked out from the agent's answers and the time:
// the icon, the title beside it, the tooltip and every menu line. Pure, so
// it is tested without a desktop.

import (
	"fmt"
	"math"
	"strings"
	"time"
)

// IconKind is the tray icon's state.
type IconKind int

const (
	IconIdle IconKind = iota
	IconRunning
	IconPaused
	IconOffline
	IconDown
)

// Recent is one finished run in the menu: its line, and its submenu's lines.
type Recent struct {
	Label  string
	Detail []string
	Run    string
	Failed bool
}

// View is the whole tray.
type View struct {
	Icon     IconKind
	Dot      bool // the newest finished run failed
	Title    string
	Tooltip  string
	Header   string
	Notice   string
	Hint     string
	Running  []string
	Recent   []Recent
	Answered bool
	Paused   bool
	Draining bool
}

var reasons = map[string]string{
	"paused":               "paused on this machine",
	"draining":             "restarting when the running jobs finish",
	"drained-on-dashboard": "drained from the dashboard",
	"revoked":              "its credential was revoked",
	"upgrade-required":     "the control plane needs a newer agent",
	"runtime-unreachable":  "the container runtime does not answer",
	"runtime-failed":       "the container runtime failed to start",
}

// Duration is "42s", "4m 05s", "1h 03m".
func Duration(d time.Duration) string {
	seconds := int(math.Max(0, math.Round(d.Seconds())))
	switch {
	case seconds < 60:
		return fmt.Sprintf("%ds", seconds)
	case seconds < 3600:
		return fmt.Sprintf("%dm %02ds", seconds/60, seconds%60)
	default:
		return fmt.Sprintf("%dh %02dm", seconds/3600, (seconds%3600)/60)
	}
}

// Ago is "just now", "4 min ago", "3 h ago", "2 d ago".
func Ago(at time.Time, now time.Time) string {
	d := now.Sub(at)
	switch {
	case d < 45*time.Second:
		return "just now"
	case d < time.Hour:
		return fmt.Sprintf("%d min ago", int(math.Round(d.Minutes())))
	case d < 48*time.Hour:
		return fmt.Sprintf("%d h ago", int(math.Round(d.Hours())))
	default:
		return fmt.Sprintf("%d d ago", int(math.Round(d.Hours()/24)))
	}
}

// Memory is binary units: "612 MiB", "1.0 GiB".
func Memory(bytes float64) string {
	mib := bytes / 1048576
	if mib >= 1024 {
		return fmt.Sprintf("%.1f GiB", mib/1024)
	}
	return fmt.Sprintf("%.0f MiB", mib)
}

func clip(text string, max int) string {
	text = strings.Join(strings.Fields(text), " ")
	runes := []rune(text)
	if len(runes) <= max {
		return text
	}
	return string(runes[:max-1]) + "…"
}

// wrap breaks text into lines of at most width runes, for a submenu.
func wrap(text string, width int) []string {
	var lines []string
	for _, paragraph := range strings.Split(text, "\n") {
		// A traceback's indentation (at most 6 spaces) stays.
		indent := strings.Repeat(" ", min(6, len(paragraph)-len(strings.TrimLeft(paragraph, " "))))
		line := ""
		for _, word := range strings.Fields(paragraph) {
			for len([]rune(word)) > width {
				if line != "" {
					lines = append(lines, line)
					line = ""
				}
				lines = append(lines, string([]rune(word)[:width]))
				word = string([]rune(word)[width:])
			}
			if line == "" {
				line = indent + word
			} else if len([]rune(line))+1+len([]rune(word)) <= width {
				line += " " + word
			} else {
				lines = append(lines, line)
				line = word
			}
		}
		if line != "" {
			lines = append(lines, line)
		}
	}
	return lines
}

// Mark is ✓, ✗ or – (cancelled).
func Mark(entry Entry) string {
	switch {
	case entry.Passed != nil && *entry.Passed:
		return "✓"
	case entry.Failed():
		return "✗"
	default:
		return "–"
	}
}

// OutcomeText is "published icon-eu 2026101806", "exit 1", "out of memory", "cancelled".
func OutcomeText(entry Entry) string {
	switch entry.Outcome {
	case "failed":
		if entry.OOMKilled {
			return "out of memory"
		}
		if entry.TimedOut {
			return "timed out"
		}
		if entry.ExitCode != nil {
			return fmt.Sprintf("exit %d", *entry.ExitCode)
		}
		return "failed"
	case "published":
		var runs []string
		for _, item := range entry.Published {
			runs = append(runs, strings.TrimSpace(item.Key+" "+item.Run))
		}
		if len(runs) == 0 {
			return "published"
		}
		return "published " + strings.Join(runs, ", ")
	case "unchanged":
		return "no new run"
	case "completed":
		return "passed"
	case "":
		return "unknown"
	default:
		return entry.Outcome
	}
}

// RunLine is "gfs · running 4m 05s · CPU 72% · 612 MiB of 1.0 GiB".
func RunLine(run Run, now time.Time) string {
	parts := []string{run.Job}
	phase := strings.ReplaceAll(run.Phase, "-", " ")
	if since := run.ClaimedAt; since != nil {
		phase += " " + Duration(now.Sub(*since))
	} else if run.ElapsedMs != nil {
		phase += " " + Duration(time.Duration(*run.ElapsedMs)*time.Millisecond)
	}
	parts = append(parts, phase)
	if run.CPUPct != nil {
		parts = append(parts, fmt.Sprintf("CPU %.0f%%", *run.CPUPct))
	}
	memory := run.MemoryBytes
	if memory == nil {
		memory = run.PeakMemoryBytes
	}
	if memory != nil {
		text := Memory(*memory)
		if run.MemoryLimitBytes != nil {
			text += " of " + Memory(*run.MemoryLimitBytes)
		}
		parts = append(parts, text)
	}
	return strings.Join(parts, " · ")
}

// RecentItem is a run's menu line and the lines of its submenu.
func RecentItem(entry Entry, now time.Time) Recent {
	when := "-"
	if entry.FinishedAt != nil {
		when = Ago(*entry.FinishedAt, now)
	}
	duration := ""
	if entry.DurationMs != nil {
		duration = " · " + Duration(time.Duration(*entry.DurationMs)*time.Millisecond)
	}
	label := fmt.Sprintf("%s %s · %s · %s%s", Mark(entry), entry.Job, clip(OutcomeText(entry), 40), when, duration)
	var detail []string
	if entry.Failed() {
		text := entry.Error
		if entry.ErrorDetail != "" && !strings.Contains(entry.ErrorDetail, entry.Error) {
			text += "\n" + entry.ErrorDetail
		} else if entry.ErrorDetail != "" {
			text = entry.ErrorDetail
		}
		lines := wrap(text, 72)
		if len(lines) > 10 {
			lines = append([]string{"…"}, lines[len(lines)-9:]...)
		}
		detail = lines
	}
	if entry.FinishedAt != nil {
		detail = append(detail, "Finished "+entry.FinishedAt.Local().Format("Mon 2 Jan 15:04:05"))
	}
	return Recent{Label: label, Detail: detail, Run: entry.Run, Failed: entry.Failed()}
}

// Build makes the view. `problem` is why the agent did not answer (nil when it did).
func Build(status *Status, history []Entry, problem error, now time.Time, hint string) View {
	view := View{}
	for i, entry := range history {
		if i >= MaxRecent {
			break
		}
		view.Recent = append(view.Recent, RecentItem(entry, now))
	}
	if len(history) > 0 && history[0].Failed() {
		view.Dot = true
	}
	if status == nil {
		view.Icon = IconDown
		view.Header = "Home Compute: the agent is not running"
		if problem != nil {
			// The header already says it is not running: the notice is why.
			detail := strings.TrimSuffix(strings.TrimPrefix(problem.Error(), ErrNotRunning.Error()+" ("), ")")
			if detail != "" {
				view.Notice = clip(strings.ToUpper(detail[:1])+detail[1:], 120)
			}
		}
		view.Hint = hint
		view.Tooltip = "Home Compute: the agent is not running"
		return view
	}
	view.Answered = true
	name := status.Name
	if name == "" {
		name = "this machine"
	}
	sync := "not synced yet"
	if status.LastSyncAt != nil {
		sync = "synced " + Ago(*status.LastSyncAt, now)
	}
	connection := "connected"
	if !status.IsConnected() {
		connection = "can't reach the control plane"
	}
	view.Header = fmt.Sprintf("%s: %s · %s", name, connection, sync)
	view.Paused = status.IsPaused()
	view.Draining = status.Draining

	var notes []string
	for _, reason := range status.NotClaimingBecause {
		if text, ok := reasons[reason]; ok {
			if reason == "paused" && status.PausedAt != nil {
				text += " since " + status.PausedAt.Local().Format("15:04")
			}
			notes = append(notes, text)
		}
	}
	if len(status.NotClaimingBecause) == 0 && status.IsPaused() {
		notes = append(notes, reasons["paused"])
	}
	if len(notes) > 0 {
		view.Notice = "Not taking jobs: " + strings.Join(notes, "; ")
	}
	if !status.IsConnected() && status.LastError != "" {
		view.Notice = strings.TrimPrefix(view.Notice+" · ", " · ") + clip(status.LastError, 100)
	}
	if status.Outbox > 0 {
		view.Notice = strings.TrimPrefix(view.Notice+" · ", " · ") + fmt.Sprintf("%d result(s) waiting to send", status.Outbox)
	}

	running := status.Running()
	for _, run := range running {
		view.Running = append(view.Running, RunLine(run, now))
	}
	switch {
	case len(running) > 0:
		view.Icon = IconRunning
		view.Title = clip(running[0].Job, 18)
		if len(running) > 1 {
			view.Title += fmt.Sprintf(" +%d", len(running)-1)
		}
	case !status.IsConnected():
		view.Icon = IconOffline
	case status.IsPaused() || status.Draining || (status.ServerDrain != nil && *status.ServerDrain):
		view.Icon = IconPaused
	default:
		view.Icon = IconIdle
	}
	tooltip := []string{"Home Compute: " + view.Header}
	tooltip = append(tooltip, view.Running...)
	if view.Notice != "" {
		tooltip = append(tooltip, view.Notice)
	}
	if len(view.Recent) > 0 {
		tooltip = append(tooltip, "Last: "+view.Recent[0].Label)
	}
	view.Tooltip = strings.Join(tooltip, "\n")
	return view
}

// NewFailures are failed runs not in `seen`, oldest first.
func NewFailures(history []Entry, seen map[string]bool) []Entry {
	var fresh []Entry
	for i := len(history) - 1; i >= 0; i-- {
		if history[i].Failed() && !seen[history[i].Run] {
			fresh = append(fresh, history[i])
		}
	}
	return fresh
}

// Text is the view as plain lines: `home-compute-tray --once` prints it.
func (v View) Text() string {
	lines := []string{v.Header}
	if v.Notice != "" {
		lines = append(lines, v.Notice)
	}
	if v.Hint != "" {
		lines = append(lines, v.Hint)
	}
	if len(v.Running) > 0 {
		lines = append(lines, "Running now:")
		for _, line := range v.Running {
			lines = append(lines, "  "+line)
		}
	}
	if len(v.Recent) > 0 {
		lines = append(lines, "Recent runs:")
		for _, recent := range v.Recent {
			lines = append(lines, "  "+recent.Label)
			if recent.Failed {
				for _, line := range recent.Detail {
					lines = append(lines, "      "+line)
				}
			}
		}
	}
	return strings.Join(lines, "\n")
}
