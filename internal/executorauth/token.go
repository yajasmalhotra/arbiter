package executorauth

import (
	"context"
	"crypto/rsa"
	"crypto/x509"
	"encoding/pem"
	"errors"
	"strings"
	"time"

	"arbiter/internal/schema"

	"github.com/golang-jwt/jwt/v5"
	"github.com/redis/go-redis/v9"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
)

var (
	ErrInvalidToken    = errors.New("invalid token")
	ErrReplayDetected  = errors.New("token replay detected")
	ErrMissingKeyID    = errors.New("missing signing key id")
	ErrInvalidDecision = errors.New("invalid permit decision")
)

type ReplayCache interface {
	MarkUsed(ctx context.Context, jti string, ttl time.Duration) (bool, error)
}

type replayReadyChecker interface {
	Ready(context.Context) error
}

type MemoryReplayCache struct {
	now   func() time.Time
	used  map[string]time.Time
	mutex chan struct{}
}

func NewMemoryReplayCache() *MemoryReplayCache {
	cache := &MemoryReplayCache{
		now:   time.Now,
		used:  make(map[string]time.Time),
		mutex: make(chan struct{}, 1),
	}
	cache.mutex <- struct{}{}
	return cache
}

func (c *MemoryReplayCache) MarkUsed(_ context.Context, jti string, ttl time.Duration) (bool, error) {
	<-c.mutex
	defer func() { c.mutex <- struct{}{} }()

	now := c.now()
	for key, expiry := range c.used {
		if now.After(expiry) {
			delete(c.used, key)
		}
	}

	if _, exists := c.used[jti]; exists {
		return false, nil
	}

	c.used[jti] = now.Add(ttl)
	return true, nil
}

func (c *MemoryReplayCache) Ready(_ context.Context) error { return nil }

type RedisReplayCache struct {
	client redis.UniversalClient
	prefix string
}

func NewRedisReplayCache(client redis.UniversalClient, prefix string) *RedisReplayCache {
	if prefix == "" {
		prefix = "arbiter:replay"
	}
	return &RedisReplayCache{client: client, prefix: prefix}
}

func (c *RedisReplayCache) MarkUsed(ctx context.Context, jti string, ttl time.Duration) (bool, error) {
	return c.client.SetNX(ctx, c.prefix+":"+jti, "used", ttl).Result()
}

func (c *RedisReplayCache) Ready(ctx context.Context) error {
	if c == nil || c.client == nil {
		return errors.New("replay cache is not configured")
	}
	return c.client.Ping(ctx).Err()
}

type Claims struct {
	RequestHash   string `json:"request_hash"`
	TenantID      string `json:"tenant_id"`
	ActorID       string `json:"actor_id"`
	ToolName      string `json:"tool_name"`
	PolicyVersion string `json:"policy_version"`
	DecisionID    string `json:"decision_id"`
	jwt.RegisteredClaims
}

type IssuerVerifier struct {
	activeKeyID string
	hmacKeys    map[string][]byte
	rsaPrivate  map[string]*rsa.PrivateKey
	rsaPublic   map[string]*rsa.PublicKey
	issuer      string
	ttl         time.Duration
	replay      ReplayCache
	now         func() time.Time
}

func NewIssuerVerifier(secret []byte, issuer string, ttl time.Duration, replay ReplayCache) *IssuerVerifier {
	return NewIssuerVerifierWithKeys(map[string][]byte{"default": secret}, "default", issuer, ttl, replay)
}

func NewIssuerVerifierWithKeys(keys map[string][]byte, activeKeyID, issuer string, ttl time.Duration, replay ReplayCache) *IssuerVerifier {
	if ttl <= 0 {
		ttl = 2 * time.Minute
	}
	if replay == nil {
		replay = NewMemoryReplayCache()
	}
	if activeKeyID == "" {
		activeKeyID = "default"
	}
	normalizedKeys := make(map[string][]byte, len(keys))
	for keyID, secret := range keys {
		if keyID == "" || len(secret) == 0 {
			continue
		}
		normalizedKeys[keyID] = secret
	}
	if len(normalizedKeys) == 0 {
		normalizedKeys["default"] = []byte("dev-secret-change-me")
		activeKeyID = "default"
	}
	if _, ok := normalizedKeys[activeKeyID]; !ok {
		for keyID := range normalizedKeys {
			activeKeyID = keyID
			break
		}
	}

	return &IssuerVerifier{
		activeKeyID: activeKeyID,
		hmacKeys:    normalizedKeys,
		issuer:      issuer,
		ttl:         ttl,
		replay:      replay,
		now:         time.Now,
	}
}

