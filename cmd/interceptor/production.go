package main

import (
	"errors"
	"strings"
)

// productionConfig captures the minimum controls required when a deployment
// opts into Arbiter's strict production baseline. Keeping this check at startup
// prevents a healthy-looking interceptor from running with local-demo defaults.
type productionConfig struct {
	RequireWorkloadIdentity bool
	OIDCJWKSURL             string
	JWTSecret               string
	RS256PrivateKey         string
	RedisAddress            string
	AuditPostgresDSN        string
	ServiceSharedKey        string
}

func validateProductionConfig(config productionConfig) error {
	missing := make([]string, 0, 6)
	if !config.RequireWorkloadIdentity {
		missing = append(missing, "ARBITER_REQUIRE_WORKLOAD_IDENTITY=true")
	}
	if strings.TrimSpace(config.OIDCJWKSURL) == "" && strings.TrimSpace(config.JWTSecret) == "" {
		missing = append(missing, "ARBITER_INTERCEPTOR_OIDC_JWKS_URL or ARBITER_INTERCEPTOR_JWT_SECRET")
	}
	if strings.TrimSpace(config.RS256PrivateKey) == "" {
		missing = append(missing, "ARBITER_TOKEN_RS256_PRIVATE_KEY")
	}
	if strings.TrimSpace(config.RedisAddress) == "" {
		missing = append(missing, "ARBITER_REDIS_ADDR")
	}
	if strings.TrimSpace(config.AuditPostgresDSN) == "" {
		missing = append(missing, "ARBITER_AUDIT_POSTGRES_DSN")
	}
	if strings.TrimSpace(config.ServiceSharedKey) == "" {
		missing = append(missing, "ARBITER_SERVICE_SHARED_KEY")
	}
	if len(missing) > 0 {
		return errors.New("production baseline missing: " + strings.Join(missing, ", "))
	}
	return nil
}
