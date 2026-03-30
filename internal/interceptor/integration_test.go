package interceptor

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"arbiter/internal/executorauth"
	"arbiter/internal/pdp"
	"arbiter/internal/schema"
	"arbiter/internal/state"
	"arbiter/internal/translator"

	"github.com/alicebob/miniredis/v2"
	"github.com/redis/go-redis/v9"
)

func TestIntegrationOpenAIInterceptWithRedisAndReplayProtection(t *testing.T) {
	t.Parallel()

	mini, err := miniredis.Run()
	if err != nil {
		t.Fatalf("start miniredis: %v", err)
	}
	defer mini.Close()

	redisClient := redis.NewClient(&redis.Options{Addr: mini.Addr()})

	opaServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var payload map[string]any
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			t.Fatalf("decode request: %v", err)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"result": map[string]any{
				"allow":          true,
				"reason":         "allowed",
				"policy_package": "arbiter.authz",
				"policy_version": "integration",
				"data_revision":  "integration",
				"decision_id":    "integration-1",
			},
		})
	}))
	defer opaServer.Close()

	service := NewService(
		Config{
			MaxBodyBytes:      1 << 20,
			MaxParameterBytes: 32 << 10,
			DecisionTimeout:   time.Second,
			StateLookupLimit:  5,
		},
		state.NewRedisStore(redisClient, "arbiter:actions", 50),
		pdp.NewClient(opaServer.URL, "", time.Second),
		executorauth.NewIssuerVerifier([]byte("integration-secret"), "arbiter", time.Minute, executorauth.NewRedisReplayCache(redisClient, "arbiter:replay")),
		nil,
		nil,
	)

	mux := http.NewServeMux()
	service.RegisterRoutes(mux)

	envelope := translator.OpenAIEnvelope{
		Metadata: schema.Metadata{
			RequestID: "req-int-1",
			TenantID:  "tenant-1",
			Provider:  "openai",
		},
		AgentContext: schema.AgentContext{
			Actor: schema.Actor{ID: "actor-1"},
		},
		ToolCall: translator.OpenAIToolCall{
			Type: "function",
			Function: translator.OpenAIFunctionToolCall{
				Name:      "send_slack_message",
				Arguments: `{"channel":"ops","message":"hello"}`,
			},
		},
	}

	interceptPayload, _ := json.Marshal(envelope)
	interceptReq := httptest.NewRequest(http.MethodPost, "/v1/intercept/openai", bytes.NewReader(interceptPayload))
	interceptRecorder := httptest.NewRecorder()
	mux.ServeHTTP(interceptRecorder, interceptReq)
	if interceptRecorder.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", interceptRecorder.Code, interceptRecorder.Body.String())
	}

	var signed schema.SignedDecision
	if err := json.NewDecoder(interceptRecorder.Body).Decode(&signed); err != nil {
		t.Fatalf("decode intercept response: %v", err)
	}
	if signed.Token == "" {
		t.Fatal("expected signed token")
	}

	verifyPayload, _ := json.Marshal(map[string]any{
		"token":    signed.Token,
		"envelope": envelope,
	})
	verifyReq := httptest.NewRequest(http.MethodPost, "/v1/execute/verify/openai", bytes.NewReader(verifyPayload))
	verifyRecorder := httptest.NewRecorder()
	mux.ServeHTTP(verifyRecorder, verifyReq)
	if verifyRecorder.Code != http.StatusOK {
		t.Fatalf("expected first verify 200, got %d", verifyRecorder.Code)
	}

	replayReq := httptest.NewRequest(http.MethodPost, "/v1/execute/verify/openai", bytes.NewReader(verifyPayload))
	replayRecorder := httptest.NewRecorder()
	mux.ServeHTTP(replayRecorder, replayReq)
	if replayRecorder.Code != http.StatusForbidden {
		t.Fatalf("expected replay verify 403, got %d", replayRecorder.Code)
	}
}

func TestIntegrationRequiredContextUsesRedisHistory(t *testing.T) {
	t.Parallel()

	mini, err := miniredis.Run()
	if err != nil {
		t.Fatalf("start miniredis: %v", err)
	}
	defer mini.Close()

	redisClient := redis.NewClient(&redis.Options{Addr: mini.Addr()})

	opaServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var payload struct {
			Input schema.CanonicalRequest `json:"input"`
		}
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			t.Fatalf("decode request: %v", err)
		}

		allow := len(payload.Input.PreviousActions) > 0
		_ = json.NewEncoder(w).Encode(map[string]any{
			"result": map[string]any{
				"allow":                    allow,
				"reason":                   map[bool]string{true: "allowed", false: "required context missing"}[allow],
				"policy_package":           "arbiter.authz",
				"policy_version":           "integration",
				"data_revision":            "integration",
				"decision_id":              payload.Input.Metadata.RequestID,
				"required_context_missing": !allow,
			},
		})
	}))
	defer opaServer.Close()

	store := state.NewRedisStore(redisClient, "arbiter:actions", 50)
	service := NewService(
		Config{
			MaxBodyBytes:      1 << 20,
			MaxParameterBytes: 32 << 10,
			DecisionTimeout:   time.Second,
			StateLookupLimit:  5,
		},
		store,
		pdp.NewClient(opaServer.URL, "", time.Second),
		executorauth.NewIssuerVerifier([]byte("integration-secret"), "arbiter", time.Minute, executorauth.NewRedisReplayCache(redisClient, "arbiter:replay")),
		nil,
		nil,
	)

	if err := store.RecordAction(context.Background(), state.ActionRecord{
		TenantID: "tenant-1",
		ActorID:  "actor-1",
		PreviousAction: schema.PreviousAction{
			ToolName: "backup_database",
			Outcome:  "allowed",
			At:       time.Now().UTC(),
		},
	}); err != nil {
		t.Fatalf("record action: %v", err)
	}

	mux := http.NewServeMux()
	service.RegisterRoutes(mux)

	payload, _ := json.Marshal(translator.OpenAIEnvelope{
		Metadata: schema.Metadata{
			RequestID: "req-int-2",
			TenantID:  "tenant-1",
			Provider:  "openai",
		},
		AgentContext: schema.AgentContext{
			Actor: schema.Actor{ID: "actor-1"},
		},
		RequiredContext: []string{"backup"},
		ToolCall: translator.OpenAIToolCall{
			Type: "function",
			Function: translator.OpenAIFunctionToolCall{
				Name:      "delete_backup",
				Arguments: `{"backup_id":"b-1"}`,
			},
		},
	})

	req := httptest.NewRequest(http.MethodPost, "/v1/intercept/openai", bytes.NewReader(payload))
	recorder := httptest.NewRecorder()
	mux.ServeHTTP(recorder, req)
	if recorder.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", recorder.Code, recorder.Body.String())
	}
}
