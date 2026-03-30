package state

import (
	"context"
	"testing"
	"time"

	"arbiter/internal/schema"
)

func TestMemoryStoreRecentActionsReturnsNewestFirst(t *testing.T) {
	t.Parallel()

	store := NewMemoryStore()
	ctx := context.Background()

	if err := store.RecordAction(ctx, ActionRecord{
		TenantID: "tenant-1",
		ActorID:  "actor-1",
		PreviousAction: schema.PreviousAction{
			ToolName: "send_slack_message",
			Outcome:  "allowed",
			At:       time.Unix(10, 0).UTC(),
		},
	}); err != nil {
		t.Fatalf("record first action: %v", err)
	}

	if err := store.RecordAction(ctx, ActionRecord{
		TenantID: "tenant-1",
		ActorID:  "actor-1",
		PreviousAction: schema.PreviousAction{
			ToolName: "backup_database",
			Outcome:  "allowed",
			At:       time.Unix(20, 0).UTC(),
		},
	}); err != nil {
		t.Fatalf("record second action: %v", err)
	}

	actions, err := store.RecentActions(ctx, LookupRequest{
		TenantID: "tenant-1",
		ActorID:  "actor-1",
		Limit:    2,
	})
	if err != nil {
		t.Fatalf("recent actions: %v", err)
	}

	if len(actions) != 2 {
		t.Fatalf("expected 2 actions, got %d", len(actions))
	}

	if actions[0].ToolName != "backup_database" {
		t.Fatalf("expected newest action first, got %s", actions[0].ToolName)
	}
}
