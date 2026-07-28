// Package identity authenticates the workload that calls Arbiter. It keeps
// authenticated principals separate from untrusted provider envelope fields.
package identity

import (
	"context"
	"crypto/rsa"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"math/big"
	"net/http"
	"strings"
	"sync"
	"time"

	"arbiter/internal/schema"

	"github.com/golang-jwt/jwt/v5"
)

var ErrUnauthenticated = errors.New("unauthenticated principal")

type Authenticator interface {
	Authenticate(*http.Request) (schema.Principal, error)
}

type StaticAuthenticator struct {
	Principal schema.Principal
}

func (a StaticAuthenticator) Authenticate(_ *http.Request) (schema.Principal, error) {
	if strings.TrimSpace(a.Principal.Subject) == "" || strings.TrimSpace(a.Principal.TenantID) == "" {
		return schema.Principal{}, ErrUnauthenticated
	}
	if a.Principal.AuthMethod == "" {
		a.Principal.AuthMethod = "static"
	}
	return a.Principal, nil
}

// JWTAuthenticator validates a workload JWT with a deployment-provided key.
// It supports HS256 for local and managed deployments; OIDC key discovery can
// supply an equivalent verifier through the Authenticator interface.
type JWTAuthenticator struct {
	Secret   []byte
	Issuer   string
	Audience string
}

// OIDCAuthenticator validates RS256 workload JWTs against an issuer JWKS. It
// caches verified public keys to keep network activity out of the steady-state
// authorization path; cache misses use the request context and fail closed.
type OIDCAuthenticator struct {
	Issuer   string
	Audience string
	JWKSURL  string
	Client   *http.Client
	CacheTTL time.Duration

	mu        sync.Mutex
	keys      map[string]*rsa.PublicKey
	expiresAt time.Time
}

func (a *OIDCAuthenticator) Authenticate(request *http.Request) (schema.Principal, error) {
	raw, ok := bearerToken(request.Header.Get("Authorization"))
	if !ok || a == nil || a.Issuer == "" || a.Audience == "" || a.JWKSURL == "" {
		return schema.Principal{}, ErrUnauthenticated
	}
	claims := &jwtClaims{}
	parsed, err := jwt.ParseWithClaims(raw, claims, func(token *jwt.Token) (any, error) {
		if token.Method != jwt.SigningMethodRS256 {
			return nil, ErrUnauthenticated
		}
		keyID, _ := token.Header["kid"].(string)
		return a.key(request.Context(), keyID)
	}, jwt.WithIssuer(a.Issuer), jwt.WithAudience(a.Audience))
	if err != nil || !parsed.Valid || strings.TrimSpace(claims.Subject) == "" || strings.TrimSpace(claims.TenantID) == "" {
		return schema.Principal{}, ErrUnauthenticated
	}
	return schema.Principal{Subject: claims.Subject, TenantID: claims.TenantID, Kind: claims.Kind, Issuer: a.Issuer, AuthMethod: "oidc", WorkloadID: claims.WorkloadID, HumanOwner: claims.HumanOwner}, nil
}