// NewIssuerVerifierWithRS256PrivateKeys signs execution permits with the
// active RSA private key and verifies them with the corresponding public key.
// Give executors the public keys through NewVerifierWithRS256PublicKeys so
// they never need the permit-signing private material.
func NewIssuerVerifierWithRS256PrivateKeys(keys map[string]*rsa.PrivateKey, activeKeyID, issuer string, ttl time.Duration, replay ReplayCache) *IssuerVerifier {
	privateKeys := make(map[string]*rsa.PrivateKey, len(keys))
	publicKeys := make(map[string]*rsa.PublicKey, len(keys))
	for keyID, key := range keys {
		if keyID == "" || key == nil || !validRS256PublicKey(&key.PublicKey) {
			continue
		}
		privateKeys[keyID] = key
		publicKeys[keyID] = &key.PublicKey
	}
	return newRS256IssuerVerifier(privateKeys, publicKeys, activeKeyID, issuer, ttl, replay)
}

// NewVerifierWithRS256PublicKeys verifies RS256 execution permits without any
// signing capability. Calling Issue on the returned value fails closed.
func NewVerifierWithRS256PublicKeys(keys map[string]*rsa.PublicKey, issuer string, replay ReplayCache) *IssuerVerifier {
	publicKeys := make(map[string]*rsa.PublicKey, len(keys))
	for keyID, key := range keys {
		if keyID == "" || !validRS256PublicKey(key) {
			continue
		}
		publicKeys[keyID] = key
	}
	return newRS256IssuerVerifier(nil, publicKeys, "", issuer, 2*time.Minute, replay)
}

func validRS256PublicKey(key *rsa.PublicKey) bool {
	return key != nil && key.N != nil && key.N.BitLen() >= 2048 && key.E >= 3 && key.E%2 == 1
}

func newRS256IssuerVerifier(privateKeys map[string]*rsa.PrivateKey, publicKeys map[string]*rsa.PublicKey, activeKeyID, issuer string, ttl time.Duration, replay ReplayCache) *IssuerVerifier {
	if ttl <= 0 {
		ttl = 2 * time.Minute
	}
	if replay == nil {
		replay = NewMemoryReplayCache()
	}
	if activeKeyID == "" {
		for keyID := range privateKeys {
			activeKeyID = keyID
			break
		}
	}
	return &IssuerVerifier{
		activeKeyID: activeKeyID,
		rsaPrivate:  privateKeys,
		rsaPublic:   publicKeys,
		issuer:      issuer,
		ttl:         ttl,
		replay:      replay,
		now:         time.Now,
	}
}

// Ready verifies the shared replay backend when it exposes a health check.
// In-memory replay remains usable for local development; production wiring
// supplies Redis and therefore makes readiness dependency-aware.
func (i *IssuerVerifier) Ready(ctx context.Context) error {
	if i == nil || i.replay == nil {
		return errors.New("permit replay cache is not configured")
	}
	if checker, ok := i.replay.(replayReadyChecker); ok {
		return checker.Ready(ctx)
	}
	return nil
}

// ParseRS256PrivateKeyPEM accepts standard PKCS#1 and PKCS#8 RSA private-key
// PEM encodings used by secret managers and workload mounts.
func ParseRS256PrivateKeyPEM(raw []byte) (*rsa.PrivateKey, error) {
	block, _ := pem.Decode(raw)
	if block == nil {
		return nil, ErrInvalidToken
	}
	if key, err := x509.ParsePKCS1PrivateKey(block.Bytes); err == nil {
		if !validRS256PublicKey(&key.PublicKey) {
			return nil, ErrInvalidToken
		}
		return key, nil
	}
	key, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	if err != nil {
		return nil, ErrInvalidToken
	}
	rsaKey, ok := key.(*rsa.PrivateKey)
	if !ok {
		return nil, ErrInvalidToken
	}
	if !validRS256PublicKey(&rsaKey.PublicKey) {
		return nil, ErrInvalidToken
	}
	return rsaKey, nil
}

