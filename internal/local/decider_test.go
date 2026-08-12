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
	if allowDecision.EnforcementMode != "enforce" || !allowDecision.EvaluatedAllow() {
		t.Fatalf("expected explicit enforce-mode raw allow, got %+v", allowDecision)
	}

	denyReq := mustCanonicalRequest(t, "req-deny", "exec", map[string]any{"command": "rm -rf /tmp"})
	denyDecision, err := decider.Decide(context.Background(), denyReq)
	if err != pdp.ErrDeniedByPolicy {
		t.Fatalf("expected ErrDeniedByPolicy, got %v", err)
	}
	if denyDecision.Allow {
		t.Fatalf("expected deny decision")
	}
	if denyDecision.EnforcementMode != "enforce" || denyDecision.EvaluatedAllow() {
		t.Fatalf("expected explicit enforce-mode raw deny, got %+v", denyDecision)
	}
}

func TestDeciderPlansAndEnforcesPolicyOwnedContext(t *testing.T) {
	t.Parallel()
	decider, err := NewDecider(context.Background())
	if err != nil {
		t.Fatalf("new decider: %v", err)
	}
	req := mustCanonicalRequest(t, "req-delete-backup", "delete_backup", map[string]any{"backup_id": "backup-1"})
	obligations, err := decider.PlanObligations(context.Background(), req)
	if err != nil {
		t.Fatalf("plan obligations: %v", err)
	}
	if len(obligations) != 1 || obligations[0].Type != "recent_actions" {
		t.Fatalf("expected recent-actions policy obligation, got %#v", obligations)
	}
	decision, err := decider.Decide(context.Background(), req)
	if err != pdp.ErrDeniedByPolicy || !decision.RequiredContextMissing {
		t.Fatalf("expected missing policy context denial, got decision=%#v err=%v", decision, err)
	}
}

func TestDeciderPlansFinancialApproval(t *testing.T) {
	t.Parallel()
	decider, err := NewDecider(context.Background())
	if err != nil {
		t.Fatalf("new decider: %v", err)
	}
	req := mustCanonicalRequest(t, "req-refund", "create_stripe_refund", map[string]any{"amount_cents": 100})
	obligations, err := decider.PlanObligations(context.Background(), req)
	if err != nil {
		t.Fatalf("plan obligations: %v", err)
	}
	if len(obligations) != 1 || obligations[0].Type != "approval" || obligations[0].Class != "financial" {
		t.Fatalf("expected financial approval obligation, got %#v", obligations)
	}
	decision, err := decider.Decide(context.Background(), req)
	if err != pdp.ErrDeniedByPolicy || !decision.RequiredContextMissing {
		t.Fatalf("expected approval-missing denial, decision=%#v err=%v", decision, err)
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
