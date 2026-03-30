package executorauth

import (
	"context"
	"errors"
	"time"

	"arbiter/internal/schema"

	"github.com/golang-jwt/jwt/v5"
	"github.com/redis/go-redis/v9"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
)

var (
	ErrInvalidToken   = errors.New("invalid token")
	ErrReplayDetected = errors.New("token replay detected")
)

type ReplayCache interface {
	MarkUsed(ctx context.Context, jti string, ttl time.Duration) (bool, error)
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
	secret []byte
	issuer string
	ttl    time.Duration
	replay ReplayCache
	now    func() time.Time
}

func NewIssuerVerifier(secret []byte, issuer string, ttl time.Duration, replay ReplayCache) *IssuerVerifier {
	if ttl <= 0 {
		ttl = 2 * time.Minute
	}
	if replay == nil {
		replay = NewMemoryReplayCache()
	}
	return &IssuerVerifier{
		secret: secret,
		issuer: issuer,
		ttl:    ttl,
		replay: replay,
		now:    time.Now,
	}
}

func (i *IssuerVerifier) Issue(req schema.CanonicalRequest, decision schema.Decision) (string, error) {
	_, span := otel.Tracer("arbiter/executorauth").Start(context.Background(), "token.issue")
	span.SetAttributes(
		attribute.String("tool_name", req.ToolName),
		attribute.String("tenant_id", req.Metadata.TenantID),
		attribute.String("decision_id", decision.DecisionID),
	)
	defer span.End()

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

	token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	return token.SignedString(i.secret)
}

func (i *IssuerVerifier) Verify(ctx context.Context, token string, req schema.CanonicalRequest) (*Claims, error) {
	ctx, span := otel.Tracer("arbiter/executorauth").Start(ctx, "token.verify")
	span.SetAttributes(
		attribute.String("tool_name", req.ToolName),
		attribute.String("tenant_id", req.Metadata.TenantID),
	)
	defer span.End()

	parsedToken, err := jwt.ParseWithClaims(token, &Claims{}, func(parsedToken *jwt.Token) (any, error) {
		if parsedToken.Method != jwt.SigningMethodHS256 {
			return nil, ErrInvalidToken
		}
		return i.secret, nil
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
