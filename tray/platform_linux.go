//go:build linux

package main

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/godbus/dbus/v5"
)

const platformIconIsICO = false

func openURL(target string) error {
	return exec.Command("xdg-open", target).Start()
}

// openLog opens the log file, or a terminal following the journal when the agent logs there.
func openLog(file, hint string) error {
	if file != "" {
		if _, err := os.Stat(file); err == nil {
			return exec.Command("xdg-open", file).Start()
		}
		return fmt.Errorf("%s is not readable by this user", file)
	}
	if !strings.HasPrefix(hint, "journalctl") {
		return errors.New("the agent did not say where it logs")
	}
	follow := []string{"journalctl", "-u", "home-compute-agent", "-f"}
	terminals := [][]string{
		{"x-terminal-emulator", "-e"}, {"gnome-terminal", "--"}, {"konsole", "-e"}, {"xfce4-terminal", "-x"}, {"xterm", "-e"},
	}
	for _, terminal := range terminals {
		if path, err := exec.LookPath(terminal[0]); err == nil {
			return exec.Command(path, append(terminal[1:], follow...)...).Start()
		}
	}
	return errors.New("no terminal found; run: journalctl -u home-compute-agent -f")
}

// notify posts a desktop notification through org.freedesktop.Notifications.
func notify(title, body string) error {
	conn, err := dbus.SessionBus()
	if err != nil {
		return err
	}
	call := conn.Object("org.freedesktop.Notifications", "/org/freedesktop/Notifications").Call(
		"org.freedesktop.Notifications.Notify", 0, "Home Compute", uint32(0), "dialog-error", title, body,
		[]string{}, map[string]dbus.Variant{"urgency": dbus.MakeVariant(byte(1))}, int32(-1))
	return call.Err
}

func autostartPath() string {
	dir := os.Getenv("XDG_CONFIG_HOME")
	if dir == "" {
		home, _ := os.UserHomeDir()
		dir = filepath.Join(home, ".config")
	}
	return filepath.Join(dir, "autostart", "home-compute-tray.desktop")
}

func autostartEnabled() bool {
	_, err := os.Stat(autostartPath())
	return err == nil
}

// setAutostart writes or removes an XDG autostart entry for this binary.
func setAutostart(on bool) error {
	path := autostartPath()
	if !on {
		err := os.Remove(path)
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		return err
	}
	executable, err := os.Executable()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	entry := fmt.Sprintf("[Desktop Entry]\nType=Application\nName=Home Compute\nComment=Home Compute agent status\nExec=%q\nTerminal=false\nX-GNOME-Autostart-enabled=true\n", executable)
	return os.WriteFile(path, []byte(entry), 0o644)
}

// serviceHint says how to start an agent that is not running.
func serviceHint() string {
	return "Start it: sudo systemctl start home-compute-agent"
}
