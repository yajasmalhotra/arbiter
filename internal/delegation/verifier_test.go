package delegation

import (
	"testing"
	"time"

	"arbiter/internal/schema"

	"github.com/golang-jwt/jwt/v5"
)

func signedLink(t *testing.T, claims Claims) string {
	t.Helper()
	claims.RegisteredClaims = jwt.RegisteredClaims{Issuer: "arbiter", Audience: jwt.ClaimStrings{"arbiter-delegation"}, ExpiresAt: jwt.NewNumericDate(time.Now().Add(time.Minute))}
	token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	token.Header["kid"] = "test"
	raw, err := token.SignedString([]byte("secret"))
	if err != nil {
		t.Fatalf("sign link: %v", err)
	}
	return raw
}

func TestVerifierAcceptsAttenuatingChain(t *testing.T) {
	t.Parallel()
	verifier := Verifier{Keys: map[string][]byte{"test": []byte("secret")}, Issuer: "arbiter", Audience: "arbiter-delegation", MaxDepth: 3}
	chain, err := verifier.Verify([]string{
		signedLink(t, Claims{ParentSubject: "agent:root", DelegateSubject: "agent:worker", TenantID: "tenant-1", MayDelegate: true}),
		signedLink(t, Claims{ParentSubject: "agent:worker", DelegateSubject: "agent:executor", TenantID: "tenant-1"}),
	}, schema.Principal{Subject: "agent:executor", TenantID: "tenant-1"})
	if err != nil {
		t.Fatalf("verify: %v", err)
	}
	if len(chain) != 2 || chain[1].DelegateSubject != "agent:executor" {
		t.Fatalf("unexpected chain: %#v", chain)
	}
}

func TestVerifierRejectsUndelegableIntermediateLink(t *testing.T) {
	t.Parallel()
	verifier := Verifier{Keys: map[string][]byte{"test": []byte("secret")}, Issuer: "arbiter", Audience: "arbiter-delegation"}
	_, err := verifier.Verify([]string{
		signedLink(t, Claims{ParentSubject: "agent:root", DelegateSubject: "agent:worker", TenantID: "tenant-1"}),
		signedLink(t, Claims{ParentSubject: "agent:worker", DelegateSubject: "agent:executor", TenantID: "tenant-1"}),
	}, schema.Principal{Subject: "agent:executor", TenantID: "tenant-1"})
	if err == nil {
		t.Fatal("expected undelegable chain to fail")
	}
}
