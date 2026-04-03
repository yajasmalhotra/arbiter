package local

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"arbiter/internal/schema"
	"arbiter/internal/state"

	"github.com/google/uuid"
	bolt "go.etcd.io/bbolt"
)

var (
	actionsBucket = []byte("actions")
	replayBucket  = []byte("replay")
)

type Store struct {
	db *bolt.DB
}

func OpenStore(path string) (*Store, error) {
	if path == "" {
		return nil, fmt.Errorf("local store path is required")
	}
	if err := ensureParentDir(path); err != nil {
		return nil, err
	}

	db, err := bolt.Open(path, 0o600, &bolt.Options{
		Timeout: 1 * time.Second,
	})
	if err != nil {
		return nil, fmt.Errorf("open local store: %w", err)
	}

	if err := db.Update(func(tx *bolt.Tx) error {
		if _, err := tx.CreateBucketIfNotExists(actionsBucket); err != nil {
			return err
		}
		if _, err := tx.CreateBucketIfNotExists(replayBucket); err != nil {
			return err
		}
		return nil
	}); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("initialize local store buckets: %w", err)
	}

	return &Store{db: db}, nil
}

func (s *Store) Close() error {
	if s == nil || s.db == nil {
		return nil
	}
	return s.db.Close()
}

func (s *Store) Ready(_ context.Context) error {
	return nil
}

func (s *Store) RecordAction(_ context.Context, record state.ActionRecord) error {
	if record.TenantID == "" || record.ActorID == "" {
		return state.ErrMissingLookupKey
	}
	if record.At.IsZero() {
		record.At = time.Now().UTC()
	}
	payload, err := json.Marshal(record.PreviousAction)
	if err != nil {
		return fmt.Errorf("encode action record: %w", err)
	}

	key := actionRecordKey(record.TenantID, record.ActorID, record.SessionID, record.At, uuid.NewString())
	return s.db.Update(func(tx *bolt.Tx) error {
		b := tx.Bucket(actionsBucket)
		return b.Put([]byte(key), payload)
	})
}

func (s *Store) RecentActions(_ context.Context, lookup state.LookupRequest) ([]schema.PreviousAction, error) {
	if lookup.TenantID == "" || lookup.ActorID == "" {
		return nil, state.ErrMissingLookupKey
	}

	limit := lookup.Limit
	if limit <= 0 {
		limit = 50
	}

	prefix := actionPrefix(lookup.TenantID, lookup.ActorID, lookup.SessionID)
	start := []byte(prefix + "|")

	actions := make([]schema.PreviousAction, 0, limit)
	err := s.db.View(func(tx *bolt.Tx) error {
		c := tx.Bucket(actionsBucket).Cursor()
		for key, value := c.Seek(start); key != nil && strings.HasPrefix(string(key), prefix+"|"); key, value = c.Next() {
			var action schema.PreviousAction
			if err := json.Unmarshal(value, &action); err != nil {
				return fmt.Errorf("decode action record: %w", err)
			}
			actions = append(actions, action)
			if len(actions) >= limit {
				break
			}
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return actions, nil
}

func (s *Store) MarkUsed(_ context.Context, jti string, ttl time.Duration) (bool, error) {
	if jti == "" {
		return false, fmt.Errorf("replay key is required")
	}
	now := time.Now()
	expiry := now.Add(ttl)

	var allowed bool
	err := s.db.Update(func(tx *bolt.Tx) error {
		b := tx.Bucket(replayBucket)
		value := b.Get([]byte(jti))
		if value != nil {
			existing, err := decodeUnixNano(value)
			if err == nil && now.UnixNano() <= existing {
				allowed = false
				return nil
			}
		}

		allowed = true
		payload := make([]byte, 8)
		binary.BigEndian.PutUint64(payload, uint64(expiry.UnixNano()))
		return b.Put([]byte(jti), payload)
	})
	return allowed, err
}

func ensureParentDir(path string) error {
	dir := filepath.Dir(path)
	if dir == "." || dir == "" {
		return nil
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return fmt.Errorf("create local store directory: %w", err)
	}
	return nil
}

func actionPrefix(tenantID, actorID, sessionID string) string {
	return tenantID + ":" + actorID + ":" + sessionID
}

func actionRecordKey(tenantID, actorID, sessionID string, at time.Time, suffix string) string {
	reverse := int64(math.MaxInt64 - at.UTC().UnixNano())
	return fmt.Sprintf("%s|%019d|%s", actionPrefix(tenantID, actorID, sessionID), reverse, suffix)
}

func decodeUnixNano(raw []byte) (int64, error) {
	if len(raw) == 8 {
		return int64(binary.BigEndian.Uint64(raw)), nil
	}
	return strconv.ParseInt(string(raw), 10, 64)
}
