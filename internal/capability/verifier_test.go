package capability

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
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

func signedRS256Grant(t *testing.T, privateKey *rsa.PrivateKey, claims Claims) string {
	t.Helper()
	claims.RegisteredClaims = jwt.RegisteredClaims{Issuer: "arbiter", Audience: jwt.ClaimStrings{"arbiter-capability"}, ExpiresAt: jwt.NewNumericDate(time.Now().Add(time.Minute))}
	token := jwt.NewWithClaims(jwt.SigningMethodRS256, claims)
	token.Header["kid"] = "test-rs256"
	raw, err := token.SignedString(privateKey)
	if err != nil {
		t.Fatalf("sign RS256 grant: %v", err)
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

func TestVerifierAcceptsRS256GrantWithPublicKeyOnly(t *testing.T) {
	privateKey, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatalf("generate RSA key: %v", err)
	}
	verifier := Verifier{RS256Keys: map[string]*rsa.PublicKey{"test-rs256": &privateKey.PublicKey}, Issuer: "arbiter", Audience: "arbiter-capability"}
	raw := signedRS256Grant(t, privateKey, Claims{GrantID: "grant-rs256", Subject: "agent-1", TenantID: "tenant-1", ServerIDs: []string{"payments"}, ToolNames: []string{"refund"}})
	grant, err := verifier.Verify(context.Background(), raw, principal(), request())
	if err != nil {
		t.Fatalf("verify RS256 grant: %v", err)
	}
	if grant.GrantID != "grant-rs256" {
		t.Fatalf("unexpected grant: %#v", grant)
	}
}

func TestVerifierAcceptsControlPlaneRS256Grant(t *testing.T) {
	// This JWT was generated with Node's crypto.sign, the primitive used by the
	// control-plane signer. It protects the control-plane-to-Go gateway contract.
	publicKey, err := ParseRS256PublicKeyPEM([]byte(`-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAtQ5h4K+lrIhjTWRiBLZM
U8YeNeXEt8Ozny4kPea7u2UVj3uUIFmm4YOVz/mcYde9OwX1lX2vTdBPK7t+GxMA
UI++yEr91OTqwD0njX5W9V0vJtZBRny4dnvgVl8/4fPaUGXq1V2xSy8zwbe8wHi6
alue7VDlOkSbLF5/ouA86FMnTtef+X3Ig6P4d+1Ve5yhXShs/S/tNxCYSbZxq2Rh
yYaf5AY84/7y+SQpC20gSydnJZ1ULx6G4shxgz6QukLpUrxvoJCnRBgmc7b7s7Ut
M1CIF5U8DLdiJWAxB6ulWAYNfM/XQXRl4rPtLyc03ixkXXQi7tfVJ5JT+6uLSBdm
NwIDAQAB
-----END PUBLIC KEY-----`))
	if err != nil {
		t.Fatalf("parse control-plane public key: %v", err)
	}
	const token = "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCIsImtpZCI6ImNvbnRyb2wtcGxhbmUtcnMyNTYifQ.eyJncmFudF9pZCI6ImNvbnRyb2wtcGxhbmUtZ3JhbnQiLCJ0ZW5hbnRfaWQiOiJ0ZW5hbnQtMSIsInN1YmplY3QiOiJhZ2VudC0xIiwic2VydmVyX2lkcyI6WyJwYXltZW50cyJdLCJ0b29sX25hbWVzIjpbInJlZnVuZCJdLCJtYXlfZGVsZWdhdGUiOmZhbHNlLCJpc3MiOiJhcmJpdGVyIiwiYXVkIjoiYXJiaXRlci1jYXBhYmlsaXR5IiwiaWF0IjoxNzA0MDY3MjAwLCJuYmYiOjE3MDQwNjcyMDAsImV4cCI6NDA3MDkwODgwMCwianRpIjoiY2FwX2Nyb3NzX2xhbmd1YWdlIn0.EVBSQ5G31as43Xf_hUk2yPPMAAoVnYCKjc8BvfOaVLOVTxatKaqEOJZ7tzTi26JMJG69ZSL3m9_E50usALyQHpmNI_YpTy_u_j5EP2TAxwGBPdoTZ3gmzsHy-8rCHAqEfyoT2PXRj_M7PRThzTKnrix8LwCIeqTg9a2OyLR1rw3cjD8A9XtpoL8E4XEqOULQPu0cHyZAB9IB6ue6DkFcLB0R7W1Ow0ekMo0WQODSqYGfE9rRhEIdEcLwYgDPWnxEtncKJeL_BPCtI2xtfun_sRy-j9ay-i55LCBQm4wg_zSe8iZfbLodmvY81nWvKSExNDPPPK6fczjX8C0qDHWimw"
	verifier := Verifier{RS256Keys: map[string]*rsa.PublicKey{"control-plane-rs256": publicKey}, Issuer: "arbiter", Audience: "arbiter-capability"}
	grant, err := verifier.Verify(context.Background(), token, principal(), request())
	if err != nil {
		t.Fatalf("verify control-plane RS256 grant: %v", err)
	}
	if grant.GrantID != "control-plane-grant" {
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
