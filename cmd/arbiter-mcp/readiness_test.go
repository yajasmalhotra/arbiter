package main

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"arbiter/internal/audit"
	"arbiter/internal/executorauth"
	"arbiter/internal/pdp"
	"arbiter/internal/schema"
	"arbiter/internal/state"
)

type mcpReadyDecider struct{ readyErr error }

func (d mcpReadyDecider) Decide(_ context.Context, _ schema.CanonicalRequest) (schema.Decision, error) {
	return schema.Decision{}, nil
}

func (d mcpReadyDecider) Ready(_ context.Context) error { return d.readyErr }

type mcpReadyAudit struct{ readyErr error }

func (r mcpReadyAudit) Record(context.Context, audit.Event) {}
func (r mcpReadyAudit) Ready(context.Context) error         { return r.readyErr }

func TestReadinessHandlerReportsHealthyDependencies(t *testing.T) {
	handler := newReadinessHandler(readinessConfig{
		Timeout: time.Second,
		State:   state.NewMemoryStore(),
		Decider: mcpReadyDecider{},
		Issuer:  executorauth.NewIssuerVerifier([]byte("test"), "arbiter", time.Minute, executorauth.NewMemoryReplayCache()),
		Audit:   mcpReadyAudit{},
	})
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/readyz", nil))
	if recorder.Code != http.StatusOK {
		t.Fatalf("expected ready, got %d: %s", recorder.Code, recorder.Body.String())
	}
}

func TestReadinessHandlerRejectsUnavailableAuditSink(t *testing.T) {
	handler := newReadinessHandler(readinessConfig{
		State:   state.NewMemoryStore(),
		Decider: pdp.StaticDecider{},
		Issuer:  executorauth.NewIssuerVerifier([]byte("test"), "arbiter", time.Minute, executorauth.NewMemoryReplayCache()),
		Audit:   mcpReadyAudit{readyErr: errors.New("audit unavailable")},
	})
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/readyz", nil))
	if recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("expected audit failure to make gateway unready, got %d", recorder.Code)
	}
}

func TestReadinessHandlerRequiresConfiguredWorkloadIdentity(t *testing.T) {
	handler := newReadinessHandler(readinessConfig{RequireWorkloadIdentity: true})
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/readyz", nil))
	if recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("expected missing workload identity to make gateway unready, got %d", recorder.Code)
	}
}
