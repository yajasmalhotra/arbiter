// Package mcp implements Arbiter's MCP JSON-RPC enforcement gateway.
//
// The gateway is deliberately an MCP client-facing boundary rather than an
// MCP server SDK wrapper: it can govern existing remote servers without
// requiring them to adopt Arbiter-specific code.
package mcp

import (
	"bufio"
	"bytes"
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"arbiter/internal/approval"
	"arbiter/internal/capability"
	"arbiter/internal/delegation"
	"arbiter/internal/enforcement"
	"arbiter/internal/identity"
	"arbiter/internal/schema"

	"github.com/google/uuid"
)

const (
	jsonRPCVersion  = "2.0"
	toolsListMethod = "tools/list"
	toolsCallMethod = "tools/call"
)

type Config struct {
	UpstreamURL        string
	Transport          Transport
	ServerID           string
	ServerURI          string
	TenantID           string
	ActorID            string
	GatewaySharedKey   string
	MaxBodyBytes       int64
	Timeout            time.Duration
	Authenticator      identity.Authenticator
	DelegationVerifier *delegation.Verifier
	CapabilityVerifier *capability.Verifier
	RequireCapability  bool
	ApprovalVerifier   *approval.IssuerVerifier
}

type Gateway struct {
	config             Config
	engine             *enforcement.Engine
	transport          Transport
	authenticator      identity.Authenticator
	delegationVerifier *delegation.Verifier
	capabilityVerifier *capability.Verifier
	approvalVerifier   *approval.IssuerVerifier
}

// Transport carries one JSON-RPC message to an upstream MCP server. It allows
// HTTP and local stdio servers to share exactly the same enforcement gateway.
type Transport interface {
	RoundTrip(context.Context, []byte) ([]byte, int, error)
}

type HTTPTransport struct {
	url          string
	httpClient   *http.Client
	maxBodyBytes int64
}

func NewHTTPTransport(url string, timeout time.Duration, maxBodyBytes int64) *HTTPTransport {
	return &HTTPTransport{url: url, httpClient: &http.Client{Timeout: timeout}, maxBodyBytes: maxBodyBytes}
}

func (t *HTTPTransport) RoundTrip(ctx context.Context, body []byte) ([]byte, int, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, t.url, bytes.NewReader(body))
	if err != nil {
		return nil, http.StatusBadGateway, err
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Accept", "application/json, text/event-stream")
	response, err := t.httpClient.Do(request)
	if err != nil {
		return nil, http.StatusBadGateway, err
	}
	defer response.Body.Close()
	limited := io.LimitReader(response.Body, t.maxBodyBytes)
	responseBody, err := io.ReadAll(limited)
	if err != nil {
		return nil, http.StatusBadGateway, err
	}
	if response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices {
		return nil, response.StatusCode, fmt.Errorf("upstream status %d", response.StatusCode)
	}
	if strings.HasPrefix(response.Header.Get("Content-Type"), "text/event-stream") {
		responseBody, err = firstSSEJSON(responseBody)
		if err != nil {
			return nil, http.StatusBadGateway, err
		}
	}
	return responseBody, response.StatusCode, nil
}

func firstSSEJSON(body []byte) ([]byte, error) {
	scanner := bufio.NewScanner(bytes.NewReader(body))
	for scanner.Scan() {
		line := scanner.Text()
		if !strings.HasPrefix(line, "data:") {
			continue
		}
		candidate := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
		if json.Valid([]byte(candidate)) {
			return []byte(candidate), nil
		}
	}
	if err := scanner.Err(); err != nil {
		return nil, err
	}
	return nil, errors.New("MCP event stream did not contain a JSON-RPC response")
}

type rpcRequest struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params,omitempty"`
}

type rpcResponse struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Result  json.RawMessage `json:"result,omitempty"`
	Error   *rpcError       `json:"error,omitempty"`
}

type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
	Data    any    `json:"data,omitempty"`
}

