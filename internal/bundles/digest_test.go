package bundles

import "testing"

func TestSnapshotDigestStableAcrossMapOrder(t *testing.T) {
	t.Parallel()

	a := Snapshot{
		Policies: []PolicySnapshot{
			{
				ID:          "p1",
				Name:        "slack",
				PackageName: "arbiter.slack",
				Version:     "v1",
				Rules: map[string]any{
					"allowed_channels": []string{"ops", "security"},
				},
			},
		},
		Data: map[string]any{
			"max_refund_cents": 500000,
			"enabled":          true,
		},
	}

	b := Snapshot{
		Policies: []PolicySnapshot{
			{
				ID:          "p1",
				Name:        "slack",
				PackageName: "arbiter.slack",
				Version:     "v1",
				Rules: map[string]any{
					"allowed_channels": []string{"ops", "security"},
				},
			},
		},
		Data: map[string]any{
			"enabled":          true,
			"max_refund_cents": 500000,
		},
	}

	first, err := SnapshotDigest(a)
	if err != nil {
		t.Fatalf("digest a: %v", err)
	}
	second, err := SnapshotDigest(b)
	if err != nil {
		t.Fatalf("digest b: %v", err)
	}
	if first != second {
		t.Fatalf("expected deterministic digest, got %s != %s", first, second)
	}
}
