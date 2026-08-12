package local

import (
	"context"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func runtimeTestConfig(t *testing.T) Config {
	t.Helper()
	dataDir := t.TempDir()
	return Config{DataDir: dataDir, BaseURL: "http://127.0.0.1:1"}
}

func TestRuntimeStateIsPrivateAndExclusive(t *testing.T) {
	t.Parallel()
	cfg := runtimeTestConfig(t)
	state, err := CreateRuntimeState(cfg)
	if err != nil {
		t.Fatalf("create runtime state: %v", err)
	}
	t.Cleanup(func() { RemoveRuntimeState(cfg) })

	loaded, err := LoadRuntimeState(cfg)
	if err != nil {
		t.Fatalf("load runtime state: %v", err)
	}
	if loaded.PID != os.Getpid() || loaded.StopToken != state.StopToken || len(state.StopToken) != 64 {
		t.Fatalf("unexpected runtime state: %#v", loaded)
	}
	info, err := os.Stat(RuntimeStatePath(cfg))
	if err != nil {
		t.Fatal(err)
	}
	if got := info.Mode().Perm(); got != 0o600 {
		t.Fatalf("runtime state mode = %o, want 600", got)
	}
	if _, err := CreateRuntimeState(cfg); err == nil {
		t.Fatal("expected a second runtime state writer to fail")
	}
}

func TestRuntimeStopRouteRequiresPrivateToken(t *testing.T) {
	t.Parallel()
	state := RuntimeState{PID: 42, StopToken: "private-token", StartedAt: time.Now()}
	stopped := make(chan struct{}, 1)
	mux := http.NewServeMux()
	RegisterStopRoute(mux, state, func() { stopped <- struct{}{} })

	unauthorized, _ := http.NewRequest(http.MethodPost, "http://localhost/_arbiter/local/stop", nil)
	unauthorized.RemoteAddr = "127.0.0.1:1234"
	unauthorized.Header.Set("Authorization", "Bearer wrong-token")
	unauthorizedResponse := newResponseRecorder()
	mux.ServeHTTP(unauthorizedResponse, unauthorized)
	if unauthorizedResponse.status != http.StatusUnauthorized {
		t.Fatalf("unauthorized stop status = %d", unauthorizedResponse.status)
	}

	authorized, _ := http.NewRequest(http.MethodPost, "http://localhost/_arbiter/local/stop", nil)
	authorized.RemoteAddr = "127.0.0.1:1234"
	authorized.Header.Set("Authorization", "Bearer "+state.StopToken)
	authorizedResponse := newResponseRecorder()
	mux.ServeHTTP(authorizedResponse, authorized)
	if authorizedResponse.status != http.StatusAccepted {
		t.Fatalf("authorized stop status = %d", authorizedResponse.status)
	}
	select {
	case <-stopped:
	case <-time.After(time.Second):
		t.Fatal("authorized stop did not request shutdown")
	}
}

func TestRuntimeStopRouteRejectsRemoteClients(t *testing.T) {
	t.Parallel()
	state := RuntimeState{PID: 42, StopToken: "private-token", StartedAt: time.Now()}
	mux := http.NewServeMux()
	RegisterStopRoute(mux, state, func() { t.Error("remote request triggered shutdown") })
	request, _ := http.NewRequest(http.MethodPost, "http://localhost/_arbiter/local/stop", nil)
	request.RemoteAddr = "192.0.2.10:1234"
	request.Header.Set("Authorization", "Bearer "+state.StopToken)
	response := newResponseRecorder()
	mux.ServeHTTP(response, request)
	if response.status != http.StatusForbidden {
		t.Fatalf("remote stop status = %d, want %d", response.status, http.StatusForbidden)
	}
}

func TestCheckReadyUsesReadyEndpoint(t *testing.T) {
	t.Parallel()
	client := &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
		if request.URL.String() != "http://arbiter.test/readyz" {
			t.Fatalf("readiness URL = %q", request.URL.String())
		}
		return &http.Response{StatusCode: http.StatusOK, Body: io.NopCloser(strings.NewReader(`{"status":"ready"}`)), Header: make(http.Header)}, nil
	})}
	cfg := Config{BaseURL: "http://arbiter.test", DataDir: filepath.Join(t.TempDir(), "data")}
	if err := checkReady(context.Background(), cfg, client); err != nil {
		t.Fatalf("check ready: %v", err)
	}
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (fn roundTripFunc) RoundTrip(request *http.Request) (*http.Response, error) {
	return fn(request)
}

type responseRecorder struct {
	header http.Header
	status int
}

func newResponseRecorder() *responseRecorder {
	return &responseRecorder{header: make(http.Header), status: http.StatusOK}
}

func (recorder *responseRecorder) Header() http.Header            { return recorder.header }
func (recorder *responseRecorder) Write(body []byte) (int, error) { return len(body), nil }
func (recorder *responseRecorder) WriteHeader(status int)         { recorder.status = status }
