package main

import (
	"crypto/rsa"
	"encoding/json"
	"fmt"
	"strings"

	"arbiter/internal/capability"
)

const maxCapabilityVerificationKeys = 8

// loadRS256CapabilityPublicKeys loads the active verifier key plus optional
// overlapping previous keys. The JSON form keeps PEM values unambiguous while
// allowing secret managers to deliver a single bounded configuration value.
func loadRS256CapabilityPublicKeys(activeKeyID, activePEM, additionalKeysJSON string) (map[string]*rsa.PublicKey, error) {
	activeKeyID = strings.TrimSpace(activeKeyID)
	if activeKeyID == "" {
		return nil, fmt.Errorf("capability active key ID is required")
	}
	activePEM = strings.TrimSpace(activePEM)
	if activePEM == "" {
		return nil, fmt.Errorf("ARBITER_CAPABILITY_PUBLIC_KEY is required for RS256 capability verification")
	}
	activeKey, err := capability.ParseRS256PublicKeyPEM([]byte(activePEM))
	if err != nil {
		return nil, fmt.Errorf("invalid ARBITER_CAPABILITY_PUBLIC_KEY: %w", err)
	}
	keys := map[string]*rsa.PublicKey{activeKeyID: activeKey}
	if strings.TrimSpace(additionalKeysJSON) == "" {
		return keys, nil
	}

	var configured map[string]string
	if err := json.Unmarshal([]byte(additionalKeysJSON), &configured); err != nil {
		return nil, fmt.Errorf("invalid ARBITER_CAPABILITY_ADDITIONAL_PUBLIC_KEYS_JSON: %w", err)
	}
	if len(configured) >= maxCapabilityVerificationKeys {
		return nil, fmt.Errorf("additional capability public keys exceed maximum rotation set of %d", maxCapabilityVerificationKeys)
	}
	for keyID, rawPEM := range configured {
		keyID = strings.TrimSpace(keyID)
		if keyID == "" || strings.TrimSpace(rawPEM) == "" {
			return nil, fmt.Errorf("additional capability public keys require non-empty key IDs and PEM values")
		}
		if keyID == activeKeyID {
			return nil, fmt.Errorf("additional capability public keys must not replace active key %q", activeKeyID)
		}
		key, err := capability.ParseRS256PublicKeyPEM([]byte(rawPEM))
		if err != nil {
			return nil, fmt.Errorf("invalid additional capability public key %q: %w", keyID, err)
		}
		keys[keyID] = key
	}
	return keys, nil
}