type toolCallParams struct {
	Name      string          `json:"name"`
	Arguments json.RawMessage `json:"arguments,omitempty"`
}

type toolsListResult struct {
	Tools []json.RawMessage `json:"tools"`
}

type toolDescriptor struct {
	Name string `json:"name"`
}

func NewGateway(config Config, engine *enforcement.Engine) (*Gateway, error) {
	if engine == nil {
		return nil, errors.New("mcp gateway requires an enforcement engine")
	}
	config.UpstreamURL = strings.TrimSpace(config.UpstreamURL)
	if config.Transport == nil && config.UpstreamURL == "" {
		return nil, errors.New("mcp gateway upstream URL is required")
	}
	if config.ServerID == "" {
		config.ServerID = config.UpstreamURL
		if config.ServerID == "" {
			config.ServerID = "stdio"
		}
	}
	if config.ServerURI == "" {
		config.ServerURI = config.UpstreamURL
		if config.ServerURI == "" {
			config.ServerURI = "stdio"
		}
	}
	if config.TenantID == "" {
		config.TenantID = "default"
	}
	if config.ActorID == "" {
		config.ActorID = "mcp-client"
	}
	if config.MaxBodyBytes <= 0 {
		config.MaxBodyBytes = 1 << 20
	}
	if config.Timeout <= 0 {
		config.Timeout = 30 * time.Second
	}
	if config.Transport == nil {
		config.Transport = NewHTTPTransport(config.UpstreamURL, config.Timeout, config.MaxBodyBytes)
	}
	if config.Authenticator == nil {
		config.Authenticator = identity.StaticAuthenticator{Principal: schema.Principal{Subject: config.ActorID, TenantID: config.TenantID, Kind: "agent"}}
	}

	return &Gateway{
		config:             config,
		engine:             engine,
		transport:          config.Transport,
		authenticator:      config.Authenticator,
		delegationVerifier: config.DelegationVerifier,
		capabilityVerifier: config.CapabilityVerifier,
		approvalVerifier:   config.ApprovalVerifier,
	}, nil
}

func (g *Gateway) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", http.MethodPost)
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if !g.authorize(r) {
		writeRPCError(w, nil, http.StatusUnauthorized, -32001, "unauthorized", nil)
		return
	}
	principal, err := g.authenticator.Authenticate(r)
	if err != nil {
		writeRPCError(w, nil, http.StatusUnauthorized, -32001, "unauthenticated principal", nil)
		return
	}
	chain, err := g.verifyDelegation(r, principal)
	if err != nil {
		writeRPCError(w, nil, http.StatusForbidden, -32005, "invalid delegation chain", nil)
		return
	}
	capabilityToken := strings.TrimSpace(r.Header.Get("X-Arbiter-Capability"))
	approvalToken := strings.TrimSpace(r.Header.Get("X-Arbiter-Approval"))
	if g.config.RequireCapability && capabilityToken == "" {
		writeRPCError(w, nil, http.StatusForbidden, -32006, "capability grant required", nil)
		return
	}

	r.Body = http.MaxBytesReader(w, r.Body, g.config.MaxBodyBytes)
	body, err := io.ReadAll(r.Body)
	if err != nil {
		writeRPCError(w, nil, http.StatusBadRequest, -32700, "invalid request body", nil)
		return
	}
	var request rpcRequest
	if err := json.Unmarshal(body, &request); err != nil || request.JSONRPC != jsonRPCVersion || request.Method == "" {
		writeRPCError(w, request.ID, http.StatusBadRequest, -32600, "invalid JSON-RPC request", nil)
		return
	}

	switch request.Method {
	case toolsListMethod:
		g.handleToolsList(w, r.Context(), request, body, principal, chain, capabilityToken, approvalToken)
	case toolsCallMethod:
		g.handleToolsCall(w, r.Context(), request, body, principal, chain, capabilityToken, approvalToken)
	default:
		g.forward(w, r.Context(), request.ID, body)
	}
}

