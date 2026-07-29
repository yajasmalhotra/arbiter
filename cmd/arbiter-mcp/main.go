// arbiter-mcp is an MCP JSON-RPC gateway that applies Arbiter policy before
// forwarding tool discovery and invocation traffic to an upstream MCP server.
package main

import (
	"context"
	"crypto/rsa"
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
	gatewaySharedKey := strings.TrimSpace(os.Getenv("ARBITER_GATEWAY_SHARED_KEY"))
	serviceSharedKey := strings.TrimSpace(os.Getenv("ARBITER_SERVICE_SHARED_KEY"))
	requireWorkloadIdentity := boolEnv("ARBITER_REQUIRE_WORKLOAD_IDENTITY", false)
	requireCapability := boolEnv("ARBITER_REQUIRE_CAPABILITY", false)
	auditPostgresDSN := strings.TrimSpace(os.Getenv("ARBITER_AUDIT_POSTGRES_DSN"))
	auditPostgresQueue := intEnv("ARBITER_AUDIT_POSTGRES_QUEUE", 1024)
	capabilityAlgorithm := strings.ToUpper(strings.TrimSpace(stringEnv("ARBITER_CAPABILITY_ALGORITHM", "HS256")))
	oidcJWKSURL := strings.TrimSpace(os.Getenv("ARBITER_MCP_OIDC_JWKS_URL"))
	oidcIssuer := strings.TrimSpace(os.Getenv("ARBITER_MCP_OIDC_ISSUER"))
	mcpJWTSecret := strings.TrimSpace(os.Getenv("ARBITER_MCP_JWT_SECRET"))
	if boolEnv("ARBITER_PRODUCTION_MODE", false) {
		if err := validateProductionConfig(productionConfig{
			RequireWorkloadIdentity: requireWorkloadIdentity,
			OIDCJWKSURL:             oidcJWKSURL,
			OIDCIssuer:              oidcIssuer,
			JWTSecret:               mcpJWTSecret,
			RS256PrivateKey:         os.Getenv("ARBITER_TOKEN_RS256_PRIVATE_KEY"),
			RedisAddress:            os.Getenv("ARBITER_REDIS_ADDR"),
			AuditPostgresDSN:        auditPostgresDSN,
			GatewaySharedKey:        gatewaySharedKey,
			ServiceSharedKey:        serviceSharedKey,
			RequireCapability:       requireCapability,
			CapabilityAlgorithm:     capabilityAlgorithm,
			CapabilityPublicKey:     os.Getenv("ARBITER_CAPABILITY_PUBLIC_KEY"),
		}); err != nil {
			logger.Error("invalid production MCP gateway configuration", "error", err)
			os.Exit(1)
		}
	}
	if requireWorkloadIdentity && oidcJWKSURL == "" && mcpJWTSecret == "" {
		logger.Error("ARBITER_REQUIRE_WORKLOAD_IDENTITY requires ARBITER_MCP_OIDC_JWKS_URL or ARBITER_MCP_JWT_SECRET")
		os.Exit(1)
	}
	if oidcJWKSURL != "" && oidcIssuer == "" {
		logger.Error("ARBITER_MCP_OIDC_ISSUER is required with ARBITER_MCP_OIDC_JWKS_URL")
		os.Exit(1)
	}
	tokenIssuer := stringEnv("ARBITER_TOKEN_ISSUER", "arbiter")
	tokenTTL := durationEnv("ARBITER_TOKEN_TTL", 2*time.Minute)
	tokenActiveKeyID := stringEnv("ARBITER_TOKEN_ACTIVE_KID", "default")
	var (
		stateStore  state.Store              = state.NewMemoryStore()
		replay      executorauth.ReplayCache = executorauth.NewMemoryReplayCache()
		redisClient redis.UniversalClient
	)
	if redisAddress := strings.TrimSpace(os.Getenv("ARBITER_REDIS_ADDR")); redisAddress != "" {
		redisClient = redis.NewClient(&redis.Options{Addr: redisAddress, PoolSize: 16, MinIdleConns: 4})
		stateStore = state.NewRedisStore(redisClient, "arbiter:actions", 50)
		replay = executorauth.NewRedisReplayCache(redisClient, "arbiter:replay")
	}
	var auditRecorder audit.Recorder = audit.NewLogRecorder(logger)
	if auditPostgresDSN != "" {
		postgresAudit, err := audit.NewPostgresRecorder(context.Background(), auditPostgresDSN, auditPostgresQueue, logger)
		if err != nil {
			logger.Error("failed to initialize Postgres audit recorder", "error", err)
			os.Exit(1)
		}
		defer func() {
			shutdownCtx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			defer cancel()
			if err := postgresAudit.Close(shutdownCtx); err != nil {
				logger.Error("failed to close Postgres audit recorder", "error", err)
			}
		}()
		auditRecorder = audit.NewMultiRecorder(auditRecorder, postgresAudit)
	}
	permitIssuer := executorauth.NewIssuerVerifier([]byte(stringEnv("ARBITER_TOKEN_SECRET", "dev-secret-change-me")), tokenIssuer, tokenTTL, replay)
	if rawRS256Key := strings.TrimSpace(os.Getenv("ARBITER_TOKEN_RS256_PRIVATE_KEY")); rawRS256Key != "" {
		privateKey, err := executorauth.ParseRS256PrivateKeyPEM([]byte(rawRS256Key))
		if err != nil {
			logger.Error("invalid ARBITER_TOKEN_RS256_PRIVATE_KEY", "error", err)
			os.Exit(1)
		}
		permitIssuer = executorauth.NewIssuerVerifierWithRS256PrivateKeys(map[string]*rsa.PrivateKey{tokenActiveKeyID: privateKey}, tokenActiveKeyID, tokenIssuer, tokenTTL, replay)
	}
	engine := enforcement.New(enforcement.Config{DecisionTimeout: decisionTimeout, StateLookupLimit: intEnv("ARBITER_STATE_LOOKUP_LIMIT", 10), PolicyOwnedObligations: true},
		stateStore,
		pdp.NewClient(stringEnv("ARBITER_OPA_URL", "http://localhost:8181"), stringEnv("ARBITER_OPA_PATH", "/v1/data/arbiter/authz/decision"), decisionTimeout),
		permitIssuer,
		auditRecorder, metrics)

	authenticator := identity.Authenticator(identity.StaticAuthenticator{Principal: schema.Principal{Subject: actorID, TenantID: tenantID, Kind: "agent"}})
	if oidcJWKSURL != "" {
		authenticator = &identity.OIDCAuthenticator{Issuer: oidcIssuer, Audience: stringEnv("ARBITER_MCP_OIDC_AUDIENCE", "arbiter-mcp"), JWKSURL: oidcJWKSURL, CacheTTL: durationEnv("ARBITER_MCP_OIDC_JWKS_CACHE_TTL", 5*time.Minute)}
	} else if mcpJWTSecret != "" {
		authenticator = identity.JWTAuthenticator{Secret: []byte(mcpJWTSecret), Issuer: stringEnv("ARBITER_MCP_JWT_ISSUER", "arbiter"), Audience: stringEnv("ARBITER_MCP_JWT_AUDIENCE", "arbiter-mcp")}
	}
	var delegationVerifier *delegation.Verifier
	if secret := os.Getenv("ARBITER_DELEGATION_SECRET"); secret != "" {
		delegationVerifier = &delegation.Verifier{Keys: map[string][]byte{stringEnv("ARBITER_DELEGATION_KID", "default"): []byte(secret)}, Issuer: stringEnv("ARBITER_DELEGATION_ISSUER", "arbiter"), Audience: stringEnv("ARBITER_DELEGATION_AUDIENCE", "arbiter-delegation"), MaxDepth: intEnv("ARBITER_DELEGATION_MAX_DEPTH", 4)}
	}
	var capabilityVerifier *capability.Verifier
	capabilityKeyID := stringEnv("ARBITER_CAPABILITY_KID", "default")
	capabilityIssuer := stringEnv("ARBITER_CAPABILITY_ISSUER", "arbiter")
	capabilityAudience := stringEnv("ARBITER_CAPABILITY_AUDIENCE", "arbiter-capability")
	newCapabilityRevocationStore := func() capability.RevocationStore {
		if redisClient != nil {
			return capability.NewRedisRevocationStore(redisClient, "arbiter:capability:revoked")
		}
		return capability.NewMemoryRevocationStore()
	}
	switch capabilityAlgorithm {
	case "HS256":
		if secret := os.Getenv("ARBITER_CAPABILITY_SECRET"); secret != "" {
			capabilityVerifier = &capability.Verifier{Keys: map[string][]byte{capabilityKeyID: []byte(secret)}, Issuer: capabilityIssuer, Audience: capabilityAudience, Revocations: newCapabilityRevocationStore()}
		}
	case "RS256":
		rawPublicKey := strings.TrimSpace(os.Getenv("ARBITER_CAPABILITY_PUBLIC_KEY"))
		if rawPublicKey == "" {
			logger.Error("ARBITER_CAPABILITY_PUBLIC_KEY is required for RS256 capability verification")
			os.Exit(1)
		}
		publicKey, err := capability.ParseRS256PublicKeyPEM([]byte(rawPublicKey))
		if err != nil {
			logger.Error("invalid ARBITER_CAPABILITY_PUBLIC_KEY", "error", err)
			os.Exit(1)
		}
		capabilityVerifier = &capability.Verifier{RS256Keys: map[string]*rsa.PublicKey{capabilityKeyID: publicKey}, Issuer: capabilityIssuer, Audience: capabilityAudience, Revocations: newCapabilityRevocationStore()}
	default:
		logger.Error("ARBITER_CAPABILITY_ALGORITHM must be HS256 or RS256")
		os.Exit(1)
	}
	if requireCapability && capabilityVerifier == nil {
		logger.Error("ARBITER_REQUIRE_CAPABILITY requires a capability verification key")
		os.Exit(1)
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
		GatewaySharedKey:   gatewaySharedKey,
		MaxBodyBytes:       int64Env("ARBITER_MAX_BODY_BYTES", 1<<20),
		Timeout:            durationEnv("ARBITER_MCP_UPSTREAM_TIMEOUT", 30*time.Second),
		Authenticator:      authenticator,
		DelegationVerifier: delegationVerifier,
		CapabilityVerifier: capabilityVerifier,
		RequireCapability:  requireCapability,
		ApprovalVerifier:   approvalVerifier,
	}, engine)
	if err != nil {
		logger.Error("invalid MCP gateway configuration", "error", err)
		os.Exit(1)
	}

	mux := http.NewServeMux()
	mux.Handle("POST /mcp", gateway)
	mux.HandleFunc("POST /v1/capabilities/revoke", func(w http.ResponseWriter, r *http.Request) {
		if capabilityVerifier == nil || serviceSharedKey == "" || subtle.ConstantTimeCompare([]byte(r.Header.Get("X-Arbiter-Service-Key")), []byte(serviceSharedKey)) != 1 {
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
