package local

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"arbiter/internal/schema"
	"arbiter/internal/state"
)

func TestStoreActionsNewestFirst(t *testing.T) {
	t.Parallel()

	store, err := OpenStore(filepath.Join(t.TempDir(), "local.db"))
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	defer store.Close()

	older := time.Now().UTC().Add(-1 * time.Minute)
	newer := time.Now().UTC()

	if err := store.RecordAction(context.Background(), state.ActionRecord{
		TenantID: "tenant-1",
		ActorID:  "actor-1",
		PreviousAction: schema.PreviousAction{
			ToolName: "read",
			Outcome:  "allowed",
			At:       older,
		},
	}); err != nil {
		t.Fatalf("record older action: %v", err)
	}
	if err := store.RecordAction(context.Background(), state.ActionRecord{
		TenantID: "tenant-1",
		ActorID:  "actor-1",
		PreviousAction: schema.PreviousAction{
			ToolName: "exec",
			Outcome:  "allowed",
			At:       newer,
		},
	}); err != nil {
		t.Fatalf("record newer action: %v", err)
	}

	actions, err := store.RecentActions(context.Background(), state.LookupRequest{
		TenantID: "tenant-1",
		ActorID:  "actor-1",
		Limit:    10,
	})
	if err != nil {
		t.Fatalf("recent actions: %v", err)
	}
	if len(actions) != 2 {
		t.Fatalf("expected 2 actions, got %d", len(actions))
	}
	if actions[0].ToolName != "exec" || actions[1].ToolName != "read" {
		t.Fatalf("expected newest-first ordering, got %+v", actions)
	}
}

func TestStoreReplayCache(t *testing.T) {
	t.Parallel()

	store, err := OpenStore(filepath.Join(t.TempDir(), "local.db"))
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	defer store.Close()

	ok, err := store.MarkUsed(context.Background(), "jti-1", 20*time.Millisecond)
	if err != nil {
		t.Fatalf("mark used first: %v", err)
	}
	if !ok {
		t.Fatalf("expected first mark to pass")
	}

	ok, err = store.MarkUsed(context.Background(), "jti-1", 20*time.Millisecond)
	if err != nil {
		t.Fatalf("mark used second: %v", err)
	}
	if ok {
		t.Fatalf("expected second mark within ttl to fail")
	}

	time.Sleep(25 * time.Millisecond)
	ok, err = store.MarkUsed(context.Background(), "jti-1", 20*time.Millisecond)
	if err != nil {
		t.Fatalf("mark used after expiry: %v", err)
	}
	if !ok {
		t.Fatalf("expected mark to pass after expiry")
	}
}