func (g *Gateway) handleToolsList(w http.ResponseWriter, ctx context.Context, request rpcRequest, body []byte, principal schema.Principal, chain []schema.DelegationLink, capabilityToken, approvalToken string) {
	response, status, err := g.upstream(ctx, body)
	if err != nil {
		writeRPCError(w, request.ID, status, -32002, "upstream MCP server unavailable", nil)
		return
	}
	var parsed rpcResponse
	if err := json.Unmarshal(response, &parsed); err != nil || parsed.Error != nil || len(parsed.Result) == 0 {
		writeRawJSON(w, status, response)
		return
	}

	var result toolsListResult
	if err := json.Unmarshal(parsed.Result, &result); err != nil {
		writeRawJSON(w, status, response)
		return
	}
	visible := make([]json.RawMessage, 0, len(result.Tools))
	for _, rawTool := range result.Tools {
		var tool toolDescriptor
		if err := json.Unmarshal(rawTool, &tool); err != nil || strings.TrimSpace(tool.Name) == "" {
			continue // malformed upstream descriptors are never exposed.
		}
		canonical := g.canonicalRequest(request.ID, tool.Name, []byte(`{}`), "mcp.tools/list", principal, chain)
		if err := g.applyApproval(ctx, approvalToken, principal, &canonical); err != nil {
			continue
		}
		if err := g.applyCapability(ctx, capabilityToken, principal, &canonical); err != nil {
			continue
		}
		decision, err := g.engine.Preview(ctx, canonical)
		if err == nil && decision.Allow {
			visible = append(visible, rawTool)
		}
	}
	result.Tools = visible
	encoded, err := json.Marshal(result)
	if err != nil {
		writeRPCError(w, request.ID, http.StatusInternalServerError, -32603, "failed to filter tools", nil)
		return
	}
	parsed.Result = encoded
	encoded, err = json.Marshal(parsed)
	if err != nil {
		writeRPCError(w, request.ID, http.StatusInternalServerError, -32603, "failed to encode tool list", nil)
		return
	}
	writeRawJSON(w, status, encoded)
}

func (g *Gateway) handleToolsCall(w http.ResponseWriter, ctx context.Context, request rpcRequest, body []byte, principal schema.Principal, chain []schema.DelegationLink, capabilityToken, approvalToken string) {
	var params toolCallParams
	if err := json.Unmarshal(request.Params, &params); err != nil || strings.TrimSpace(params.Name) == "" {
		writeRPCError(w, request.ID, http.StatusBadRequest, -32602, "tools/call requires a tool name", nil)
		return
	}
	if len(params.Arguments) == 0 {
		params.Arguments = []byte(`{}`)
	}
	var arguments any
	if err := json.Unmarshal(params.Arguments, &arguments); err != nil {
		writeRPCError(w, request.ID, http.StatusBadRequest, -32602, "tools/call arguments must be JSON", nil)
		return
	}

	canonical := g.canonicalRequest(request.ID, params.Name, params.Arguments, "mcp.tools/call", principal, chain)
	if err := g.applyApproval(ctx, approvalToken, principal, &canonical); err != nil {
		writeRPCError(w, request.ID, http.StatusForbidden, -32007, "approval receipt denied", nil)
		return
	}
	if err := g.applyCapability(ctx, capabilityToken, principal, &canonical); err != nil {
		writeRPCError(w, request.ID, http.StatusForbidden, -32006, "capability grant denied", nil)
		return
	}
	result, err := g.engine.Enforce(ctx, canonical)
	if err != nil {
		status := http.StatusServiceUnavailable
		message := "policy service unavailable"
		if enforcement.IsDenied(err) {
			status = http.StatusForbidden
			message = "tool call denied by policy"
		}
		writeRPCError(w, request.ID, status, -32003, message, result.Decision)
		return
	}
	if err := g.engine.Consume(ctx, result.Token, canonical); err != nil {
		writeRPCError(w, request.ID, http.StatusForbidden, -32004, "execution permit verification failed", nil)
		return
	}
	g.forward(w, ctx, request.ID, body)
}

