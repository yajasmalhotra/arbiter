package telemetry

import (
	"context"
	"testing"
)

func TestInitOTelDisabled(t *testing.T) {
	t.Parallel()

	shutdown, err := InitOTel(context.Background(), OTelConfig{Enabled: false})
	if err != nil {
		t.Fatalf("init otel disabled: %v", err)
	}
	if err := shutdown(context.Background()); err != nil {
		t.Fatalf("shutdown disabled otel: %v", err)
	}
}

func TestInitOTelEnabledMissingEndpoint(t *testing.T) {
	t.Parallel()

	_, err := InitOTel(context.Background(), OTelConfig{
		Enabled: true,
	})
	if err == nil {
		t.Fatal("expected endpoint validation error")
	}
}
