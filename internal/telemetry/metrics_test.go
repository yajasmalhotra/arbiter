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
	recorder.ObserveDecision("send_slack_message", true, nil, "", 2*time.Millisecond)
	recorder.ObserveDecision("send_slack_message", false, nil, "", 3*time.Millisecond)
	policyDeny := false
	recorder.ObserveDecision("send_slack_message", true, &policyDeny, "shadow", time.Millisecond)

	snapshot := recorder.Snapshot()
	if snapshot.DecisionsTotal != 3 {
		t.Fatalf("expected 3 decisions, got %d", snapshot.DecisionsTotal)
	}
	if snapshot.DecisionsAllow != 2 || snapshot.DecisionsDeny != 1 || snapshot.ShadowWouldDeny != 1 {
		t.Fatalf("unexpected allow/deny/shadow-deny counts: %d/%d/%d", snapshot.DecisionsAllow, snapshot.DecisionsDeny, snapshot.ShadowWouldDeny)
	}

	tool, ok := snapshot.ToolBreakdown["send_slack_message"]
	if !ok {
		t.Fatal("missing tool breakdown")
	}
	if tool.Allow != 2 || tool.Deny != 1 || tool.ShadowWouldDeny != 1 {
		t.Fatalf("unexpected tool counts: %d/%d/%d", tool.Allow, tool.Deny, tool.ShadowWouldDeny)
	}
}

func TestCounterRecorderHandler(t *testing.T) {
	t.Parallel()

	recorder := NewCounterRecorder()
	recorder.ObserveDecision("run_sql_query", true, nil, "", time.Millisecond)

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
	if !strings.Contains(body, "arbiter_shadow_would_deny_total 0") {
		t.Fatalf("missing shadow decision metric: %s", body)
	}
	if !strings.Contains(body, `arbiter_tool_decisions_allow_total{tool_name="run_sql_query"} 1`) {
		t.Fatalf("missing per-tool metric: %s", body)
	}
}
