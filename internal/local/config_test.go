package local

import (
	"path/filepath"
	"testing"
)

func TestEnsureConfigCreatesAndLoads(t *testing.T) {
	t.Parallel()

	path := filepath.Join(t.TempDir(), "config.json")

	first, err := EnsureConfig(path)
	if err != nil {
		t.Fatalf("ensure config first run: %v", err)
	}
	if !first.Created {
		t.Fatalf("expected first ensure config to create a file")
	}
	if first.Config.BaseURL == "" || first.Config.TokenSecret == "" {
		t.Fatalf("expected defaults to be populated")
	}

	second, err := EnsureConfig(path)
	if err != nil {
		t.Fatalf("ensure config second run: %v", err)
	}
	if second.Created {
		t.Fatalf("expected second ensure config to load existing file")
	}
	if second.Config.TokenSecret != first.Config.TokenSecret {
		t.Fatalf("expected token secret to remain stable")
	}
}