func (i *IssuerVerifier) Issue(req schema.CanonicalRequest, decision schema.Decision) (string, error) {
	_, span := otel.Tracer("arbiter/executorauth").Start(context.Background(), "token.issue")
	span.SetAttributes(
		attribute.String("tool_name", req.ToolName),
		attribute.String("tenant_id", req.Metadata.TenantID),
		attribute.String("decision_id", decision.DecisionID),
	)
	defer span.End()
	if !decision.Allow || strings.TrimSpace(decision.DecisionID) == "" {
		span.RecordError(ErrInvalidDecision)
		return "", ErrInvalidDecision
	}

	requestHash, err := req.Hash()
	if err != nil {
		span.RecordError(err)
		return "", err
	}

	now := i.now()
	claims := Claims{
		RequestHash:   requestHash,
		TenantID:      req.Metadata.TenantID,
		ActorID:       req.AgentContext.Actor.ID,
		ToolName:      req.ToolName,
		PolicyVersion: decision.PolicyVersion,
		DecisionID:    decision.DecisionID,
		RegisteredClaims: jwt.RegisteredClaims{
			ID:        decision.DecisionID,
			Issuer:    i.issuer,
			IssuedAt:  jwt.NewNumericDate(now),
			NotBefore: jwt.NewNumericDate(now),
			ExpiresAt: jwt.NewNumericDate(now.Add(i.ttl)),
			Subject:   req.AgentContext.Actor.ID,
			Audience:  jwt.ClaimStrings{"arbiter-tool-execution"},
		},
	}

	var method jwt.SigningMethod = jwt.SigningMethodHS256
	var signingKey any
	if privateKey := i.rsaPrivate[i.activeKeyID]; privateKey != nil {
		method = jwt.SigningMethodRS256
		signingKey = privateKey
	} else if secret := i.hmacKeys[i.activeKeyID]; len(secret) > 0 {
		signingKey = secret
	} else {
		return "", ErrInvalidToken
	}
	token := jwt.NewWithClaims(method, claims)
	token.Header["kid"] = i.activeKeyID
	return token.SignedString(signingKey)
}

func (i *IssuerVerifier) Verify(ctx context.Context, token string, req schema.CanonicalRequest) (*Claims, error) {
	ctx, span := otel.Tracer("arbiter/executorauth").Start(ctx, "token.verify")
	span.SetAttributes(
		attribute.String("tool_name", req.ToolName),
		attribute.String("tenant_id", req.Metadata.TenantID),
	)
	defer span.End()

	parsedToken, err := jwt.ParseWithClaims(token, &Claims{}, func(parsedToken *jwt.Token) (any, error) {
		keyID, _ := parsedToken.Header["kid"].(string)
		if keyID == "" {
			return nil, ErrMissingKeyID
		}
		if parsedToken.Method == jwt.SigningMethodHS256 {
			secret := i.hmacKeys[keyID]
			if len(secret) == 0 {
				return nil, ErrInvalidToken
			}
			return secret, nil
		}
		if parsedToken.Method == jwt.SigningMethodRS256 {
			publicKey := i.rsaPublic[keyID]
			if publicKey == nil {
				return nil, ErrInvalidToken
			}
			return publicKey, nil
		}
		return nil, ErrInvalidToken
	}, jwt.WithIssuer(i.issuer), jwt.WithAudience("arbiter-tool-execution"))
	if err != nil {
		span.RecordError(err)
		return nil, ErrInvalidToken
	}

	claims, ok := parsedToken.Claims.(*Claims)
	if !ok || !parsedToken.Valid {
		span.RecordError(ErrInvalidToken)
		return nil, ErrInvalidToken
	}

	requestHash, err := req.Hash()
	if err != nil {
		span.RecordError(err)
		return nil, err
	}

	if claims.RequestHash != requestHash || claims.TenantID != req.Metadata.TenantID || claims.ActorID != req.AgentContext.Actor.ID || claims.ToolName != req.ToolName {
		span.RecordError(ErrInvalidToken)
		return nil, ErrInvalidToken
	}

	ttl := time.Until(claims.ExpiresAt.Time)
	if ttl <= 0 {
		span.RecordError(ErrInvalidToken)
		return nil, ErrInvalidToken
	}

	ok, err = i.replay.MarkUsed(ctx, claims.ID, ttl)
	if err != nil {
		span.RecordError(err)
		return nil, err
	}
	if !ok {
		span.RecordError(ErrReplayDetected)
		return nil, ErrReplayDetected
	}

	return claims, nil
}
