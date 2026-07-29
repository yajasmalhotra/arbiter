package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"time"

	"arbiter/internal/audit"
	"arbiter/internal/executorauth"
	"arbiter/internal/pdp"
	"arbiter/internal/state"
)

type readinessChecker interface {
	Ready(context.Context) error
}

type readinessConfig struct {
	Timeout                    time.Duration
	RequireWorkloadIdentity    bool
	WorkloadIdentityConfigured bool
	State                      state.Store
	Decider                    pdp.Decider
	Issuer                     *executorauth.IssuerVerifier
	Audit                      audit.Recorder
}

func newReadinessHandler(config readinessConfig) http.HandlerFunc {
	if config.Timeout <= 0 {
		config.Timeout = 2 * time.Second
	}
	return func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithTimeout(r.Context(), config.Timeout)
		defer cancel()
		if config.RequireWorkloadIdentity && !config.WorkloadIdentityConfigured {
			writeReadinessError(w, errors.New("workload identity is required but no authenticator is configured"))
			return
		}
		for _, dependency := range []any{config.State, config.Decider, config.Issuer, config.Audit} {
			if checker, ok := dependency.(readinessChecker); ok {
				if err := checker.Ready(ctx); err != nil {
					writeReadinessError(w, err)
					return
				}
			}
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"ready"}`))
	}
}

func writeReadinessError(w http.ResponseWriter, err error) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusServiceUnavailable)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
}
