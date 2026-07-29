package main

import "testing"

func validProductionConfig() productionConfig {
	return productionConfig{
		RequireWorkloadIdentity: true,
		OIDCJWKSURL:             "https://issuer.example/jwks",
		RS256PrivateKey:         "-----BEGIN PRIVATE KEY-----...",
		RedisAddress:            "redis:6379",
		AuditPostgresDSN:        "postgres://arbiter.example/arbiter",
		ServiceSharedKey:        "service-key",
	}
}

func TestValidateProductionConfigAcceptsBaseline(t *testing.T) {
	if err := validateProductionConfig(validProductionConfig()); err != nil {
		t.Fatalf("expected valid production baseline, got %v", err)
	}
}

func TestValidateProductionConfigRejectsMissingControls(t *testing.T) {
	if err := validateProductionConfig(productionConfig{}); err == nil {
		t.Fatal("expected missing production controls to be rejected")
	}
}

func TestValidateProductionConfigAcceptsInternalJWT(t *testing.T) {
	config := validProductionConfig()
	config.OIDCJWKSURL = ""
	config.JWTSecret = "gateway-issued-jwt-secret"
	if err := validateProductionConfig(config); err != nil {
		t.Fatalf("expected internal JWT production baseline, got %v", err)
	}
}
