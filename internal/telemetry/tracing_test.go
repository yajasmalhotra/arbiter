package telemetry

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestWithTraceGeneratesTraceID(t *testing.T) {
	t.Parallel()

	handler := WithTrace(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if TraceIDFromContext(r.Context()) == "" {
			t.Fatal("expected trace id in context")
		}
		w.WriteHeader(http.StatusOK)
	}))

	req := httptest.NewRequest(http.MethodGet, "/healthz", nil)
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, req)

	if recorder.Header().Get(HeaderTraceID) == "" {
		t.Fatal("expected trace id header")
	}
}

func TestWithTracePreservesIncomingTraceID(t *testing.T) {
	t.Parallel()

	handler := WithTrace(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if TraceIDFromContext(r.Context()) != "trace-1" {
			t.Fatalf("unexpected trace id in context: %s", TraceIDFromContext(r.Context()))
		}
		w.WriteHeader(http.StatusOK)
	}))

	req := httptest.NewRequest(http.MethodGet, "/healthz", nil)
	req.Header.Set(HeaderTraceID, "trace-1")
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, req)

	if recorder.Header().Get(HeaderTraceID) != "trace-1" {
		t.Fatalf("expected trace-1 header, got %s", recorder.Header().Get(HeaderTraceID))
	}
}
