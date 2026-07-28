package identity

import (
	"crypto/rand"
	"crypto/rsa"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

func TestJWTAuthenticatorBuildsAuthenticatedPrincipal(t *testing.T) {
	t.Parallel()
	claims := jwtClaims{TenantID: "tenant-1", Kind: "agent", WorkloadID: "workload-1", RegisteredClaims: jwt.RegisteredClaims{Subject: "agent-1", Issuer: "issuer", Audience: jwt.ClaimStrings{"arbiter"}, ExpiresAt: jwt.NewNumericDate(time.Now().Add(time.Minute))}}
	token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	raw, err := token.SignedString([]byte("secret"))
	if err != nil {
		t.Fatalf("sign: %v", err)
	}
	request := httptest.NewRequest("POST", "/mcp", nil)
	request.Header.Set("Authorization", "Bearer "+raw)
	principal, err := (JWTAuthenticator{Secret: []byte("secret"), Issuer: "issuer", Audience: "arbiter"}).Authenticate(request)
	if err != nil {
		t.Fatalf("authenticate: %v", err)
	}
	if principal.Subject != "agent-1" || principal.TenantID != "tenant-1" || principal.AuthMethod != "jwt" {
		t.Fatalf("unexpected principal: %#v", principal)
	}
}

func TestOIDCAuthenticatorFetchesAndCachesJWKS(t *testing.T) {
	t.Parallel()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatalf("generate key: %v", err)
	}
	exponent := key.PublicKey.E
	exponentBytes := []byte{byte(exponent >> 16), byte(exponent >> 8), byte(exponent)}
	for len(exponentBytes) > 1 && exponentBytes[0] == 0 {
		exponentBytes = exponentBytes[1:]
	}
	var requests int
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		requests++
		_ = json.NewEncoder(w).Encode(map[string]any{"keys": []map[string]string{{
			"kty": "RSA", "kid": "test", "n": base64.RawURLEncoding.EncodeToString(key.PublicKey.N.Bytes()), "e": base64.RawURLEncoding.EncodeToString(exponentBytes),
		}}})
	}))
	defer server.Close()

	claims := jwtClaims{TenantID: "tenant-1", Kind: "agent", RegisteredClaims: jwt.RegisteredClaims{Subject: "agent-1", Issuer: "issuer", Audience: jwt.ClaimStrings{"arbiter"}, ExpiresAt: jwt.NewNumericDate(time.Now().Add(time.Minute))}}
	token := jwt.NewWithClaims(jwt.SigningMethodRS256, claims)
	token.Header["kid"] = "test"
	raw, err := token.SignedString(key)
	if err != nil {
		t.Fatalf("sign: %v", err)
	}
	authenticator := &OIDCAuthenticator{Issuer: "issuer", Audience: "arbiter", JWKSURL: server.URL, CacheTTL: time.Minute}
	for range 2 {
		request := httptest.NewRequest("POST", "/mcp", nil)
		request.Header.Set("Authorization", "Bearer "+raw)
		principal, err := authenticator.Authenticate(request)
		if err != nil || principal.Subject != "agent-1" {
			t.Fatalf("authenticate principal=%#v err=%v", principal, err)
		}
	}
	if requests != 1 {
		t.Fatalf("expected cached JWKS, fetched %d times", requests)
	}
}
