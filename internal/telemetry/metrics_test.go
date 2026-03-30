package telemetry

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestCounterRecorderSnapshot(t *testing.T) {
	t.Parallel()

	recorder := NewCounterRecorder()
	recorder.ObserveDecision("send_slack_message", true, 2*time.Millisecond)
	recorder.ObserveDecision("send_slack_message", false, 3*time.Millisecond)

	snapshot := recorder.Snapshot()
	if snapshot.DecisionsTotal != 2 {
		t.Fatalf("expected 2 decisions, got %d", snapshot.DecisionsTotal)
	}
	if snapshot.DecisionsAllow != 1 || snapshot.DecisionsDeny != 1 {
		t.Fatalf("unexpected allow/deny counts: %d/%d", snapshot.DecisionsAllow, snapshot.DecisionsDeny)
	}

	tool, ok := snapshot.ToolBreakdown["send_slack_message"]
	if !ok {
		t.Fatal("missing tool breakdown")
	}
	if tool.Allow != 1 || tool.Deny != 1 {
		t.Fatalf("unexpected tool counts: %d/%d", tool.Allow, tool.Deny)
	}
}

func TestCounterRecorderHandler(t *testing.T) {
	t.Parallel()

	recorder := NewCounterRecorder()
	recorder.ObserveDecision("run_sql_query", true, time.Millisecond)

	request := httptest.NewRequest(http.MethodGet, "/metrics", nil)
	response := httptest.NewRecorder()
	recorder.Handler()(response, request)

	body := response.Body.String()
	if response.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", response.Code)
	}
	if !strings.Contains(body, "arbiter_decisions_total 1") {
		t.Fatalf("missing total metric: %s", body)
	}
	if !strings.Contains(body, "arbiter_decision_latency_bucket") {
		t.Fatalf("missing latency histogram metric: %s", body)
	}
	if !strings.Contains(body, `arbiter_tool_decisions_allow_total{tool_name="run_sql_query"} 1`) {
		t.Fatalf("missing per-tool metric: %s", body)
	}
}
