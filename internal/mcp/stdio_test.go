package mcp

import (
	"context"
	"testing"
)

func TestStdioTransportRoundTrip(t *testing.T) {
	transport, err := NewStdioTransport(context.Background(), "/bin/sh", "-c", "while IFS= read -r line; do printf '%s\\n' \"$line\"; done")
	if err != nil {
		t.Fatalf("new transport: %v", err)
	}
	defer func() { _ = transport.Close() }()

	response, status, err := transport.RoundTrip(context.Background(), []byte(`{"jsonrpc":"2.0","id":1,"method":"ping"}`))
	if err != nil {
		t.Fatalf("round trip: %v", err)
	}
	if status != 200 || string(response) != "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"ping\"}\n" {
		t.Fatalf("unexpected response status=%d body=%q", status, response)
	}
}
