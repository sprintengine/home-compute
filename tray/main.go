// home-compute-tray: a tray icon for a Home Compute worker on Linux and
// Windows, over the agent's local status API (agent/README.md). It shows
// what runs now, the recent runs with their errors, whether the agent
// reaches the control plane, and the quick actions.
//
//	home-compute-tray [--config FILE] [--state-dir DIR] [--port N] [--token-file FILE]
//	home-compute-tray --once     print what the menu would show, then exit (1 when the agent does not answer)
package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"time"

	"fyne.io/systray"
)

// version is set at build time (-ldflags "-X main.version=…").
var version = "dev"

func main() {
	env := SystemEnv()
	configPath := flag.String("config", ConfigPath(env), "tray settings (JSON)")
	stateDir := flag.String("state-dir", "", "the agent's state directory, when this user can read it")
	port := flag.Int("port", 0, "the agent's status port (default: its config.json's statusPort, else 4787)")
	tokenFile := flag.String("token-file", "", "a copy of the agent's status-token this user can read")
	once := flag.Bool("once", false, "print what the menu would show, then exit")
	showVersion := flag.Bool("version", false, "print the version")
	flag.Parse()
	if *showVersion {
		fmt.Println(version)
		return
	}
	overrides := Config{StateDir: *stateDir, Port: *port, TokenFile: *tokenFile}
	if *once {
		os.Exit(printOnce(env, *configPath, overrides))
	}
	app := newTrayApp(env, *configPath, overrides)
	systray.Run(app.onReady, func() {})
}

func printOnce(env Env, configPath string, overrides Config) int {
	app := newTrayApp(env, configPath, overrides)
	config, err := LoadConfig(configPath)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
	}
	app.config = config
	endpoint, err := Resolve(app.effective(), env)
	var status *Status
	var history []Entry
	if err == nil {
		client := NewClient(endpoint)
		ctx, cancel := context.WithTimeout(context.Background(), 6*time.Second)
		defer cancel()
		answer, statusErr := client.Status(ctx)
		if statusErr == nil {
			status = &answer
			history, _ = client.History(ctx, MaxRecent)
		}
		err = statusErr
	}
	hint := ""
	if status == nil {
		hint = serviceHint()
	}
	fmt.Println(Build(status, history, err, time.Now(), hint).Text())
	if status == nil {
		return 1
	}
	return 0
}
