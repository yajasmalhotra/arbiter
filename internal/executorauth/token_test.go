package executorauth

import (
	"context"
	"testing"
	"time"

	"arbiter/internal/schema"
)

func baseRequest() schema.CanonicalRequest {
	return schema.CanonicalRequest{
		SchemaVersion: schema.CurrentSchemaVersion,
		Metadata: schema.Metadata{
			RequestID: "req-1",
			TenantID:  "tenant-1",
		},
		AgentContext: schema.AgentContext{
			Actor: schema.Actor{ID: "actor-1"},
		},
		ToolName:   "send_slack_message",
		Parameters: []byte(`{"channel":"ops","message":"hello"}`),
	}
}

func baseDecision() schema.Decision {
	return schema.Decision{
		Allow:         true,
		Reason:        "allowed",
		PolicyPackage: "arbiter.authz",
		PolicyVersion: "v1",
		DataRevision:  "rev-1",
		DecisionID:    "decision-1",
	}
}

func TestIssueAndVerify(t *testing.T) {
	t.Parallel()

	issuer := NewIssuerVerifier([]byte("top-secret"), "arbiter", time.Minute, NewMemoryReplayCache())
	req := baseRequest()

	token, err := issuer.Issue(req, baseDecision())
	if err != nil {
		t.Fatalf("issue token: %v", err)
	}

	claims, err := issuer.Verify(context.Background(), token, req)
	if err != nil {
		t.Fatalf("verify token: %v", err)
	}

	if claims.DecisionID != "decision-1" {
		t.Fatalf("unexpected decision id: %s", claims.DecisionID)
	}
}

func TestVerifyRejectsReplay(t *testing.T) {
	t.Parallel()

	issuer := NewIssuerVerifier([]byte("top-secret"), "arbiter", time.Minute, NewMemoryReplayCache())
	req := baseRequest()

	token, err := issuer.Issue(req, baseDecision())
	if err != nil {
		t.Fatalf("issue token: %v", err)
	}

	if _, err := issuer.Verify(context.Background(), token, req); err != nil {
		t.Fatalf("first verify token: %v", err)
	}

	if _, err := issuer.Verify(context.Background(), token, req); err != ErrReplayDetected {
		t.Fatalf("expected replay error, got %v", err)
	}
}

func TestVerifyRejectsMismatchedRequest(t *testing.T) {
	t.Parallel()

	issuer := NewIssuerVerifier([]byte("top-secret"), "arbiter", time.Minute, NewMemoryReplayCache())
	req := baseRequest()

	token, err := issuer.Issue(req, baseDecision())
	if err != nil {
		t.Fatalf("issue token: %v", err)
	}

	req.Parameters = []byte(`{"channel":"security","message":"hello"}`)

	if _, err := issuer.Verify(context.Background(), token, req); err != ErrInvalidToken {
		t.Fatalf("expected invalid token error, got %v", err)
	}
}

func TestVerifySupportsKeyRotation(t *testing.T) {
	t.Parallel()

	issuer := NewIssuerVerifierWithKeys(
		map[string][]byte{
			"kid-old": []byte("old-secret"),
			"kid-new": []byte("new-secret"),
		},
		"kid-new",
		"arbiter",
		time.Minute,
		NewMemoryReplayCache(),
	)
	req := baseRequest()

	token, err := issuer.Issue(req, baseDecision())
	if err != nil {
		t.Fatalf("issue token: %v", err)
	}

	claims, err := issuer.Verify(context.Background(), token, req)
	if err != nil {
		t.Fatalf("verify token: %v", err)
	}
	if claims.DecisionID != "decision-1" {
		t.Fatalf("unexpected decision id: %s", claims.DecisionID)
	}
}
