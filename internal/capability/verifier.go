// Package capability verifies scoped, short-lived authority grants. Grants
// narrow what an authenticated principal can attempt; they never override a
// Rego policy denial.
package capability

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"sync"
	"time"

	"arbiter/internal/schema"

	"github.com/golang-jwt/jwt/v5"
	"github.com/redis/go-redis/v9"
)

var (
	ErrInvalidGrant = errors.New("invalid capability grant")
	ErrRevoked      = errors.New("capability grant revoked")
)

type Claims struct {
	GrantID        string   `json:"grant_id"`
	TenantID       string   `json:"tenant_id"`
	Subject        string   `json:"subject"`
	ServerIDs      []string `json:"server_ids,omitempty"`
	ToolNames      []string `json:"tool_names,omitempty"`
	MaxAmountCents int64    `json:"max_amount_cents,omitempty"`
	MayDelegate    bool     `json:"may_delegate,omitempty"`
	WorkloadID     string   `json:"workload_id,omitempty"`
	jwt.RegisteredClaims
}

type RevocationStore interface {
	IsRevoked(context.Context, string) (bool, error)
	Revoke(context.Context, string, time.Time) error
}

type MemoryRevocationStore struct {
	mu      sync.Mutex
	revoked map[string]time.Time
}

// RedisRevocationStore provides shared revocation state for horizontally
// scaled gateways. Entries expire with their grant so revocation data does not
// grow without bound.
type RedisRevocationStore struct {
	client redis.UniversalClient
	prefix string
}

func NewRedisRevocationStore(client redis.UniversalClient, prefix string) *RedisRevocationStore {
	if prefix == "" {
		prefix = "arbiter:capability:revoked"
	}
	return &RedisRevocationStore{client: client, prefix: prefix}
}

func (s *RedisRevocationStore) IsRevoked(ctx context.Context, grantID string) (bool, error) {
	count, err := s.client.Exists(ctx, s.prefix+":"+grantID).Result()
	return count > 0, err
}

func (s *RedisRevocationStore) Revoke(ctx context.Context, grantID string, expiresAt time.Time) error {
	ttl := time.Until(expiresAt)
	if ttl <= 0 {
		return nil
	}
	return s.client.Set(ctx, s.prefix+":"+grantID, "revoked", ttl).Err()
}

func NewMemoryRevocationStore() *MemoryRevocationStore {
	return &MemoryRevocationStore{revoked: make(map[string]time.Time)}
}

func (s *MemoryRevocationStore) IsRevoked(_ context.Context, grantID string) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	expiresAt, found := s.revoked[grantID]
	if found && time.Now().After(expiresAt) {
		delete(s.revoked, grantID)
		return false, nil
	}
	return found, nil
}

func (s *MemoryRevocationStore) Revoke(_ context.Context, grantID string, expiresAt time.Time) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.revoked[grantID] = expiresAt
	return nil
}

type Verifier struct {
	Keys        map[string][]byte
	Issuer      string
	Audience    string
	Revocations RevocationStore
}

// Revoke records a grant ID in the configured shared revocation store until
// its natural expiry. The control plane can call this through a protected
// gateway management endpoint after it marks a grant revoked durably.
func (v Verifier) Revoke(ctx context.Context, grantID string, expiresAt time.Time) error {
	if strings.TrimSpace(grantID) == "" || v.Revocations == nil {
		return ErrInvalidGrant
	}
	return v.Revocations.Revoke(ctx, grantID, expiresAt)
}

func (v Verifier) Verify(ctx context.Context, raw string, principal schema.Principal, req schema.CanonicalRequest) (schema.Capability, error) {
	if strings.TrimSpace(raw) == "" || len(v.Keys) == 0 || v.Issuer == "" || v.Audience == "" {
		return schema.Capability{}, ErrInvalidGrant
	}
	parsed, err := jwt.ParseWithClaims(raw, &Claims{}, func(token *jwt.Token) (any, error) {
		if token.Method != jwt.SigningMethodHS256 {
			return nil, ErrInvalidGrant
		}
		keyID, _ := token.Header["kid"].(string)
		key, ok := v.Keys[keyID]
		if !ok || keyID == "" {
			return nil, ErrInvalidGrant
		}
		return key, nil
	}, jwt.WithIssuer(v.Issuer), jwt.WithAudience(v.Audience))
	if err != nil || !parsed.Valid {
		return schema.Capability{}, ErrInvalidGrant
	}
	claims, ok := parsed.Claims.(*Claims)
	if !ok || claims.GrantID == "" || claims.Subject != principal.Subject || claims.TenantID != principal.TenantID || (claims.WorkloadID != "" && claims.WorkloadID != principal.WorkloadID) {
		return schema.Capability{}, ErrInvalidGrant
	}
	if v.Revocations != nil {
		revoked, err := v.Revocations.IsRevoked(ctx, claims.GrantID)
		if err != nil {
			return schema.Capability{}, err
		}
		if revoked {
			return schema.Capability{}, ErrRevoked
		}
	}
	if !contains(claims.ServerIDs, req.TargetServerID()) || !contains(claims.ToolNames, req.ToolName) {
		return schema.Capability{}, ErrInvalidGrant
	}
	if len(req.Delegation) > 0 && !claims.MayDelegate {
		return schema.Capability{}, ErrInvalidGrant
	}
	if claims.MaxAmountCents > 0 && exceedsAmount(req.Parameters, claims.MaxAmountCents) {
		return schema.Capability{}, ErrInvalidGrant
	}
	return schema.Capability{
		GrantID: claims.GrantID, Subject: claims.Subject, TenantID: claims.TenantID,
		ServerIDs: append([]string(nil), claims.ServerIDs...), ToolNames: append([]string(nil), claims.ToolNames...),
		MaxAmountCents: claims.MaxAmountCents, MayDelegate: claims.MayDelegate,
		WorkloadID: claims.WorkloadID,
	}, nil
}

func contains(values []string, value string) bool {
	for _, candidate := range values {
		if candidate == value {
			return true
		}
	}
	return false
}

func exceedsAmount(parameters json.RawMessage, max int64) bool {
	var values map[string]any
	if err := json.Unmarshal(parameters, &values); err != nil {
		return true
	}
	raw, found := values["amount_cents"]
	if !found {
		return false
	}
	amount, ok := raw.(float64)
	return !ok || amount > float64(max)
}
