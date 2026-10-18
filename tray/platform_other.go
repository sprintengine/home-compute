//go:build !linux && !windows

package main

// Elsewhere (a Mac, for development; the Mac's own app is macos/): open what
// can be opened, and say that the rest is not supported.

import (
	"errors"
	"os/exec"
)

const platformIconIsICO = false

func openURL(target string) error { return exec.Command("open", target).Start() }

func openLog(file, hint string) error {
	if file == "" {
		return errors.New("the agent did not say where it logs")
	}
	return exec.Command("open", file).Start()
}

func notify(title, body string) error { return errors.New("notifications are not supported here") }

func autostartEnabled() bool { return false }

func setAutostart(on bool) error { return errors.New("start at login is not supported here") }

func serviceHint() string { return "" }

func menuText(text string) string { return text }
