package main

// The agent's local status API (agent/README.md, "Local status API"):
// 127.0.0.1 only, a bearer token from a 0600 file, read-mostly.

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"time"
)

// Status is GET /v1/status, as much of it as the tray shows.
type Status struct {
	StatusAPI          int        `json:"statusApi"`
	AgentVersion       string     `json:"agentVersion"`
	MachineID          string     `json:"machineId"`
	Name               string     `json:"name"`
	Server             string     `json:"server"`
	DashboardURL       string     `json:"dashboardUrl"`
	Connection         string     `json:"connection"`
	Connected          *bool      `json:"connected"`
	Paused             *bool      `json:"paused"`
	Drain              bool       `json:"drain"` // agents before 0.3: the pause switch
	PausedAt           *time.Time `json:"pausedAt"`
	Draining           bool       `json:"draining"`
	ServerDrain        *bool      `json:"serverDrain"`
	NotClaimingBecause []string   `json:"notClaimingBecause"`
	LastSyncAt         *time.Time `json:"lastSyncAt"`
	LastError          string     `json:"lastError"`
	Outbox             int        `json:"outbox"`
	Current            []Run      `json:"current"`
	Runs               []Run      `json:"runs"` // agents before 0.3: {id, job, phase, since}
	Runtime            struct {
		Kind string `json:"kind"`
		OK   bool   `json:"ok"`
	} `json:"runtime"`
	Agent struct {
		LogFile string `json:"logFile"`
		LogHint string `json:"logHint"`
	} `json:"agent"`
}

// IsConnected says whether the agent reaches the control plane.
func (s Status) IsConnected() bool {
	if s.Connected != nil {
		return *s.Connected
	}
	return s.Connection == "online"
}

// IsPaused is the local pause switch.
func (s Status) IsPaused() bool {
	if s.Paused != nil {
		return *s.Paused
	}
	return s.Drain
}

// Running is the runs in hand that have not finished.
func (s Status) Running() []Run {
	var runs []Run
	current := s.Current
	if current == nil {
		current = s.Runs
	}
	for _, run := range current {
		if run.ClaimedAt == nil {
			run.ClaimedAt = run.Since
		}
		if !run.WaitingToReport && run.ID != "" {
			runs = append(runs, run)
		}
	}
	return runs
}

// Run is one entry of `current`.
type Run struct {
	ID               string     `json:"id"`
	Job              string     `json:"job"`
	Phase            string     `json:"phase"`
	ClaimedAt        *time.Time `json:"claimedAt"`
	Since            *time.Time `json:"since"` // agents before 0.3
	StartedAt        *time.Time `json:"startedAt"`
	ElapsedMs        *float64   `json:"elapsedMs"`
	CPUPct           *float64   `json:"cpuPct"`
	MemoryBytes      *float64   `json:"memoryBytes"`
	PeakMemoryBytes  *float64   `json:"peakMemoryBytes"`
	MemoryLimitBytes *float64   `json:"memoryLimitBytes"`
	WaitingToReport  bool       `json:"waitingToReport"`
}

// Entry is one finished run from GET /v1/history.
type Entry struct {
	Run         string     `json:"run"`
	Job         string     `json:"job"`
	FinishedAt  *time.Time `json:"finishedAt"`
	Outcome     string     `json:"outcome"`
	ExitCode    *int       `json:"exitCode"`
	OOMKilled   bool       `json:"oomKilled"`
	TimedOut    bool       `json:"timedOut"`
	Error       string     `json:"error"`
	ErrorDetail string     `json:"errorDetail"`
	DurationMs  *float64   `json:"durationMs"`
	Passed      *bool      `json:"passed"`
	Published   []struct {
		Key string `json:"key"`
		Run string `json:"run"`
	} `json:"published"`
}

// Failed is ✗.
func (e Entry) Failed() bool {
	if e.Passed != nil {
		return !*e.Passed
	}
	return e.Outcome == "failed"
}

// Endpoint is where the API is and its token.
type Endpoint struct {
	Port  int
	Token string
}

