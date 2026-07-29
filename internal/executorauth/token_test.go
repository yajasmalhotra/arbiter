package executorauth

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/pem"
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

func TestIssueRejectsDecisionWithoutReplayIdentifier(t *testing.T) {
	t.Parallel()
	issuer := NewIssuerVerifier([]byte("top-secret"), "arbiter", time.Minute, NewMemoryReplayCache())
	decision := baseDecision()
	decision.DecisionID = ""
	if _, err := issuer.Issue(baseRequest(), decision); err != ErrInvalidDecision {
		t.Fatalf("expected missing decision ID rejection, got %v", err)
	}
}

func TestIssueRejectsExplicitDeny(t *testing.T) {
	t.Parallel()
	issuer := NewIssuerVerifier([]byte("top-secret"), "arbiter", time.Minute, NewMemoryReplayCache())
	decision := baseDecision()
	decision.Allow = false
	if _, err := issuer.Issue(baseRequest(), decision); err != ErrInvalidDecision {
		t.Fatalf("expected deny decision rejection, got %v", err)
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

func TestRS256PermitCanBeVerifiedWithPublicKeyOnly(t *testing.T) {
	t.Parallel()
	privateKey, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatalf("generate rsa key: %v", err)
	}
	issuer := NewIssuerVerifierWithRS256PrivateKeys(
		map[string]*rsa.PrivateKey{"rs256-2026": privateKey},
		"rs256-2026",
		"arbiter",
		time.Minute,
		NewMemoryReplayCache(),
	)
	verifier := NewVerifierWithRS256PublicKeys(
		map[string]*rsa.PublicKey{"rs256-2026": &privateKey.PublicKey},
		"arbiter",
		NewMemoryReplayCache(),
	)
	req := baseRequest()
	token, err := issuer.Issue(req, baseDecision())
	if err != nil {
		t.Fatalf("issue RS256 token: %v", err)
	}
	claims, err := verifier.Verify(context.Background(), token, req)
	if err != nil || claims.DecisionID != "decision-1" {
		t.Fatalf("verify RS256 token claims=%#v err=%v", claims, err)
	}
	if _, err := verifier.Issue(req, baseDecision()); err != ErrInvalidToken {
		t.Fatalf("public-key verifier must not issue permits, got %v", err)
	}
}

func TestParseRS256PrivateKeyPEMRejectsWeakKey(t *testing.T) {
	t.Parallel()
	weakKey, err := rsa.GenerateKey(rand.Reader, 1024)
	if err != nil {
		t.Fatalf("generate weak rsa key: %v", err)
	}
	raw, err := x509.MarshalPKCS8PrivateKey(weakKey)
	if err != nil {
		t.Fatalf("marshal weak rsa key: %v", err)
	}
	pemValue := pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: raw})
	if _, err := ParseRS256PrivateKeyPEM(pemValue); err != ErrInvalidToken {
		t.Fatalf("expected weak RS256 key rejection, got %v", err)
	}
}
