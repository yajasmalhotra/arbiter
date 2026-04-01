package state

import (
	"context"
	"encoding/json"
	"errors"
	"sort"
	"sync"
	"time"

	"arbiter/internal/schema"

	"github.com/redis/go-redis/v9"
)

var ErrMissingLookupKey = errors.New("missing tenant or actor identifier")

type LookupRequest struct {
	TenantID  string
	ActorID   string
	SessionID string
	Limit     int
}

type ActionRecord struct {
	TenantID  string `json:"tenant_id"`
	ActorID   string `json:"actor_id"`
	SessionID string `json:"session_id,omitempty"`
	schema.PreviousAction
}

type Store interface {
	RecordAction(ctx context.Context, record ActionRecord) error
	RecentActions(ctx context.Context, lookup LookupRequest) ([]schema.PreviousAction, error)
}

type MemoryStore struct {
	mu      sync.RWMutex
	records map[string][]schema.PreviousAction
}

func NewMemoryStore() *MemoryStore {
	return &MemoryStore{records: make(map[string][]schema.PreviousAction)}
}

func (s *MemoryStore) Ready(_ context.Context) error {
	return nil
}

func (s *MemoryStore) RecordAction(_ context.Context, record ActionRecord) error {
	if record.TenantID == "" || record.ActorID == "" {
		return ErrMissingLookupKey
	}
	if record.At.IsZero() {
		record.At = time.Now().UTC()
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	key := stateKey(record.TenantID, record.ActorID, record.SessionID)
	s.records[key] = append(s.records[key], record.PreviousAction)
	return nil
}

func (s *MemoryStore) RecentActions(_ context.Context, lookup LookupRequest) ([]schema.PreviousAction, error) {
	if lookup.TenantID == "" || lookup.ActorID == "" {
		return nil, ErrMissingLookupKey
	}

	s.mu.RLock()
	defer s.mu.RUnlock()

	key := stateKey(lookup.TenantID, lookup.ActorID, lookup.SessionID)
	actions := append([]schema.PreviousAction(nil), s.records[key]...)
	sort.Slice(actions, func(i, j int) bool {
		return actions[i].At.After(actions[j].At)
	})

	if lookup.Limit > 0 && len(actions) > lookup.Limit {
		actions = actions[:lookup.Limit]
	}

	return actions, nil
}

type RedisStore struct {
	client redis.UniversalClient
	prefix string
	limit  int64
}

func NewRedisStore(client redis.UniversalClient, prefix string, limit int64) *RedisStore {
	if prefix == "" {
		prefix = "arbiter:actions"
	}
	if limit <= 0 {
		limit = 50
	}
	return &RedisStore{client: client, prefix: prefix, limit: limit}
}

func (s *RedisStore) Ready(ctx context.Context) error {
	return s.client.Ping(ctx).Err()
}

func (s *RedisStore) RecordAction(ctx context.Context, record ActionRecord) error {
	if record.TenantID == "" || record.ActorID == "" {
		return ErrMissingLookupKey
	}
	if record.At.IsZero() {
		record.At = time.Now().UTC()
	}

	payload, err := json.Marshal(record.PreviousAction)
	if err != nil {
		return err
	}

	key := s.redisKey(record.TenantID, record.ActorID, record.SessionID)
	pipe := s.client.TxPipeline()
	pipe.LPush(ctx, key, payload)
	pipe.LTrim(ctx, key, 0, s.limit-1)
	_, err = pipe.Exec(ctx)
	return err
}

func (s *RedisStore) RecentActions(ctx context.Context, lookup LookupRequest) ([]schema.PreviousAction, error) {
	if lookup.TenantID == "" || lookup.ActorID == "" {
		return nil, ErrMissingLookupKey
	}

	limit := int64(lookup.Limit)
	if limit <= 0 {
		limit = s.limit
	}

	values, err := s.client.LRange(ctx, s.redisKey(lookup.TenantID, lookup.ActorID, lookup.SessionID), 0, limit-1).Result()
	if err != nil {
		return nil, err
	}

	actions := make([]schema.PreviousAction, 0, len(values))
	for _, value := range values {
		var action schema.PreviousAction
		if err := json.Unmarshal([]byte(value), &action); err != nil {
			return nil, err
		}
		actions = append(actions, action)
	}
	return actions, nil
}

func (s *RedisStore) redisKey(tenantID, actorID, sessionID string) string {
	return s.prefix + ":" + stateKey(tenantID, actorID, sessionID)
}

func stateKey(tenantID, actorID, sessionID string) string {
	return tenantID + ":" + actorID + ":" + sessionID
}
