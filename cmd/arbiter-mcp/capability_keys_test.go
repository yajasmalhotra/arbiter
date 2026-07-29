package main

import (
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"testing"
)

func publicKeyPEM(t *testing.T) string {
	t.Helper()
	privateKey, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatalf("generate RSA key: %v", err)
	}
	raw, err := x509.MarshalPKIXPublicKey(&privateKey.PublicKey)
	if err != nil {
		t.Fatalf("marshal public key: %v", err)
	}
	return string(pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: raw}))
}

func TestLoadRS256CapabilityPublicKeysSupportsRotationOverlap(t *testing.T) {
	activePEM := publicKeyPEM(t)
	previousPEM := publicKeyPEM(t)
	additional, err := json.Marshal(map[string]string{"capability-2025": previousPEM})
	if err != nil {
		t.Fatalf("marshal additional keys: %v", err)
	}
	keys, err := loadRS256CapabilityPublicKeys("capability-2026", activePEM, string(additional))
	if err != nil {
		t.Fatalf("load public keys: %v", err)
	}
	if len(keys) != 2 || keys["capability-2026"] == nil || keys["capability-2025"] == nil {
		t.Fatalf("expected active and previous public keys, got %#v", keys)
	}
}

func TestLoadRS256CapabilityPublicKeysRejectsActiveKeyReplacement(t *testing.T) {
	additional, err := json.Marshal(map[string]string{"active": publicKeyPEM(t)})
	if err != nil {
		t.Fatalf("marshal additional keys: %v", err)
	}
	if _, err := loadRS256CapabilityPublicKeys("active", publicKeyPEM(t), string(additional)); err == nil {
		t.Fatal("expected active key replacement to be rejected")
	}
}

func TestLoadRS256CapabilityPublicKeysBoundsRotationSet(t *testing.T) {
	additional := make(map[string]string, maxCapabilityVerificationKeys)
	for index := range maxCapabilityVerificationKeys {
		additional["old-key-"+string(rune('a'+index))] = "ignored because the size check runs first"
	}
	raw, err := json.Marshal(additional)
	if err != nil {
		t.Fatalf("marshal additional keys: %v", err)
	}
	if _, err := loadRS256CapabilityPublicKeys("active", publicKeyPEM(t), string(raw)); err == nil {
		t.Fatal("expected oversized rotation set to be rejected")
	}
}
