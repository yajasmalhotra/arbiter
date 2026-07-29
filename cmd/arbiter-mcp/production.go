package main

import (
	"errors"
	"strings"
)

// productionConfig captures the controls required for an MCP gateway that is
// exposed as an enterprise tool-execution boundary.
type productionConfig struct {
	RequireWorkloadIdentity bool
	OIDCJWKSURL             string
	OIDCIssuer              string
	JWTSecret               string
	RS256PrivateKey         string
	RedisAddress            string
	AuditPostgresDSN        string
	GatewaySharedKey        string
	ServiceSharedKey        string
	RequireCapability       bool
	CapabilityAlgorithm     string
	CapabilityPublicKey     string
}

func validateProductionConfig(config productionConfig) error {
	missing := make([]string, 0, 10)
	if !config.RequireWorkloadIdentity {
		missing = append(missing, "ARBITER_REQUIRE_WORKLOAD_IDENTITY=true")
	}
	if strings.TrimSpace(config.OIDCJWKSURL) == "" && strings.TrimSpace(config.JWTSecret) == "" {
		missing = append(missing, "ARBITER_MCP_OIDC_JWKS_URL or ARBITER_MCP_JWT_SECRET")
	}
	if strings.TrimSpace(config.OIDCJWKSURL) != "" && strings.TrimSpace(config.OIDCIssuer) == "" {
		missing = append(missing, "ARBITER_MCP_OIDC_ISSUER")
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
	if strings.TrimSpace(config.GatewaySharedKey) == "" {
		missing = append(missing, "ARBITER_GATEWAY_SHARED_KEY")
	}
	if strings.TrimSpace(config.ServiceSharedKey) == "" {
		missing = append(missing, "ARBITER_SERVICE_SHARED_KEY")
	}
	if !config.RequireCapability {
		missing = append(missing, "ARBITER_REQUIRE_CAPABILITY=true")
	}
	if strings.ToUpper(strings.TrimSpace(config.CapabilityAlgorithm)) != "RS256" {
		missing = append(missing, "ARBITER_CAPABILITY_ALGORITHM=RS256")
	}
	if strings.TrimSpace(config.CapabilityPublicKey) == "" {
		missing = append(missing, "ARBITER_CAPABILITY_PUBLIC_KEY")
	}
	if len(missing) > 0 {
		return errors.New("production baseline missing: " + strings.Join(missing, ", "))
	}
	return nil
}