// Base is always loopback: the API listens nowhere else.
func (e Endpoint) Base() string { return fmt.Sprintf("http://127.0.0.1:%d", e.Port) }

// ErrNotRunning means nothing answers on the port.
var ErrNotRunning = errors.New("the agent is not running")

// ErrUnauthorized means the agent refused the token.
var ErrUnauthorized = errors.New("the agent refused the status token")

// Client talks to one agent.
type Client struct {
	Endpoint Endpoint
	HTTP     *http.Client
}

// NewClient makes a client that never uses a proxy (it is loopback) and gives up after 5 s.
func NewClient(endpoint Endpoint) *Client {
	transport := &http.Transport{Proxy: nil, DialContext: (&net.Dialer{Timeout: 3 * time.Second}).DialContext}
	return &Client{Endpoint: endpoint, HTTP: &http.Client{Timeout: 5 * time.Second, Transport: transport}}
}

func (c *Client) do(ctx context.Context, method, path string, body any, out any) error {
	var reader io.Reader
	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			return err
		}
		reader = bytes.NewReader(data)
	}
	request, err := http.NewRequestWithContext(ctx, method, c.Endpoint.Base()+path, reader)
	if err != nil {
		return err
	}
	request.Header.Set("Authorization", "Bearer "+c.Endpoint.Token)
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	response, err := c.HTTP.Do(request)
	if err != nil {
		var urlErr *url.Error
		if errors.As(err, &urlErr) {
			return fmt.Errorf("%w (nothing answers on 127.0.0.1:%d)", ErrNotRunning, c.Endpoint.Port)
		}
		return err
	}
	defer response.Body.Close()
	data, err := io.ReadAll(io.LimitReader(response.Body, 4<<20))
	if err != nil {
		return err
	}
	if response.StatusCode == http.StatusUnauthorized {
		return ErrUnauthorized
	}
	if response.StatusCode < 200 || response.StatusCode > 299 {
		var problem struct {
			Error string `json:"error"`
		}
		_ = json.Unmarshal(data, &problem)
		if problem.Error == "" {
			problem.Error = response.Status
		}
		if response.StatusCode == http.StatusNotFound {
			return fmt.Errorf("%w: %s", errNotFound, problem.Error)
		}
		return fmt.Errorf("the agent answered %d: %s", response.StatusCode, problem.Error)
	}
	if out == nil {
		return nil
	}
	return json.Unmarshal(data, out)
}

// errNotFound is a 404: an agent before 0.3, which has only GET /status.
var errNotFound = errors.New("not found")

// Status is GET /v1/status, or an older agent's GET /status.
func (c *Client) Status(ctx context.Context) (Status, error) {
	var status Status
	err := c.do(ctx, http.MethodGet, "/v1/status", nil, &status)
	if errors.Is(err, errNotFound) {
		status = Status{}
		err = c.do(ctx, http.MethodGet, "/status", nil, &status)
	}
	return status, err
}

// History is GET /v1/history?limit=N; an older agent keeps none.
func (c *Client) History(ctx context.Context, limit int) ([]Entry, error) {
	var answer struct {
		Runs []Entry `json:"runs"`
	}
	err := c.do(ctx, http.MethodGet, fmt.Sprintf("/v1/history?limit=%d", limit), nil, &answer)
	if errors.Is(err, errNotFound) {
		return []Entry{}, nil
	}
	return answer.Runs, err
}

// Pause, Resume, Drain and Restart are the control actions.
func (c *Client) Pause(ctx context.Context) error {
	return c.do(ctx, http.MethodPost, "/v1/pause", map[string]any{}, nil)
}

func (c *Client) Resume(ctx context.Context) error {
	return c.do(ctx, http.MethodPost, "/v1/resume", map[string]any{}, nil)
}

func (c *Client) Drain(ctx context.Context, on bool) error {
	return c.do(ctx, http.MethodPost, "/v1/drain", map[string]any{"drain": on}, nil)
}

func (c *Client) Restart(ctx context.Context) error {
	return c.do(ctx, http.MethodPost, "/v1/restart", map[string]any{}, nil)
}