func (a *OIDCAuthenticator) key(ctx context.Context, keyID string) (*rsa.PublicKey, error) {
	if keyID == "" {
		return nil, ErrUnauthenticated
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if time.Now().Before(a.expiresAt) {
		if key := a.keys[keyID]; key != nil {
			return key, nil
		}
	}
	if err := a.refresh(ctx); err != nil {
		return nil, err
	}
	key := a.keys[keyID]
	if key == nil {
		return nil, ErrUnauthenticated
	}
	return key, nil
}

func (a *OIDCAuthenticator) refresh(ctx context.Context) error {
	client := a.Client
	if client == nil {
		client = &http.Client{Timeout: 2 * time.Second}
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, a.JWKSURL, nil)
	if err != nil {
		return err
	}
	response, err := client.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return ErrUnauthenticated
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	if err != nil {
		return err
	}
	var document struct {
		Keys []struct {
			KTY string `json:"kty"`
			KID string `json:"kid"`
			N   string `json:"n"`
			E   string `json:"e"`
		} `json:"keys"`
	}
	if err := json.Unmarshal(body, &document); err != nil {
		return err
	}
	keys := make(map[string]*rsa.PublicKey, len(document.Keys))
	for _, raw := range document.Keys {
		if raw.KTY != "RSA" || raw.KID == "" || raw.N == "" || raw.E == "" {
			continue
		}
		modulus, err := base64.RawURLEncoding.DecodeString(raw.N)
		if err != nil {
			continue
		}
		exponentBytes, err := base64.RawURLEncoding.DecodeString(raw.E)
		if err != nil || len(exponentBytes) == 0 {
			continue
		}
		exponent := 0
		for _, b := range exponentBytes {
			exponent = exponent<<8 | int(b)
		}
		if exponent < 3 {
			continue
		}
		keys[raw.KID] = &rsa.PublicKey{N: new(big.Int).SetBytes(modulus), E: exponent}
	}
	if len(keys) == 0 {
		return ErrUnauthenticated
	}
	ttl := a.CacheTTL
	if ttl <= 0 {
		ttl = 5 * time.Minute
	}
	a.keys = keys
	a.expiresAt = time.Now().Add(ttl)
	return nil
}

type jwtClaims struct {
	TenantID   string `json:"tenant_id"`
	Kind       string `json:"kind"`
	WorkloadID string `json:"workload_id"`
	HumanOwner string `json:"human_owner"`
	jwt.RegisteredClaims
}

func (a JWTAuthenticator) Authenticate(request *http.Request) (schema.Principal, error) {
	raw, ok := bearerToken(request.Header.Get("Authorization"))
	if !ok || len(a.Secret) == 0 || a.Issuer == "" || a.Audience == "" {
		return schema.Principal{}, ErrUnauthenticated
	}
	parsed, err := jwt.ParseWithClaims(raw, &jwtClaims{}, func(token *jwt.Token) (any, error) {
		if token.Method != jwt.SigningMethodHS256 {
			return nil, ErrUnauthenticated
		}
		return a.Secret, nil
	}, jwt.WithIssuer(a.Issuer), jwt.WithAudience(a.Audience))
	if err != nil || !parsed.Valid {
		return schema.Principal{}, ErrUnauthenticated
	}
	claims, ok := parsed.Claims.(*jwtClaims)
	if !ok || strings.TrimSpace(claims.Subject) == "" || strings.TrimSpace(claims.TenantID) == "" {
		return schema.Principal{}, ErrUnauthenticated
	}
	return schema.Principal{
		Subject:    claims.Subject,
		TenantID:   claims.TenantID,
		Kind:       claims.Kind,
		Issuer:     a.Issuer,
		AuthMethod: "jwt",
		WorkloadID: claims.WorkloadID,
		HumanOwner: claims.HumanOwner,
	}, nil
}

func bearerToken(header string) (string, bool) {
	const prefix = "Bearer "
	if !strings.HasPrefix(header, prefix) {
		return "", false
	}
	token := strings.TrimSpace(strings.TrimPrefix(header, prefix))
	return token, token != ""
}

// MTLSAuthenticator derives a workload principal from a verified peer
// certificate URI SAN (preferably a SPIFFE URI). TLS client authentication
// must be enforced by the HTTP server before this authenticator is used.
type MTLSAuthenticator struct {
	TenantID    string
	TrustDomain string
}

func (a MTLSAuthenticator) Authenticate(request *http.Request) (schema.Principal, error) {
	if request.TLS == nil || len(request.TLS.VerifiedChains) == 0 {
		return schema.Principal{}, ErrUnauthenticated
	}
	certificate := firstCertificate(request.TLS.VerifiedChains)
	if certificate == nil {
		return schema.Principal{}, ErrUnauthenticated
	}
	for _, uri := range certificate.URIs {
		if uri == nil || uri.String() == "" {
			continue
		}
		if a.TrustDomain != "" && uri.Host != a.TrustDomain {
			continue
		}
		if a.TenantID == "" {
			return schema.Principal{}, ErrUnauthenticated
		}
		return schema.Principal{Subject: uri.String(), TenantID: a.TenantID, Kind: "workload", Issuer: uri.Host, AuthMethod: "mtls", WorkloadID: uri.String()}, nil
	}
	return schema.Principal{}, ErrUnauthenticated
}

func firstCertificate(chains [][]*x509.Certificate) *x509.Certificate {
	if len(chains) == 0 || len(chains[0]) == 0 {
		return nil
	}
	return chains[0][0]
}
