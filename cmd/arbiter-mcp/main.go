// arbiter-mcp is an MCP JSON-RPC gateway that applies Arbiter policy before
// forwarding tool discovery and invocation traffic to an upstream MCP server.
package main

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"log/slog"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"arbiter/internal/approval"
	"arbiter/internal/audit"
	"arbiter/internal/capability"
	"arbiter/internal/delegation"
	"arbiter/internal/enforcement"
	"arbiter/internal/executorauth"
	"arbiter/internal/identity"
	"arbiter/internal/mcp"
	"arbiter/internal/pdp"
	"arbiter/internal/schema"
	"arbiter/internal/state"
	"arbiter/internal/telemetry"

	"github.com/redis/go-redis/v9"
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	decisionTimeout := durationEnv("ARBITER_DECISION_TIMEOUT", 1500*time.Millisecond)
	metrics := telemetry.NewCounterRecorder()
	tenantID := stringEnv("ARBITER_TENANT_ID", "default")
	actorID := stringEnv("ARBITER_MCP_ACTOR_ID", "mcp-client")
	engine := enforcement.New(enforcement.Config{DecisionTimeout: decisionTimeout, StateLookupLimit: intEnv("ARBITER_STATE_LOOKUP_LIMIT", 10), PolicyOwnedObligations: true},
		state.NewMemoryStore(),
		pdp.NewClient(stringEnv("ARBITER_OPA_URL", "http://localhost:8181"), stringEnv("ARBITER_OPA_PATH", "/v1/data/arbiter/authz/decision"), decisionTimeout),
		executorauth.NewIssuerVerifier([]byte(stringEnv("ARBITER_TOKEN_SECRET", "dev-secret-change-me")), stringEnv("ARBITER_TOKEN_ISSUER", "arbiter"), durationEnv("ARBITER_TOKEN_TTL", 2*time.Minute), executorauth.NewMemoryReplayCache()),
		audit.NewLogRecorder(logger), metrics)

	authenticator := identity.Authenticator(identity.StaticAuthenticator{Principal: schema.Principal{Subject: actorID, TenantID: tenantID, Kind: "agent"}})
	if jwksURL := strings.TrimSpace(os.Getenv("ARBITER_MCP_OIDC_JWKS_URL")); jwksURL != "" {
		authenticator = &identity.OIDCAuthenticator{Issuer: stringEnv("ARBITER_MCP_OIDC_ISSUER", ""), Audience: stringEnv("ARBITER_MCP_OIDC_AUDIENCE", "arbiter-mcp"), JWKSURL: jwksURL, CacheTTL: durationEnv("ARBITER_MCP_OIDC_JWKS_CACHE_TTL", 5*time.Minute)}
	} else if secret := os.Getenv("ARBITER_MCP_JWT_SECRET"); secret != "" {
		authenticator = identity.JWTAuthenticator{Secret: []byte(secret), Issuer: stringEnv("ARBITER_MCP_JWT_ISSUER", "arbiter"), Audience: stringEnv("ARBITER_MCP_JWT_AUDIENCE", "arbiter-mcp")}
	}
	var delegationVerifier *delegation.Verifier
	if secret := os.Getenv("ARBITER_DELEGATION_SECRET"); secret != "" {
		delegationVerifier = &delegation.Verifier{Keys: map[string][]byte{stringEnv("ARBITER_DELEGATION_KID", "default"): []byte(secret)}, Issuer: stringEnv("ARBITER_DELEGATION_ISSUER", "arbiter"), Audience: stringEnv("ARBITER_DELEGATION_AUDIENCE", "arbiter-delegation"), MaxDepth: intEnv("ARBITER_DELEGATION_MAX_DEPTH", 4)}
	}
	var capabilityVerifier *capability.Verifier
	if secret := os.Getenv("ARBITER_CAPABILITY_SECRET"); secret != "" {
		var revocations capability.RevocationStore = capability.NewMemoryRevocationStore()
		if redisAddress := strings.TrimSpace(os.Getenv("ARBITER_REDIS_ADDR")); redisAddress != "" {
			revocations = capability.NewRedisRevocationStore(redis.NewClient(&redis.Options{Addr: redisAddress}), "arbiter:capability:revoked")
		}
		capabilityVerifier = &capability.Verifier{Keys: map[string][]byte{stringEnv("ARBITER_CAPABILITY_KID", "default"): []byte(secret)}, Issuer: stringEnv("ARBITER_CAPABILITY_ISSUER", "arbiter"), Audience: stringEnv("ARBITER_CAPABILITY_AUDIENCE", "arbiter-capability"), Revocations: revocations}
	}
	var approvalVerifier *approval.IssuerVerifier
	if secret := os.Getenv("ARBITER_APPROVAL_SECRET"); secret != "" {
		approvalVerifier = approval.NewIssuerVerifier(map[string][]byte{stringEnv("ARBITER_APPROVAL_KID", "default"): []byte(secret)}, stringEnv("ARBITER_APPROVAL_KID", "default"), stringEnv("ARBITER_APPROVAL_ISSUER", "arbiter"), stringEnv("ARBITER_APPROVAL_AUDIENCE", "arbiter-approval"), durationEnv("ARBITER_APPROVAL_TTL", 5*time.Minute))
	}
	var transport mcp.Transport
	var stdioTransport *mcp.StdioTransport
	if command := strings.TrimSpace(os.Getenv("ARBITER_MCP_STDIO_COMMAND")); command != "" {
		var err error
		stdioTransport, err = mcp.NewStdioTransport(context.Background(), command, strings.Fields(os.Getenv("ARBITER_MCP_STDIO_ARGS"))...)
		if err != nil {
			logger.Error("start MCP stdio transport", "error", err)
			os.Exit(1)
		}
		defer func() { _ = stdioTransport.Close() }()
		transport = stdioTransport
	}

	gateway, err := mcp.NewGateway(mcp.Config{
		UpstreamURL:        os.Getenv("ARBITER_MCP_UPSTREAM_URL"),
		Transport:          transport,
		ServerID:           os.Getenv("ARBITER_MCP_SERVER_ID"),
		ServerURI:          os.Getenv("ARBITER_MCP_SERVER_URI"),
		TenantID:           tenantID,
		ActorID:            actorID,
		GatewaySharedKey:   os.Getenv("ARBITER_GATEWAY_SHARED_KEY"),
		MaxBodyBytes:       int64Env("ARBITER_MAX_BODY_BYTES", 1<<20),
		Timeout:            durationEnv("ARBITER_MCP_UPSTREAM_TIMEOUT", 30*time.Second),
		Authenticator:      authenticator,
		DelegationVerifier: delegationVerifier,
		CapabilityVerifier: capabilityVerifier,
		RequireCapability:  boolEnv("ARBITER_REQUIRE_CAPABILITY", false),
		ApprovalVerifier:   approvalVerifier,
	}, engine)
	if err != nil {
		logger.Error("invalid MCP gateway configuration", "error", err)
		os.Exit(1)
	}

	mux := http.NewServeMux()
	mux.Handle("POST /mcp", gateway)
	mux.HandleFunc("POST /v1/capabilities/revoke", func(w http.ResponseWriter, r *http.Request) {
		serviceKey := strings.TrimSpace(os.Getenv("ARBITER_SERVICE_SHARED_KEY"))
		if capabilityVerifier == nil || serviceKey == "" || subtle.ConstantTimeCompare([]byte(r.Header.Get("X-Arbiter-Service-Key")), []byte(serviceKey)) != 1 {
			http.Error(w, `{"error":"unauthorized"}`, http.StatusUnauthorized)
			return
		}
		var input struct {
			GrantID   string `json:"grant_id"`
			ExpiresAt string `json:"expires_at"`
		}
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&input); err != nil {
			http.Error(w, `{"error":"invalid request"}`, http.StatusBadRequest)
			return
		}
		expiresAt, err := time.Parse(time.RFC3339, input.ExpiresAt)
		if err != nil || input.GrantID == "" {
			http.Error(w, `{"error":"grant_id and RFC3339 expires_at are required"}`, http.StatusBadRequest)
			return
		}
		if err := capabilityVerifier.Revoke(r.Context(), input.GrantID, expiresAt); err != nil {
			http.Error(w, `{"error":"failed to revoke capability"}`, http.StatusBadRequest)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"revoked"}`))
	})
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"ok"}`))
	})
	mux.Handle("GET /metrics", metrics.Handler())

	addr := stringEnv("ARBITER_MCP_ADDR", ":8090")
	logger.Info("starting Arbiter MCP gateway", "addr", addr, "upstream", os.Getenv("ARBITER_MCP_UPSTREAM_URL"))
	server := &http.Server{Addr: addr, Handler: mux, ReadHeaderTimeout: 2 * time.Second, ReadTimeout: 5 * time.Second, WriteTimeout: 35 * time.Second, IdleTimeout: 30 * time.Second}
	if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		logger.Error("MCP gateway failed", "error", err)
		os.Exit(1)
	}
}

func stringEnv(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}

func durationEnv(key string, fallback time.Duration) time.Duration {
	value := os.Getenv(key)
	if value == "" {
		return fallback
	}
	parsed, err := time.ParseDuration(value)
	if err != nil {
		return fallback
	}
	return parsed
}

func intEnv(key string, fallback int) int {
	value := os.Getenv(key)
	if value == "" {
		return fallback
	}
	parsed, err := strconv.Atoi(value)
	if err != nil {
		return fallback
	}
	return parsed
}

func int64Env(key string, fallback int64) int64 {
	value := os.Getenv(key)
	if value == "" {
		return fallback
	}
	parsed, err := strconv.ParseInt(value, 10, 64)
	if err != nil {
		return fallback
	}
	return parsed
}

func boolEnv(key string, fallback bool) bool {
	value := os.Getenv(key)
	if value == "" {
		return fallback
	}
	parsed, err := strconv.ParseBool(value)
	if err != nil {
		return fallback
	}
	return parsed
}
