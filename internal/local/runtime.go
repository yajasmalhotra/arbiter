package local

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

const runtimeReadyTimeout = 5 * time.Second
const runtimeStartLockTimeout = 15 * time.Second

type RuntimeProcess struct {
	PID            int
	LogPath        string
	AlreadyRunning bool
}

type RuntimeState struct {
	PID       int       `json:"pid"`
	StopToken string    `json:"stop_token"`
	StartedAt time.Time `json:"started_at"`
}

func RuntimeStatePath(cfg Config) string {
	return filepath.Join(cfg.DataDir, "runtime.json")
}

func RuntimeLogPath(cfg Config) string {
	return filepath.Join(cfg.DataDir, "runtime.log")
}

func RuntimePID(cfg Config) (int, error) {
	state, err := LoadRuntimeState(cfg)
	if err != nil {
		return 0, err
	}
	return state.PID, nil
}

func LoadRuntimeState(cfg Config) (RuntimeState, error) {
	raw, err := os.ReadFile(RuntimeStatePath(cfg))
	if err != nil {
		return RuntimeState{}, err
	}
	var state RuntimeState
	if err := json.Unmarshal(raw, &state); err != nil {
		return RuntimeState{}, fmt.Errorf("decode runtime state %s: %w", RuntimeStatePath(cfg), err)
	}
	if state.PID <= 0 || strings.TrimSpace(state.StopToken) == "" {
		return RuntimeState{}, fmt.Errorf("invalid runtime state %s", RuntimeStatePath(cfg))
	}
	return state, nil
}

func CreateRuntimeState(cfg Config) (RuntimeState, error) {
	tokenBytes := make([]byte, 32)
	if _, err := rand.Read(tokenBytes); err != nil {
		return RuntimeState{}, fmt.Errorf("generate runtime stop token: %w", err)
	}
	state := RuntimeState{PID: os.Getpid(), StopToken: hex.EncodeToString(tokenBytes), StartedAt: time.Now().UTC()}
	raw, err := json.MarshalIndent(state, "", "  ")
	if err != nil {
		return RuntimeState{}, err
	}
	raw = append(raw, '\n')
	stateFile, err := createRuntimeStateFile(cfg)
	if err != nil {
		return RuntimeState{}, fmt.Errorf("write runtime state: %w", err)
	}
	if _, err := stateFile.Write(raw); err != nil {
		_ = stateFile.Close()
		RemoveRuntimeState(cfg)
		return RuntimeState{}, fmt.Errorf("write runtime state: %w", err)
	}
	if err := stateFile.Close(); err != nil {
		RemoveRuntimeState(cfg)
		return RuntimeState{}, fmt.Errorf("close runtime state: %w", err)
	}
	return state, nil
}

func createRuntimeStateFile(cfg Config) (*os.File, error) {
	path := RuntimeStatePath(cfg)
	stateFile, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err == nil || !errors.Is(err, os.ErrExist) {
		return stateFile, err
	}
	info, statErr := os.Stat(path)
	if statErr != nil {
		return nil, err
	}
	if time.Since(info.ModTime()) < runtimeStartLockTimeout {
		return nil, errors.New("another local runtime is starting")
	}
	if removeErr := os.Remove(path); removeErr != nil {
		return nil, fmt.Errorf("remove stale runtime state: %w", removeErr)
	}
	return os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
}

func RemoveRuntimeState(cfg Config) {
	_ = os.Remove(RuntimeStatePath(cfg))
}

func RegisterStopRoute(mux *http.ServeMux, state RuntimeState, stop func()) {
	mux.HandleFunc("POST /_arbiter/local/stop", func(writer http.ResponseWriter, request *http.Request) {
		host, _, err := net.SplitHostPort(request.RemoteAddr)
		if err != nil || !net.ParseIP(host).IsLoopback() {
			http.Error(writer, "local access required", http.StatusForbidden)
			return
		}
		supplied := strings.TrimPrefix(request.Header.Get("Authorization"), "Bearer ")
		if len(supplied) != len(state.StopToken) || subtle.ConstantTimeCompare([]byte(supplied), []byte(state.StopToken)) != 1 {
			http.Error(writer, "unauthorized", http.StatusUnauthorized)
			return
		}
		writer.WriteHeader(http.StatusAccepted)
		go stop()
	})
}

func CheckReady(ctx context.Context, cfg Config) error {
	return checkReady(ctx, cfg, &http.Client{Timeout: 1500 * time.Millisecond})
}

