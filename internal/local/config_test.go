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

func TestDefaultConfigPathHonorsExplicitOverride(t *testing.T) {
	override := filepath.Join(t.TempDir(), "custom.json")
	t.Setenv("ARBITER_LOCAL_CONFIG", override)
	path, err := DefaultConfigPath()
	if err != nil {
		t.Fatal(err)
	}
	if path != override {
		t.Fatalf("config path = %q, want %q", path, override)
	}
}
