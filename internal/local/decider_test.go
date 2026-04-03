package local

import (
	"context"
	"encoding/json"
	"testing"

	"arbiter/internal/pdp"
	"arbiter/internal/schema"
)

func TestDeciderAllowAndDeny(t *testing.T) {
	t.Parallel()

	decider, err := NewDecider(context.Background())
	if err != nil {
		t.Fatalf("new decider: %v", err)
	}

	allowReq := mustCanonicalRequest(t, "req-allow", "exec", map[string]any{"command": "ls -la"})
	allowDecision, err := decider.Decide(context.Background(), allowReq)
	if err != nil {
		t.Fatalf("allow decision returned error: %v", err)
	}
	if !allowDecision.Allow {
		t.Fatalf("expected allow decision, got deny: %+v", allowDecision)
	}

	denyReq := mustCanonicalRequest(t, "req-deny", "exec", map[string]any{"command": "rm -rf /tmp"})
	denyDecision, err := decider.Decide(context.Background(), denyReq)
	if err != pdp.ErrDeniedByPolicy {
		t.Fatalf("expected ErrDeniedByPolicy, got %v", err)
	}
	if denyDecision.Allow {
		t.Fatalf("expected deny decision")
	}
}

func mustCanonicalRequest(t *testing.T, requestID, toolName string, parameters map[string]any) schema.CanonicalRequest {
	t.Helper()
	raw, err := json.Marshal(parameters)
	if err != nil {
		t.Fatalf("marshal parameters: %v", err)
	}

	return schema.CanonicalRequest{
		SchemaVersion: schema.CurrentSchemaVersion,
		Metadata: schema.Metadata{
			RequestID: requestID,
			TenantID:  "tenant-local",
			Provider:  "framework",
		},
		AgentContext: schema.AgentContext{
			Actor: schema.Actor{ID: "agent-local"},
		},
		ToolName:   toolName,
		Parameters: raw,
	}
}