func checkReady(ctx context.Context, cfg Config, client *http.Client) error {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, cfg.BaseURL+"/readyz", nil)
	if err != nil {
		return err
	}
	response, err := client.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return fmt.Errorf("runtime returned status %d", response.StatusCode)
	}
	var readiness struct {
		Status string `json:"status"`
	}
	if err := json.NewDecoder(io.LimitReader(response.Body, 1024)).Decode(&readiness); err != nil {
		return fmt.Errorf("decode runtime readiness: %w", err)
	}
	if readiness.Status != "ready" {
		return fmt.Errorf("unexpected runtime readiness status %q", readiness.Status)
	}
	return nil
}

func StartBackground(ctx context.Context, cfg Config, executable string) (RuntimeProcess, error) {
	if err := ctx.Err(); err != nil {
		return RuntimeProcess{}, err
	}
	if err := CheckReady(ctx, cfg); err == nil {
		pid, _ := RuntimePID(cfg)
		return RuntimeProcess{PID: pid, LogPath: RuntimeLogPath(cfg), AlreadyRunning: true}, nil
	}
	if strings.TrimSpace(executable) == "" {
		return RuntimeProcess{}, errors.New("resolve arbiter executable: empty path")
	}
	if err := os.MkdirAll(cfg.DataDir, 0o700); err != nil {
		return RuntimeProcess{}, fmt.Errorf("create runtime data directory: %w", err)
	}

	logPath := RuntimeLogPath(cfg)
	logFile, err := os.OpenFile(logPath, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return RuntimeProcess{}, fmt.Errorf("open runtime log: %w", err)
	}

	command := exec.Command(executable, "local", "start")
	command.Stdin = nil
	command.Stdout = logFile
	command.Stderr = logFile
	command.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err := command.Start(); err != nil {
		_ = logFile.Close()
		return RuntimeProcess{}, fmt.Errorf("start local runtime: %w", err)
	}
	pid := command.Process.Pid
	if err := command.Process.Release(); err != nil {
		_ = logFile.Close()
		return RuntimeProcess{}, fmt.Errorf("release local runtime process: %w", err)
	}
	_ = logFile.Close()

	readyContext, cancel := context.WithTimeout(ctx, runtimeReadyTimeout)
	defer cancel()
	for {
		if err := CheckReady(readyContext, cfg); err == nil {
			actualPID, _ := RuntimePID(cfg)
			if actualPID > 0 && actualPID != pid {
				return RuntimeProcess{PID: actualPID, LogPath: logPath, AlreadyRunning: true}, nil
			}
			return RuntimeProcess{PID: pid, LogPath: logPath}, nil
		}
		select {
		case <-readyContext.Done():
			process, findErr := os.FindProcess(pid)
			if findErr == nil {
				_ = process.Kill()
			}
			if state, stateErr := LoadRuntimeState(cfg); stateErr == nil && state.PID == pid {
				RemoveRuntimeState(cfg)
			}
			return RuntimeProcess{}, fmt.Errorf("local runtime did not become ready at %s; inspect %s", cfg.BaseURL, logPath)
		case <-time.After(100 * time.Millisecond):
		}
	}
}

func StopBackground(ctx context.Context, cfg Config) error {
	state, err := LoadRuntimeState(cfg)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			if readyErr := CheckReady(ctx, cfg); readyErr == nil {
				return errors.New("local runtime is reachable but has no local lifecycle state")
			}
			return errors.New("local runtime is not running")
		}
		return err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, cfg.BaseURL+"/_arbiter/local/stop", nil)
	if err != nil {
		return err
	}
	request.Header.Set("Authorization", "Bearer "+state.StopToken)
	response, err := (&http.Client{Timeout: 1500 * time.Millisecond}).Do(request)
	if err != nil {
		return fmt.Errorf("request local runtime shutdown: %w", err)
	}
	_ = response.Body.Close()
	if response.StatusCode != http.StatusAccepted {
		return fmt.Errorf("local runtime rejected shutdown (status %d)", response.StatusCode)
	}

	stopContext, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	for {
		if err := CheckReady(stopContext, cfg); err != nil {
			RemoveRuntimeState(cfg)
			return nil
		}
		select {
		case <-stopContext.Done():
			return errors.New("local runtime did not stop gracefully")
		case <-time.After(100 * time.Millisecond):
		}
	}
}
