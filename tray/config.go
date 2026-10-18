package main

// The tray's settings (tray.json in the user's config directory) and how
// it finds the agent's status API: its port and a token this user can read.

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

// DefaultPort is the agent's default statusPort.
const DefaultPort = 4787

// Config is tray.json. Every field is optional.
type Config struct {
	// StateDir is the agent's state directory, when this user can read it.
	StateDir string `json:"stateDir,omitempty"`
	// Port is the status API's port; 0 means statusPort from the agent's config.json, else 4787.
	Port int `json:"port,omitempty"`
	// TokenFile is a copy of the agent's status-token this user can read.
	TokenFile string `json:"tokenFile,omitempty"`
	// DashboardURL overrides the dashboard the agent reports.
	DashboardURL string `json:"dashboardUrl,omitempty"`
	// LogFile overrides where the agent's log is.
	LogFile string `json:"logFile,omitempty"`
	// NotifyOnFailure posts a desktop notification when a run fails (off by default).
	NotifyOnFailure bool `json:"notifyOnFailure,omitempty"`
}

// Env is what resolution reads from the environment (tests replace it).
type Env struct {
	GOOS      string
	Home      string
	ConfigDir string
	Getenv    func(string) string
}

// SystemEnv is this process's.
func SystemEnv() Env {
	home, _ := os.UserHomeDir()
	configDir, _ := os.UserConfigDir()
	return Env{GOOS: runtime.GOOS, Home: home, ConfigDir: configDir, Getenv: os.Getenv}
}

// ConfigPath is tray.json: ~/.config/home-compute on Linux, %AppData%\home-compute on Windows.
func ConfigPath(env Env) string {
	return filepath.Join(env.ConfigDir, "home-compute", "tray.json")
}

// TokenCopyPath is where a user keeps a copy of another user's agent token.
func TokenCopyPath(env Env) string {
	return filepath.Join(env.ConfigDir, "home-compute", "agent-status-token")
}

// LoadConfig reads tray.json; a missing file is the defaults.
func LoadConfig(path string) (Config, error) {
	var config Config
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return config, nil
	}
	if err != nil {
		return config, err
	}
	if err := json.Unmarshal(data, &config); err != nil {
		return config, fmt.Errorf("%s: %w", path, err)
	}
	return config, nil
}

// SaveConfig writes tray.json as 0600, through a temporary file.
func SaveConfig(path string, config Config) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	data, err := json.MarshalIndent(config, "", "  ")
	if err != nil {
		return err
	}
	temporary := path + ".tmp"
	if err := os.WriteFile(temporary, append(data, '\n'), 0o600); err != nil {
		return err
	}
	return os.Rename(temporary, path)
}

// StateDirs are where an agent on this machine may keep its state, in the
// order the agent itself would choose them (agent/src/state.mjs).
func StateDirs(config Config, env Env) []string {
	if config.StateDir != "" {
		return []string{config.StateDir}
	}
	var dirs []string
	if dir := env.Getenv("HC_AGENT_STATE_DIR"); dir != "" {
		dirs = append(dirs, dir)
	}
	switch env.GOOS {
	case "linux":
		state := env.Getenv("XDG_STATE_HOME")
		if state == "" {
			state = filepath.Join(env.Home, ".local", "state")
		}
		dirs = append(dirs, filepath.Join(state, "home-compute"), "/var/lib/home-compute", "/etc/home-compute")
	case "darwin":
		dirs = append(dirs, filepath.Join(env.Home, "Library", "Application Support", "home-compute"))
	case "windows":
		// The agent runs inside WSL; its state is not this user's to read. Use a token copy.
	default:
		dirs = append(dirs, filepath.Join(env.Home, ".home-compute"))
	}
	return dirs
}

// Resolve finds the port and the token. The token comes from TokenFile, else
// a copy in the user's config directory, else the first state directory that
// has one this user can read.
func Resolve(config Config, env Env) (Endpoint, error) {
	dirs := StateDirs(config, env)
	port := config.Port
	if port == 0 {
		port = DefaultPort
		for _, dir := range dirs {
			data, err := os.ReadFile(filepath.Join(dir, "config.json"))
			if err != nil {
				continue
			}
			var agent struct {
				StatusPort *int `json:"statusPort"`
			}
			if json.Unmarshal(data, &agent) == nil && agent.StatusPort != nil {
				if *agent.StatusPort == 0 {
					return Endpoint{}, errors.New("the agent's status API is off (statusPort is 0 in its config.json)")
				}
				port = *agent.StatusPort
			}
			break
		}
	}
	if port <= 0 || port > 65535 {
		return Endpoint{}, fmt.Errorf("port %d is not a port", port)
	}
	candidates := []string{}
	if config.TokenFile != "" {
		candidates = append(candidates, config.TokenFile)
	} else {
		candidates = append(candidates, TokenCopyPath(env))
		for _, dir := range dirs {
			candidates = append(candidates, filepath.Join(dir, "status-token"))
		}
	}
	for _, file := range candidates {
		data, err := os.ReadFile(file)
		if err != nil {
			continue
		}
		if token := strings.TrimSpace(string(data)); token != "" {
			return Endpoint{Port: port, Token: token}, nil
		}
	}
	return Endpoint{}, fmt.Errorf("no status token this user can read; copy the agent's status-token to %s (agent/README.md, \"Another user's agent\")", TokenCopyPath(env))
}