func (g *Gateway) applyApproval(ctx context.Context, raw string, principal schema.Principal, request *schema.CanonicalRequest) error {
	if raw == "" {
		return nil
	}
	if g.approvalVerifier == nil {
		return approval.ErrInvalidReceipt
	}
	receipt, err := g.approvalVerifier.Verify(ctx, raw, *request, principal)
	if err != nil {
		return err
	}
	request.Approval = &receipt
	return nil
}

func (g *Gateway) applyCapability(ctx context.Context, raw string, principal schema.Principal, request *schema.CanonicalRequest) error {
	if g.capabilityVerifier == nil {
		if g.config.RequireCapability {
			return capability.ErrInvalidGrant
		}
		return nil
	}
	if raw == "" {
		return nil
	}
	grant, err := g.capabilityVerifier.Verify(ctx, raw, principal, *request)
	if err != nil {
		return err
	}
	request.Capability = &grant
	return nil
}

func (g *Gateway) canonicalRequest(id json.RawMessage, toolName string, arguments json.RawMessage, operation string, principal schema.Principal, chain []schema.DelegationLink) schema.CanonicalRequest {
	requestID := rpcRequestID(id)
	return schema.CanonicalRequest{
		SchemaVersion: schema.CurrentSchemaVersion,
		Metadata: schema.Metadata{
			RequestID: requestID,
			TenantID:  g.config.TenantID,
			Provider:  "mcp",
		},
		AgentContext: schema.AgentContext{Actor: schema.Actor{ID: principal.Subject, Type: principal.Kind}},
		ToolName:     strings.TrimSpace(toolName),
		Parameters:   arguments,
		Protocol:     &schema.Protocol{Name: "mcp"},
		Target:       &schema.Target{ServerID: g.config.ServerID, ServerURI: g.config.ServerURI},
		Operation:    operation,
		Principal:    &principal,
		Delegation:   chain,
	}
}

func (g *Gateway) verifyDelegation(request *http.Request, principal schema.Principal) ([]schema.DelegationLink, error) {
	raw := strings.TrimSpace(request.Header.Get("X-Arbiter-Delegation"))
	if raw == "" {
		return nil, nil
	}
	if g.delegationVerifier == nil {
		return nil, delegation.ErrInvalidChain
	}
	return g.delegationVerifier.Verify(strings.Split(raw, ","), principal)
}

func (g *Gateway) forward(w http.ResponseWriter, ctx context.Context, id json.RawMessage, body []byte) {
	response, status, err := g.upstream(ctx, body)
	if err != nil {
		writeRPCError(w, id, status, -32002, "upstream MCP server unavailable", nil)
		return
	}
	writeRawJSON(w, status, response)
}

func (g *Gateway) upstream(ctx context.Context, body []byte) ([]byte, int, error) {
	return g.transport.RoundTrip(ctx, body)
}

func (g *Gateway) authorize(request *http.Request) bool {
	if g.config.GatewaySharedKey == "" {
		return true
	}
	provided := request.Header.Get("X-Arbiter-Gateway-Key")
	return subtle.ConstantTimeCompare([]byte(provided), []byte(g.config.GatewaySharedKey)) == 1
}

func rpcRequestID(raw json.RawMessage) string {
	if len(raw) == 0 || string(raw) == "null" {
		return "mcp-" + uuid.NewString()
	}
	return "mcp-" + string(raw)
}

func writeRPCError(w http.ResponseWriter, id json.RawMessage, status, code int, message string, data any) {
	response := rpcResponse{JSONRPC: jsonRPCVersion, ID: id, Error: &rpcError{Code: code, Message: message, Data: data}}
	encoded, _ := json.Marshal(response)
	writeRawJSON(w, status, encoded)
}

func writeRawJSON(w http.ResponseWriter, status int, body []byte) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_, _ = w.Write(body)
}
