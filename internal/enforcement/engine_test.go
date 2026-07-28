package enforcement

import (
	"context"
	"testing"
	"time"

	"arbiter/internal/executorauth"
	"arbiter/internal/pdp"
	"arbiter/internal/schema"
	"arbiter/internal/state"
)

type deciderFunc func(context.Context, schema.CanonicalRequest) (schema.Decision, error)

func (f deciderFunc) Decide(ctx context.Context, req schema.CanonicalRequest) (schema.Decision, error) {
	return f(ctx, req)
}

type plannedDecider struct {
	decide func(context.Context, schema.CanonicalRequest) (schema.Decision, error)
	plan   []schema.Obligation
}

func (d plannedDecider) Decide(ctx context.Context, req schema.CanonicalRequest) (schema.Decision, error) {
	return d.decide(ctx, req)
}

func (d plannedDecider) PlanObligations(_ context.Context, _ schema.CanonicalRequest) ([]schema.Obligation, error) {
	return d.plan, nil
}

func testRequest() schema.CanonicalRequest {
	return schema.CanonicalRequest{
		SchemaVersion: schema.CurrentSchemaVersion,
		Metadata: schema.Metadata{
			RequestID: "request-1",
			TenantID:  "tenant-1",
		},
		AgentContext: schema.AgentContext{Actor: schema.Actor{ID: "agent-1"}},
		ToolName:     "send_slack_message",
		Parameters:   []byte(`{"channel":"ops","message":"hello"}`),
	}
}

func newTestEngine(store state.Store, decider pdp.Decider) *Engine {
	return New(Config{DecisionTimeout: time.Second, StateLookupLimit: 5}, store, decider,
		executorauth.NewIssuerVerifier([]byte("test-secret"), "arbiter", time.Minute, executorauth.NewMemoryReplayCache()), nil, nil)
}

func TestEngineIssuesPermitForAllowedRequest(t *testing.T) {
	t.Parallel()
	engine := newTestEngine(state.NewMemoryStore(), deciderFunc(func(_ context.Context, req schema.CanonicalRequest) (schema.Decision, error) {
		return schema.Decision{Allow: true, DecisionID: req.Metadata.RequestID, PolicyVersion: "test"}, nil
	}))

	result, err := engine.Enforce(context.Background(), testRequest())
	if err != nil {
		t.Fatalf("enforce: %v", err)
	}
	if !result.Decision.Allow || result.Token == "" {
		t.Fatalf("expected an allowed decision and permit, got %#v", result)
	}
}

func TestEnginePreservesPolicyDenyDecision(t *testing.T) {
	t.Parallel()
	engine := newTestEngine(state.NewMemoryStore(), deciderFunc(func(_ context.Context, req schema.CanonicalRequest) (schema.Decision, error) {
		return schema.Decision{Allow: false, DecisionID: req.Metadata.RequestID, Reason: "denied"}, pdp.ErrDeniedByPolicy
	}))

	result, err := engine.Enforce(context.Background(), testRequest())
	if !IsDenied(err) {
		t.Fatalf("expected policy denial, got %v", err)
	}
	if result.Decision.Allow || result.Decision.Reason != "denied" {
		t.Fatalf("expected deny decision to be preserved, got %#v", result.Decision)
	}
}

func TestEngineLoadsLegacyRequiredContext(t *testing.T) {
	t.Parallel()
	store := state.NewMemoryStore()
	if err := store.RecordAction(context.Background(), state.ActionRecord{
		TenantID: "tenant-1",
		ActorID:  "agent-1",
		PreviousAction: schema.PreviousAction{
			ToolName: "backup_database",
			Outcome:  "allowed",
			At:       time.Now().UTC(),
		},
	}); err != nil {
		t.Fatalf("record action: %v", err)
	}
	engine := newTestEngine(store, deciderFunc(func(_ context.Context, req schema.CanonicalRequest) (schema.Decision, error) {
		if len(req.PreviousActions) != 1 {
			t.Fatalf("expected loaded history, got %#v", req.PreviousActions)
		}
		return schema.Decision{Allow: true, DecisionID: req.Metadata.RequestID}, nil
	}))

	req := testRequest()
	req.RequiredContext = []string{"recent_actions"}
	if _, err := engine.Enforce(context.Background(), req); err != nil {
		t.Fatalf("enforce: %v", err)
	}
}

func TestEngineUsesPolicyOwnedObligationsWithoutClientHints(t *testing.T) {
	t.Parallel()
	store := state.NewMemoryStore()
	if err := store.RecordAction(context.Background(), state.ActionRecord{
		TenantID: "tenant-1", ActorID: "agent-1",
		PreviousAction: schema.PreviousAction{ToolName: "backup_database", Outcome: "allowed", At: time.Now().UTC()},
	}); err != nil {
		t.Fatalf("record action: %v", err)
	}
	decider := plannedDecider{
		plan: []schema.Obligation{{Type: "recent_actions", Scope: "actor_session", Limit: 1}},
		decide: func(_ context.Context, req schema.CanonicalRequest) (schema.Decision, error) {
			if len(req.RequiredContext) != 0 {
				t.Fatalf("test must not rely on client context hints")
			}
			if len(req.Obligations) != 1 || len(req.PreviousActions) != 1 {
				t.Fatalf("policy obligation was not resolved: %#v", req)
			}
			return schema.Decision{Allow: true, DecisionID: req.Metadata.RequestID}, nil
		},
	}
	engine := New(Config{DecisionTimeout: time.Second, StateLookupLimit: 5, PolicyOwnedObligations: true}, store, decider,
		executorauth.NewIssuerVerifier([]byte("test-secret"), "arbiter", time.Minute, executorauth.NewMemoryReplayCache()), nil, nil)
	if _, err := engine.Enforce(context.Background(), testRequest()); err != nil {
		t.Fatalf("enforce: %v", err)
	}
}
