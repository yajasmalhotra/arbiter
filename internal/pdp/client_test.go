package pdp

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"arbiter/internal/schema"
)

func TestClientDecideAllow(t *testing.T) {
	t.Parallel()

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var payload map[string]any
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			t.Fatalf("decode request: %v", err)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"result": map[string]any{
				"allow":          true,
				"reason":         "allowed",
				"policy_package": "arbiter.authz",
				"policy_version": "v1",
				"data_revision":  "rev-1",
				"decision_id":    "decision-1",
			},
		})
	}))
	defer server.Close()

	client := NewClient(server.URL, "", 0)
	decision, err := client.Decide(context.Background(), schema.CanonicalRequest{
		SchemaVersion: schema.CurrentSchemaVersion,
		Metadata: schema.Metadata{
			RequestID: "req-1",
			TenantID:  "tenant-1",
		},
		AgentContext: schema.AgentContext{
			Actor: schema.Actor{ID: "actor-1"},
		},
		ToolName:   "send_slack_message",
		Parameters: []byte(`{"channel":"ops"}`),
	})
	if err != nil {
		t.Fatalf("decide: %v", err)
	}

	if !decision.Allow {
		t.Fatal("expected allow decision")
	}
}

func TestClientDecideDeny(t *testing.T) {
	t.Parallel()

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"result": map[string]any{
				"allow":          false,
				"reason":         "channel not allowed",
				"policy_package": "arbiter.authz",
				"policy_version": "v1",
				"data_revision":  "rev-1",
				"decision_id":    "decision-1",
			},
		})
	}))
	defer server.Close()

	client := NewClient(server.URL, "", 0)
	_, err := client.Decide(context.Background(), schema.CanonicalRequest{
		SchemaVersion: schema.CurrentSchemaVersion,
		Metadata: schema.Metadata{
			RequestID: "req-1",
			TenantID:  "tenant-1",
		},
		AgentContext: schema.AgentContext{
			Actor: schema.Actor{ID: "actor-1"},
		},
		ToolName:   "send_slack_message",
		Parameters: []byte(`{"channel":"ops"}`),
	})
	if err != ErrDeniedByPolicy {
		t.Fatalf("expected deny error, got %v", err)
	}
}

func TestClientDecideShadowWouldDeny(t *testing.T) {
	t.Parallel()

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"result": map[string]any{
				"allow":            true,
				"policy_allow":     false,
				"enforcement_mode": "shadow",
				"reason":           "tool policy denied",
				"policy_package":   "arbiter.authz",
				"policy_version":   "v2-shadow",
				"data_revision":    "rev-2",
				"decision_id":      "decision-shadow",
			},
		})
	}))
	defer server.Close()

	client := NewClient(server.URL, "", 0)
	decision, err := client.Decide(context.Background(), schema.CanonicalRequest{
		SchemaVersion: schema.CurrentSchemaVersion,
		Metadata:      schema.Metadata{RequestID: "req-shadow", TenantID: "tenant-1"},
		AgentContext:  schema.AgentContext{Actor: schema.Actor{ID: "actor-1"}},
		ToolName:      "bash",
		Parameters:    []byte(`{"command":"rm -rf /tmp/example"}`),
	})
	if err != nil {
		t.Fatalf("shadow decide: %v", err)
	}
	if !decision.Allow || decision.EvaluatedAllow() || decision.EnforcementMode != "shadow" {
		t.Fatalf("unexpected shadow decision: %#v", decision)
	}
}

func TestClientReady(t *testing.T) {
	t.Parallel()

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/health" {
			t.Fatalf("unexpected path: %s", r.URL.Path)
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	client := NewClient(server.URL, "", 0)
	if err := client.Ready(context.Background()); err != nil {
		t.Fatalf("ready: %v", err)
	}
}
