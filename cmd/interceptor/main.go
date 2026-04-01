package main

import (
	"context"
	"log/slog"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"arbiter/internal/audit"
	"arbiter/internal/executorauth"
	"arbiter/internal/interceptor"
	"arbiter/internal/pdp"
	"arbiter/internal/state"
	"arbiter/internal/telemetry"

	"github.com/redis/go-redis/v9"
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))

	addr := getEnv("ARBITER_ADDR", ":8080")
	opaURL := getEnv("ARBITER_OPA_URL", "http://localhost:8181")
	opaPath := getEnv("ARBITER_OPA_PATH", "/v1/data/arbiter/authz/decision")
	tokenSecret := getEnv("ARBITER_TOKEN_SECRET", "dev-secret-change-me")
	tokenActiveKeyID := getEnv("ARBITER_TOKEN_ACTIVE_KID", "default")
	tokenKeys := getKeySetEnv("ARBITER_TOKEN_KEYS")
	tokenIssuer := getEnv("ARBITER_TOKEN_ISSUER", "arbiter")
	tokenTTL := getDurationEnv("ARBITER_TOKEN_TTL", 2*time.Minute)
	decisionTimeout := getDurationEnv("ARBITER_DECISION_TIMEOUT", 1500*time.Millisecond)
	maxBodyBytes := getInt64Env("ARBITER_MAX_BODY_BYTES", 1<<20)
	maxParameterBytes := getIntEnv("ARBITER_MAX_PARAMETER_BYTES", 32<<10)
	stateLookupLimit := getIntEnv("ARBITER_STATE_LOOKUP_LIMIT", 10)
	fastAllowedTools := getCSVEnv("ARBITER_FAST_ALLOWED_TOOLS")
	gatewaySharedKey := getEnv("ARBITER_GATEWAY_SHARED_KEY", "")
	serviceSharedKey := getEnv("ARBITER_SERVICE_SHARED_KEY", "")
	otelEnabled := getBoolEnv("ARBITER_OTEL_ENABLED", false)
	otelEndpoint := getEnv("ARBITER_OTEL_ENDPOINT", "")
	otelInsecure := getBoolEnv("ARBITER_OTEL_INSECURE", true)
	auditPostgresDSN := getEnv("ARBITER_AUDIT_POSTGRES_DSN", "")
	auditPostgresQueue := getIntEnv("ARBITER_AUDIT_POSTGRES_QUEUE", 1024)

	shutdownTracing, err := telemetry.InitOTel(context.Background(), telemetry.OTelConfig{
		Enabled:     otelEnabled,
		Endpoint:    otelEndpoint,
		ServiceName: "arbiter-interceptor",
		Insecure:    otelInsecure,
	})
	if err != nil {
		logger.Error("failed to initialize tracing", "error", err)
		os.Exit(1)
	}
	defer func() {
		_ = shutdownTracing(context.Background())
	}()

	var (
		stateStore state.Store              = state.NewMemoryStore()
		replay     executorauth.ReplayCache = executorauth.NewMemoryReplayCache()
	)
	metricsRecorder := telemetry.NewCounterRecorder()
	var auditRecorder audit.Recorder = audit.NewLogRecorder(logger)

	if redisAddr := os.Getenv("ARBITER_REDIS_ADDR"); redisAddr != "" {
		client := redis.NewClient(&redis.Options{
			Addr:         redisAddr,
			PoolSize:     16,
			MinIdleConns: 4,
		})
		stateStore = state.NewRedisStore(client, "arbiter:actions", 50)
		replay = executorauth.NewRedisReplayCache(client, "arbiter:replay")
	}

	if strings.TrimSpace(auditPostgresDSN) != "" {
		pgAuditRecorder, err := audit.NewPostgresRecorder(context.Background(), auditPostgresDSN, auditPostgresQueue, logger)
		if err != nil {
			logger.Error("failed to initialize postgres audit recorder", "error", err)
			os.Exit(1)
		}
		defer func() {
			shutdownCtx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			defer cancel()
			if err := pgAuditRecorder.Close(shutdownCtx); err != nil {
				logger.Error("failed to close postgres audit recorder", "error", err)
			}
		}()
		auditRecorder = audit.NewMultiRecorder(auditRecorder, pgAuditRecorder)
	}

	service := interceptor.NewService(
		interceptor.Config{
			MaxBodyBytes:      maxBodyBytes,
			MaxParameterBytes: maxParameterBytes,
			DecisionTimeout:   decisionTimeout,
			StateLookupLimit:  stateLookupLimit,
			FastAllowedTools:  fastAllowedTools,
			GatewaySharedKey:  gatewaySharedKey,
			ServiceSharedKey:  serviceSharedKey,
		},
		stateStore,
		pdp.NewClient(opaURL, opaPath, decisionTimeout),
		newIssuerVerifier(tokenSecret, tokenKeys, tokenActiveKeyID, tokenIssuer, tokenTTL, replay),
		auditRecorder,
		metricsRecorder,
	)

	mux := http.NewServeMux()
	service.RegisterRoutes(mux)
	mux.HandleFunc("GET /metrics", metricsRecorder.Handler())

	server := &http.Server{
		Addr:              addr,
		Handler:           telemetry.WithTrace(mux),
		ReadHeaderTimeout: 2 * time.Second,
		ReadTimeout:       5 * time.Second,
		WriteTimeout:      5 * time.Second,
		IdleTimeout:       30 * time.Second,
	}

	logger.Info("starting arbiter interceptor", "addr", addr, "opa_url", opaURL)
	if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		logger.Error("server failed", "error", err)
		os.Exit(1)
	}
}

func getEnv(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}

func getIntEnv(key string, fallback int) int {
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

func getInt64Env(key string, fallback int64) int64 {
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

func getDurationEnv(key string, fallback time.Duration) time.Duration {
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

func getCSVEnv(key string) []string {
	value := os.Getenv(key)
	if value == "" {
		return nil
	}
	parts := strings.Split(value, ",")
	values := make([]string, 0, len(parts))
	for _, part := range parts {
		trimmed := strings.TrimSpace(part)
		if trimmed == "" {
			continue
		}
		values = append(values, trimmed)
	}
	return values
}

func getBoolEnv(key string, fallback bool) bool {
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

func getKeySetEnv(key string) map[string][]byte {
	value := os.Getenv(key)
	if value == "" {
		return nil
	}

	pairs := strings.Split(value, ",")
	keys := make(map[string][]byte, len(pairs))
	for _, pair := range pairs {
		parts := strings.SplitN(strings.TrimSpace(pair), ":", 2)
		if len(parts) != 2 {
			continue
		}
		keyID := strings.TrimSpace(parts[0])
		secret := strings.TrimSpace(parts[1])
		if keyID == "" || secret == "" {
			continue
		}
		keys[keyID] = []byte(secret)
	}
	if len(keys) == 0 {
		return nil
	}
	return keys
}

func newIssuerVerifier(singleSecret string, keySet map[string][]byte, activeKeyID, issuer string, ttl time.Duration, replay executorauth.ReplayCache) *executorauth.IssuerVerifier {
	if len(keySet) == 0 {
		return executorauth.NewIssuerVerifier([]byte(singleSecret), issuer, ttl, replay)
	}
	return executorauth.NewIssuerVerifierWithKeys(keySet, activeKeyID, issuer, ttl, replay)
}
