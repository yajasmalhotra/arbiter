package capability

import (
	"context"
	"testing"
	"time"

	"arbiter/internal/schema"

	"github.com/alicebob/miniredis/v2"
	"github.com/golang-jwt/jwt/v5"
	"github.com/redis/go-redis/v9"
)

func signedGrant(t *testing.T, claims Claims) string {
	t.Helper()
	claims.RegisteredClaims = jwt.RegisteredClaims{Issuer: "arbiter", Audience: jwt.ClaimStrings{"arbiter-capability"}, ExpiresAt: jwt.NewNumericDate(time.Now().Add(time.Minute))}
	token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	token.Header["kid"] = "test"
	raw, err := token.SignedString([]byte("secret"))
	if err != nil {
		t.Fatalf("sign grant: %v", err)
	}
	return raw
}

func request() schema.CanonicalRequest {
	return schema.CanonicalRequest{ToolName: "refund", Parameters: []byte(`{"amount_cents":50}`), Target: &schema.Target{ServerID: "payments"}}
}

func principal() schema.Principal { return schema.Principal{Subject: "agent-1", TenantID: "tenant-1"} }

func TestVerifierAcceptsMatchingScopedGrant(t *testing.T) {
	t.Parallel()
	verifier := Verifier{Keys: map[string][]byte{"test": []byte("secret")}, Issuer: "arbiter", Audience: "arbiter-capability"}
	grant, err := verifier.Verify(context.Background(), signedGrant(t, Claims{GrantID: "grant-1", Subject: "agent-1", TenantID: "tenant-1", ServerIDs: []string{"payments"}, ToolNames: []string{"refund"}, MaxAmountCents: 100}), principal(), request())
	if err != nil {
		t.Fatalf("verify: %v", err)
	}
	if grant.GrantID != "grant-1" {
		t.Fatalf("unexpected grant: %#v", grant)
	}
}

func TestVerifierRejectsScopeAndRevocation(t *testing.T) {
	t.Parallel()
	store := NewMemoryRevocationStore()
	verifier := Verifier{Keys: map[string][]byte{"test": []byte("secret")}, Issuer: "arbiter", Audience: "arbiter-capability", Revocations: store}
	raw := signedGrant(t, Claims{GrantID: "grant-1", Subject: "agent-1", TenantID: "tenant-1", ServerIDs: []string{"payments"}, ToolNames: []string{"refund"}, MaxAmountCents: 10})
	if _, err := verifier.Verify(context.Background(), raw, principal(), request()); err == nil {
		t.Fatal("expected amount scope violation")
	}
	if err := store.Revoke(context.Background(), "grant-1", time.Now().Add(time.Minute)); err != nil {
		t.Fatalf("revoke: %v", err)
	}
	if _, err := verifier.Verify(context.Background(), raw, principal(), schema.CanonicalRequest{ToolName: "refund", Parameters: []byte(`{}`), Target: &schema.Target{ServerID: "payments"}}); err != ErrRevoked {
		t.Fatalf("expected revoked grant, got %v", err)
	}
}

func TestVerifierBindsGrantToWorkloadIdentity(t *testing.T) {
	t.Parallel()
	verifier := Verifier{Keys: map[string][]byte{"test": []byte("secret")}, Issuer: "arbiter", Audience: "arbiter-capability"}
	raw := signedGrant(t, Claims{GrantID: "grant-1", Subject: "agent-1", TenantID: "tenant-1", WorkloadID: "spiffe://prod/payments", ServerIDs: []string{"payments"}, ToolNames: []string{"refund"}})
	wrong := principal()
	wrong.WorkloadID = "spiffe://prod/other"
	if _, err := verifier.Verify(context.Background(), raw, wrong, request()); err != ErrInvalidGrant {
		t.Fatalf("expected workload mismatch to fail, got %v", err)
	}
	matching := principal()
	matching.WorkloadID = "spiffe://prod/payments"
	grant, err := verifier.Verify(context.Background(), raw, matching, request())
	if err != nil || grant.WorkloadID != matching.WorkloadID {
		t.Fatalf("expected matching workload grant, grant=%#v err=%v", grant, err)
	}
}

func TestVerifierRequiresDelegableGrantForDelegatedAction(t *testing.T) {
	t.Parallel()
	verifier := Verifier{Keys: map[string][]byte{"test": []byte("secret")}, Issuer: "arbiter", Audience: "arbiter-capability"}
	req := request()
	req.Delegation = []schema.DelegationLink{{ParentSubject: "planner", DelegateSubject: "agent-1", MayDelegate: true}}
	base := Claims{GrantID: "grant-1", Subject: "agent-1", TenantID: "tenant-1", ServerIDs: []string{"payments"}, ToolNames: []string{"refund"}}
	if _, err := verifier.Verify(context.Background(), signedGrant(t, base), principal(), req); err != ErrInvalidGrant {
		t.Fatalf("expected non-delegable grant to fail, got %v", err)
	}
	base.MayDelegate = true
	if _, err := verifier.Verify(context.Background(), signedGrant(t, base), principal(), req); err != nil {
		t.Fatalf("expected delegable grant to pass, got %v", err)
	}
}

func TestRedisRevocationStore(t *testing.T) {
	t.Parallel()
	server, err := miniredis.Run()
	if err != nil {
		t.Fatalf("start redis: %v", err)
	}
	defer server.Close()
	store := NewRedisRevocationStore(redis.NewClient(&redis.Options{Addr: server.Addr()}), "test:capabilities")
	if err := store.Revoke(context.Background(), "grant-1", time.Now().Add(time.Minute)); err != nil {
		t.Fatalf("revoke: %v", err)
	}
	revoked, err := store.IsRevoked(context.Background(), "grant-1")
	if err != nil || !revoked {
		t.Fatalf("expected revoked grant, revoked=%t err=%v", revoked, err)
	}
}
