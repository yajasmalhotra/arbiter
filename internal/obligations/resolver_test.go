package obligations

import (
	"context"
	"testing"
	"time"

	"arbiter/internal/schema"
	"arbiter/internal/state"
)

func testRequest() schema.CanonicalRequest {
	return schema.CanonicalRequest{Metadata: schema.Metadata{TenantID: "tenant-1"}, AgentContext: schema.AgentContext{Actor: schema.Actor{ID: "agent-1"}}}
}

func TestRegistryResolvesPolicyRequestedRecentActions(t *testing.T) {
	t.Parallel()
	store := state.NewMemoryStore()
	if err := store.RecordAction(context.Background(), state.ActionRecord{TenantID: "tenant-1", ActorID: "agent-1", PreviousAction: schema.PreviousAction{ToolName: "backup", At: time.Now().UTC()}}); err != nil {
		t.Fatalf("record action: %v", err)
	}
	resolved, err := New(store, 5).Resolve(context.Background(), testRequest(), []schema.Obligation{{Type: RecentActions, Scope: "actor_session", Limit: 1}})
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}
	if len(resolved.PreviousActions) != 1 || len(resolved.Obligations) != 1 {
		t.Fatalf("expected trusted history and obligation, got %#v", resolved)
	}
}

func TestRegistryRejectsUnknownObligation(t *testing.T) {
	t.Parallel()
	_, err := New(state.NewMemoryStore(), 5).Resolve(context.Background(), testRequest(), []schema.Obligation{{Type: "remote_url"}})
	if err == nil {
		t.Fatal("expected unknown obligation to fail closed")
	}
}

func TestRegistryRequiresVerifiedApprovalForApprovalObligation(t *testing.T) {
	t.Parallel()
	req := testRequest()
	_, err := New(state.NewMemoryStore(), 5).Resolve(context.Background(), req, []schema.Obligation{{Type: Approval, Class: "financial"}})
	if err == nil {
		t.Fatal("expected missing approval to fail closed")
	}
	req.Approval = &schema.Approval{ApprovalID: "approval-1", ActionHash: "hash", Class: "financial", ApprovedBy: "reviewer-1"}
	if _, err := New(state.NewMemoryStore(), 5).Resolve(context.Background(), req, []schema.Obligation{{Type: Approval, Class: "financial"}}); err != nil {
		t.Fatalf("resolve verified approval: %v", err)
	}
}
