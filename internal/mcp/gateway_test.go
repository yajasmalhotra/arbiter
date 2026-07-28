package mcp

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"arbiter/internal/enforcement"
	"arbiter/internal/executorauth"
	"arbiter/internal/pdp"
	"arbiter/internal/schema"
	"arbiter/internal/state"
)

type deciderFunc func(context.Context, schema.CanonicalRequest) (schema.Decision, error)

func (f deciderFunc) Decide(ctx context.Context, req schema.CanonicalRequest) (schema.Decision, error) {
	return f(ctx, req)
}

func testEngine(decider pdp.Decider) *enforcement.Engine {
	return enforcement.New(enforcement.Config{DecisionTimeout: time.Second}, state.NewMemoryStore(), decider,
		executorauth.NewIssuerVerifier([]byte("test-secret"), "arbiter", time.Minute, executorauth.NewMemoryReplayCache()), nil, nil)
}

func newGateway(t *testing.T, upstreamURL string, decider pdp.Decider) *Gateway {
	t.Helper()
	gateway, err := NewGateway(Config{UpstreamURL: upstreamURL, ServerID: "test-server", TenantID: "tenant-1", ActorID: "agent-1"}, testEngine(decider))
	if err != nil {
		t.Fatalf("new gateway: %v", err)
	}
	return gateway
}

func newRPCRequest(method string, params any) *http.Request {
	body, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": "call-1", "method": method, "params": params})
	return httptest.NewRequest(http.MethodPost, "/mcp", bytes.NewReader(body))
}

func TestGatewayFiltersToolDiscoveryWithPolicy(t *testing.T) {
	t.Parallel()
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"jsonrpc":"2.0","id":"call-1","result":{"tools":[{"name":"safe_tool"},{"name":"hidden_tool"}]}}`))
	}))
	defer upstream.Close()
	gateway := newGateway(t, upstream.URL, deciderFunc(func(_ context.Context, req schema.CanonicalRequest) (schema.Decision, error) {
		if req.Operation != "mcp.tools/list" {
			t.Fatalf("expected discovery operation, got %q", req.Operation)
		}
		return schema.Decision{Allow: req.ToolName == "safe_tool", DecisionID: req.Metadata.RequestID}, map[bool]error{true: nil, false: pdp.ErrDeniedByPolicy}[req.ToolName == "safe_tool"]
	}))

	recorder := httptest.NewRecorder()
	gateway.ServeHTTP(recorder, newRPCRequest(toolsListMethod, map[string]any{}))
	if recorder.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", recorder.Code, recorder.Body.String())
	}
	var response struct {
		Result struct {
			Tools []toolDescriptor `json:"tools"`
		} `json:"result"`
	}
	if err := json.NewDecoder(recorder.Body).Decode(&response); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if len(response.Result.Tools) != 1 || response.Result.Tools[0].Name != "safe_tool" {
		t.Fatalf("unexpected visible tools: %#v", response.Result.Tools)
	}
}

func TestGatewayDoesNotForwardDeniedToolCall(t *testing.T) {
	t.Parallel()
	var calls atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		calls.Add(1)
		_, _ = w.Write([]byte(`{"jsonrpc":"2.0","id":"call-1","result":{}}`))
	}))
	defer upstream.Close()
	gateway := newGateway(t, upstream.URL, deciderFunc(func(_ context.Context, req schema.CanonicalRequest) (schema.Decision, error) {
		return schema.Decision{Allow: false, DecisionID: req.Metadata.RequestID, Reason: "denied"}, pdp.ErrDeniedByPolicy
	}))

	recorder := httptest.NewRecorder()
	gateway.ServeHTTP(recorder, newRPCRequest(toolsCallMethod, map[string]any{"name": "delete_file", "arguments": map[string]any{"path": "/tmp/x"}}))
	if recorder.Code != http.StatusForbidden {
		t.Fatalf("expected 403, got %d: %s", recorder.Code, recorder.Body.String())
	}
	if calls.Load() != 0 {
		t.Fatalf("denied call reached upstream %d times", calls.Load())
	}
}

func TestGatewayConsumesPermitBeforeForwardingAllowedToolCall(t *testing.T) {
	t.Parallel()
	var calls atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		calls.Add(1)
		_, _ = w.Write([]byte(`{"jsonrpc":"2.0","id":"call-1","result":{"content":[{"type":"text","text":"ok"}]}}`))
	}))
	defer upstream.Close()
	gateway := newGateway(t, upstream.URL, deciderFunc(func(_ context.Context, req schema.CanonicalRequest) (schema.Decision, error) {
		if req.Protocol == nil || req.Protocol.Name != "mcp" || req.Target == nil || req.Target.ServerID != "test-server" {
			t.Fatalf("request was not MCP-bound: %#v", req)
		}
		return schema.Decision{Allow: true, DecisionID: req.Metadata.RequestID}, nil
	}))

	recorder := httptest.NewRecorder()
	gateway.ServeHTTP(recorder, newRPCRequest(toolsCallMethod, map[string]any{"name": "safe_tool", "arguments": map[string]any{"value": 1}}))
	if recorder.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", recorder.Code, recorder.Body.String())
	}
	if calls.Load() != 1 {
		t.Fatalf("expected one upstream call, got %d", calls.Load())
	}
}

func TestHTTPTransportAcceptsStreamableHTTPEventResponse(t *testing.T) {
	t.Parallel()
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = w.Write([]byte("event: message\ndata: {\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{}}\n\n"))
	}))
	defer upstream.Close()
	response, status, err := NewHTTPTransport(upstream.URL, time.Second, 4096).RoundTrip(context.Background(), []byte(`{"jsonrpc":"2.0","id":1,"method":"ping"}`))
	if err != nil {
		t.Fatalf("round trip: %v", err)
	}
	if status != http.StatusOK || string(response) != `{"jsonrpc":"2.0","id":1,"result":{}}` {
		t.Fatalf("unexpected response status=%d body=%q", status, response)
	}
}
