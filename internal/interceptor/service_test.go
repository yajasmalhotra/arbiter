package interceptor

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"arbiter/internal/executorauth"
	"arbiter/internal/pdp"
	"arbiter/internal/schema"
	"arbiter/internal/state"
	"arbiter/internal/telemetry"
	"arbiter/internal/translator"
)

type deciderFunc func(ctx context.Context, req schema.CanonicalRequest) (schema.Decision, error)

func (f deciderFunc) Decide(ctx context.Context, req schema.CanonicalRequest) (schema.Decision, error) {
	return f(ctx, req)
}

type labelerFunc func(ctx context.Context, req schema.CanonicalRequest) (string, error)

func (f labelerFunc) Label(ctx context.Context, req schema.CanonicalRequest) (string, error) {
	return f(ctx, req)
}

func newTestService(decider pdp.Decider, store state.Store) *Service {
	return newTestServiceWithConfig(decider, store, Config{})
}

func newTestServiceWithConfig(decider pdp.Decider, store state.Store, config Config) *Service {
	if config.MaxBodyBytes == 0 {
		config.MaxBodyBytes = 4096
	}
	if config.MaxParameterBytes == 0 {
		config.MaxParameterBytes = 1024
	}
	if config.DecisionTimeout == 0 {
		config.DecisionTimeout = time.Second
	}
	if config.StateLookupLimit == 0 {
		config.StateLookupLimit = 5
	}

	return NewService(config, store, decider, executorauth.NewIssuerVerifier([]byte("top-secret"), "arbiter", time.Minute, executorauth.NewMemoryReplayCache()), nil, nil)
}

type readyDecider struct {
	decision schema.Decision
	err      error
	readyErr error
}

func (d readyDecider) Decide(_ context.Context, _ schema.CanonicalRequest) (schema.Decision, error) {
	return d.decision, d.err
}

func (d readyDecider) Ready(_ context.Context) error {
	return d.readyErr
}

type readyStore struct {
	state.Store
	readyErr error
}

func (s readyStore) Ready(_ context.Context) error {
	return s.readyErr
}

func defaultAllowDecision(id string) schema.Decision {
	return schema.Decision{
		Allow:         true,
		Reason:        "allowed",
		PolicyPackage: "arbiter.authz",
		PolicyVersion: "v1",
		DataRevision:  "rev-1",
		DecisionID:    id,
	}
}

func defaultOpenAIEnvelope() translator.OpenAIEnvelope {
	return translator.OpenAIEnvelope{
		Metadata: schema.Metadata{
			RequestID: "req-1",
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
}

func newJSONRequest(method, path string, body any) *http.Request {
	payload, _ := json.Marshal(body)
	return httptest.NewRequest(method, path, bytes.NewReader(payload))
}

func defaultActionRecord() state.ActionRecord {
	return state.ActionRecord{
		TenantID: "tenant-1",
		ActorID:  "actor-1",
		PreviousAction: schema.PreviousAction{
			ToolName: "backup_database",
			Outcome:  "allowed",
			At:       time.Now().UTC(),
		},
	}
}

func TestServiceReadyzReturnsReadyWhenDependenciesAreHealthy(t *testing.T) {
	t.Parallel()

	service := newTestServiceWithConfig(
		readyDecider{decision: defaultAllowDecision("decision-ready")},
		readyStore{Store: state.NewMemoryStore()},
		Config{
			MaxBodyBytes:      4096,
			MaxParameterBytes: 1024,
			DecisionTimeout:   time.Second,
			StateLookupLimit:  5,
		},
	)

	mux := http.NewServeMux()
	service.RegisterRoutes(mux)

	req := httptest.NewRequest(http.MethodGet, "/readyz", nil)
	recorder := httptest.NewRecorder()
	mux.ServeHTTP(recorder, req)
	if recorder.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", recorder.Code, recorder.Body.String())
	}
}

func TestServiceReadyzReturnsUnavailableWhenDeciderNotReady(t *testing.T) {
	t.Parallel()

	service := newTestServiceWithConfig(
		readyDecider{decision: defaultAllowDecision("decision-ready"), readyErr: context.DeadlineExceeded},
		readyStore{Store: state.NewMemoryStore()},
		Config{},
	)

	mux := http.NewServeMux()
	service.RegisterRoutes(mux)

	req := httptest.NewRequest(http.MethodGet, "/readyz", nil)
	recorder := httptest.NewRecorder()
	mux.ServeHTTP(recorder, req)
	if recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("expected 503, got %d: %s", recorder.Code, recorder.Body.String())
	}
}

func TestServiceInterceptOpenAIRequiresGatewayKeyWhenConfigured(t *testing.T) {
	t.Parallel()

	service := newTestServiceWithConfig(
		pdp.StaticDecider{Decision: defaultAllowDecision("decision-gateway-auth")},
		state.NewMemoryStore(),
		Config{GatewaySharedKey: "gateway-secret"},
	)

	mux := http.NewServeMux()
	service.RegisterRoutes(mux)

	body := defaultOpenAIEnvelope()

	req := newJSONRequest(http.MethodPost, "/v1/intercept/openai", body)
	recorder := httptest.NewRecorder()
	mux.ServeHTTP(recorder, req)
	if recorder.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401 without header, got %d", recorder.Code)
	}

	authorizedReq := newJSONRequest(http.MethodPost, "/v1/intercept/openai", body)
	authorizedReq.Header.Set("X-Arbiter-Gateway-Key", "gateway-secret")
	authorizedRecorder := httptest.NewRecorder()
	mux.ServeHTTP(authorizedRecorder, authorizedReq)
	if authorizedRecorder.Code != http.StatusOK {
		t.Fatalf("expected 200 with gateway key, got %d: %s", authorizedRecorder.Code, authorizedRecorder.Body.String())
	}
}

func TestServiceVerifyAndRecordRequireServiceKeyWhenConfigured(t *testing.T) {
	t.Parallel()

	service := newTestServiceWithConfig(
		pdp.StaticDecider{Decision: defaultAllowDecision("decision-service-auth")},
		state.NewMemoryStore(),
		Config{ServiceSharedKey: "service-secret"},
	)

	mux := http.NewServeMux()
	service.RegisterRoutes(mux)

	verifyReq := newJSONRequest(http.MethodPost, "/v1/execute/verify/canonical", map[string]any{
		"token":   "ignored",
		"request": map[string]any{},
	})
	verifyRecorder := httptest.NewRecorder()
	mux.ServeHTTP(verifyRecorder, verifyReq)
	if verifyRecorder.Code != http.StatusUnauthorized {
		t.Fatalf("expected verify 401 without header, got %d", verifyRecorder.Code)
	}

	recordReq := newJSONRequest(http.MethodPost, "/v1/state/actions", defaultActionRecord())
	recordRecorder := httptest.NewRecorder()
	mux.ServeHTTP(recordRecorder, recordReq)
	if recordRecorder.Code != http.StatusUnauthorized {
		t.Fatalf("expected state record 401 without header, got %d", recordRecorder.Code)
	}

	authorizedRecordReq := newJSONRequest(http.MethodPost, "/v1/state/actions", defaultActionRecord())
	authorizedRecordReq.Header.Set("X-Arbiter-Service-Key", "service-secret")
	authorizedRecordRecorder := httptest.NewRecorder()
	mux.ServeHTTP(authorizedRecordRecorder, authorizedRecordReq)
	if authorizedRecordRecorder.Code != http.StatusAccepted {
		t.Fatalf("expected state record 202 with header, got %d", authorizedRecordRecorder.Code)
	}
}

func TestServiceIntentLabelerAddsLabelWhenAvailable(t *testing.T) {
	t.Parallel()

	service := newTestServiceWithConfig(
		deciderFunc(func(_ context.Context, req schema.CanonicalRequest) (schema.Decision, error) {
			if req.IntentLabel != "ops.notification" {
				t.Fatalf("expected intent label to be set, got %q", req.IntentLabel)
			}
			return defaultAllowDecision("decision-intent"), nil
		}),
		state.NewMemoryStore(),
		Config{
			IntentLabeler: labelerFunc(func(_ context.Context, _ schema.CanonicalRequest) (string, error) {
				return "ops.notification", nil
			}),
		},
	)

	mux := http.NewServeMux()
	service.RegisterRoutes(mux)

	req := newJSONRequest(http.MethodPost, "/v1/intercept/openai", defaultOpenAIEnvelope())
	recorder := httptest.NewRecorder()
	mux.ServeHTTP(recorder, req)
	if recorder.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", recorder.Code, recorder.Body.String())
	}
}

func TestServiceIntentLabelerErrorsDoNotBlockDecision(t *testing.T) {
	t.Parallel()

	service := newTestServiceWithConfig(
		deciderFunc(func(_ context.Context, req schema.CanonicalRequest) (schema.Decision, error) {
			if req.IntentLabel != "" {
				t.Fatalf("expected empty intent label when labeler errors, got %q", req.IntentLabel)
			}
			return defaultAllowDecision("decision-intent-error"), nil
		}),
		state.NewMemoryStore(),
		Config{
			IntentLabeler: labelerFunc(func(_ context.Context, _ schema.CanonicalRequest) (string, error) {
				return "", errors.New("labeler unavailable")
			}),
		},
	)

	mux := http.NewServeMux()
	service.RegisterRoutes(mux)

	req := newJSONRequest(http.MethodPost, "/v1/intercept/openai", defaultOpenAIEnvelope())
	recorder := httptest.NewRecorder()
	mux.ServeHTTP(recorder, req)
	if recorder.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", recorder.Code, recorder.Body.String())
	}
}

func TestServiceInterceptOpenAI(t *testing.T) {
	t.Parallel()

	service := newTestService(deciderFunc(func(_ context.Context, req schema.CanonicalRequest) (schema.Decision, error) {
		if req.ToolName != "send_slack_message" {
			t.Fatalf("unexpected tool name: %s", req.ToolName)
		}
		return schema.Decision{
			Allow:         true,
			Reason:        "allowed",
			PolicyPackage: "arbiter.authz",
			PolicyVersion: "v1",
			DataRevision:  "rev-1",
			DecisionID:    "decision-1",
		}, nil
	}), state.NewMemoryStore())

	mux := http.NewServeMux()
	service.RegisterRoutes(mux)

	body, err := json.Marshal(translator.OpenAIEnvelope{
		Metadata: schema.Metadata{
			RequestID: "req-1",
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
	})
	if err != nil {
		t.Fatalf("marshal request: %v", err)
	}

	req := httptest.NewRequest(http.MethodPost, "/v1/intercept/openai", bytes.NewReader(body))
	recorder := httptest.NewRecorder()
	mux.ServeHTTP(recorder, req)

	if recorder.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", recorder.Code, recorder.Body.String())
	}

	var decision schema.SignedDecision
	if err := json.NewDecoder(recorder.Body).Decode(&decision); err != nil {
		t.Fatalf("decode response: %v", err)
	}

	if decision.Token == "" {
		t.Fatal("expected signed token in response")
	}
}

func TestServiceVerifyRejectsReplay(t *testing.T) {
	t.Parallel()

	service := newTestService(pdp.StaticDecider{
		Decision: schema.Decision{
			Allow:         true,
			Reason:        "allowed",
			PolicyPackage: "arbiter.authz",
			PolicyVersion: "v1",
			DataRevision:  "rev-1",
			DecisionID:    "decision-1",
		},
	}, state.NewMemoryStore())

	mux := http.NewServeMux()
	service.RegisterRoutes(mux)

	envelope := translator.OpenAIEnvelope{
		Metadata: schema.Metadata{
			RequestID: "req-1",
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

	interceptBody, _ := json.Marshal(envelope)
	interceptReq := httptest.NewRequest(http.MethodPost, "/v1/intercept/openai", bytes.NewReader(interceptBody))
	interceptRecorder := httptest.NewRecorder()
	mux.ServeHTTP(interceptRecorder, interceptReq)

	var signed schema.SignedDecision
	if err := json.NewDecoder(interceptRecorder.Body).Decode(&signed); err != nil {
		t.Fatalf("decode intercept response: %v", err)
	}

	verifyBody, _ := json.Marshal(map[string]any{
		"token":    signed.Token,
		"envelope": envelope,
	})

	verifyReq := httptest.NewRequest(http.MethodPost, "/v1/execute/verify/openai", bytes.NewReader(verifyBody))
	verifyRecorder := httptest.NewRecorder()
	mux.ServeHTTP(verifyRecorder, verifyReq)
	if verifyRecorder.Code != http.StatusOK {
		t.Fatalf("expected first verify to pass, got %d", verifyRecorder.Code)
	}

	replayReq := httptest.NewRequest(http.MethodPost, "/v1/execute/verify/openai", bytes.NewReader(verifyBody))
	replayRecorder := httptest.NewRecorder()
	mux.ServeHTTP(replayRecorder, replayReq)
	if replayRecorder.Code != http.StatusForbidden {
		t.Fatalf("expected replay verify to fail, got %d", replayRecorder.Code)
	}
}

func TestServiceRequiredContextUsesRecordedActions(t *testing.T) {
	t.Parallel()

	store := state.NewMemoryStore()
	service := newTestService(deciderFunc(func(_ context.Context, req schema.CanonicalRequest) (schema.Decision, error) {
		if len(req.PreviousActions) == 0 {
			return schema.Decision{
				Allow:         false,
				Reason:        "missing backup context",
				PolicyPackage: "arbiter.authz",
				PolicyVersion: "v1",
				DataRevision:  "rev-1",
				DecisionID:    "decision-1",
			}, pdp.ErrDeniedByPolicy
		}
		return schema.Decision{
			Allow:         true,
			Reason:        "allowed",
			PolicyPackage: "arbiter.authz",
			PolicyVersion: "v1",
			DataRevision:  "rev-1",
			DecisionID:    "decision-1",
		}, nil
	}), store)

	mux := http.NewServeMux()
	service.RegisterRoutes(mux)

	recordBody, _ := json.Marshal(state.ActionRecord{
		TenantID: "tenant-1",
		ActorID:  "actor-1",
		PreviousAction: schema.PreviousAction{
			ToolName: "backup_database",
			Outcome:  "allowed",
			At:       time.Now().UTC(),
		},
	})

	recordReq := httptest.NewRequest(http.MethodPost, "/v1/state/actions", bytes.NewReader(recordBody))
	recordRecorder := httptest.NewRecorder()
	mux.ServeHTTP(recordRecorder, recordReq)
	if recordRecorder.Code != http.StatusAccepted {
		t.Fatalf("expected record action accepted, got %d", recordRecorder.Code)
	}

	interceptBody, _ := json.Marshal(translator.OpenAIEnvelope{
		Metadata: schema.Metadata{
			RequestID: "req-2",
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

	req := httptest.NewRequest(http.MethodPost, "/v1/intercept/openai", bytes.NewReader(interceptBody))
	recorder := httptest.NewRecorder()
	mux.ServeHTTP(recorder, req)

	if recorder.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", recorder.Code, recorder.Body.String())
	}
}

func TestServiceStreamInterceptOpenAI(t *testing.T) {
	t.Parallel()

	service := newTestService(deciderFunc(func(_ context.Context, req schema.CanonicalRequest) (schema.Decision, error) {
		if req.ToolName != "send_slack_message" {
			t.Fatalf("unexpected tool name: %s", req.ToolName)
		}
		if string(req.Parameters) != `{"channel":"ops","message":"hello"}` {
			t.Fatalf("unexpected parameters: %s", string(req.Parameters))
		}
		return schema.Decision{
			Allow:         true,
			Reason:        "allowed",
			PolicyPackage: "arbiter.authz",
			PolicyVersion: "v1",
			DataRevision:  "rev-1",
			DecisionID:    "decision-stream",
		}, nil
	}), state.NewMemoryStore())

	mux := http.NewServeMux()
	service.RegisterRoutes(mux)

	body, _ := json.Marshal(translator.OpenAIStreamEnvelope{
		Metadata: schema.Metadata{
			RequestID: "req-stream",
			TenantID:  "tenant-1",
			Provider:  "openai",
		},
		AgentContext: schema.AgentContext{
			Actor: schema.Actor{ID: "actor-1"},
		},
		Chunks: []translator.OpenAIToolCallChunk{
			{ID: "call-1", Type: "function", FunctionName: "send_slack_message", ArgumentsDelta: `{"channel":"`},
			{ArgumentsDelta: `ops","message":"`},
			{ArgumentsDelta: `hello"}`},
		},
	})

	req := httptest.NewRequest(http.MethodPost, "/v1/intercept/openai/stream", bytes.NewReader(body))
	recorder := httptest.NewRecorder()
	mux.ServeHTTP(recorder, req)

	if recorder.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", recorder.Code, recorder.Body.String())
	}
}

func TestServiceInterceptAnthropic(t *testing.T) {
	t.Parallel()

	service := newTestService(pdp.StaticDecider{
		Decision: schema.Decision{
			Allow:         true,
			Reason:        "allowed",
			PolicyPackage: "arbiter.authz",
			PolicyVersion: "v1",
			DataRevision:  "rev-1",
			DecisionID:    "decision-anthropic",
		},
	}, state.NewMemoryStore())

	mux := http.NewServeMux()
	service.RegisterRoutes(mux)

	body, _ := json.Marshal(translator.AnthropicEnvelope{
		Metadata: schema.Metadata{
			RequestID: "req-a1",
			TenantID:  "tenant-1",
			Provider:  "anthropic",
		},
		AgentContext: schema.AgentContext{
			Actor: schema.Actor{ID: "actor-1"},
		},
		ToolUse: translator.AnthropicToolUse{
			ID:    "toolu_1",
			Name:  "send_slack_message",
			Input: []byte(`{"channel":"ops","message":"hello"}`),
		},
	})

	req := httptest.NewRequest(http.MethodPost, "/v1/intercept/anthropic", bytes.NewReader(body))
	recorder := httptest.NewRecorder()
	mux.ServeHTTP(recorder, req)
	if recorder.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", recorder.Code, recorder.Body.String())
	}
}

func TestServiceVerifyAnthropicRejectsReplay(t *testing.T) {
	t.Parallel()

	service := newTestService(pdp.StaticDecider{
		Decision: schema.Decision{
			Allow:         true,
			Reason:        "allowed",
			PolicyPackage: "arbiter.authz",
			PolicyVersion: "v1",
			DataRevision:  "rev-1",
			DecisionID:    "decision-anthropic-verify",
		},
	}, state.NewMemoryStore())

	mux := http.NewServeMux()
	service.RegisterRoutes(mux)

	envelope := translator.AnthropicEnvelope{
		Metadata: schema.Metadata{
			RequestID: "req-a2",
			TenantID:  "tenant-1",
			Provider:  "anthropic",
		},
		AgentContext: schema.AgentContext{
			Actor: schema.Actor{ID: "actor-1"},
		},
		ToolUse: translator.AnthropicToolUse{
			ID:    "toolu_1",
			Name:  "send_slack_message",
			Input: []byte(`{"channel":"ops","message":"hello"}`),
		},
	}

	interceptBody, _ := json.Marshal(envelope)
	interceptReq := httptest.NewRequest(http.MethodPost, "/v1/intercept/anthropic", bytes.NewReader(interceptBody))
	interceptRecorder := httptest.NewRecorder()
	mux.ServeHTTP(interceptRecorder, interceptReq)

	var signed schema.SignedDecision
	if err := json.NewDecoder(interceptRecorder.Body).Decode(&signed); err != nil {
		t.Fatalf("decode intercept response: %v", err)
	}

	verifyBody, _ := json.Marshal(map[string]any{
		"token":    signed.Token,
		"envelope": envelope,
	})

	verifyReq := httptest.NewRequest(http.MethodPost, "/v1/execute/verify/anthropic", bytes.NewReader(verifyBody))
	verifyRecorder := httptest.NewRecorder()
	mux.ServeHTTP(verifyRecorder, verifyReq)
	if verifyRecorder.Code != http.StatusOK {
		t.Fatalf("expected first verify to pass, got %d", verifyRecorder.Code)
	}

	replayReq := httptest.NewRequest(http.MethodPost, "/v1/execute/verify/anthropic", bytes.NewReader(verifyBody))
	replayRecorder := httptest.NewRecorder()
	mux.ServeHTTP(replayRecorder, replayReq)
	if replayRecorder.Code != http.StatusForbidden {
		t.Fatalf("expected replay verify to fail, got %d", replayRecorder.Code)
	}
}

func TestServiceInterceptGenericFramework(t *testing.T) {
	t.Parallel()

	service := newTestService(pdp.StaticDecider{
		Decision: schema.Decision{
			Allow:         true,
			Reason:        "allowed",
			PolicyPackage: "arbiter.authz",
			PolicyVersion: "v1",
			DataRevision:  "rev-1",
			DecisionID:    "decision-framework-generic",
		},
	}, state.NewMemoryStore())

	mux := http.NewServeMux()
	service.RegisterRoutes(mux)

	body, _ := json.Marshal(translator.GenericFrameworkEnvelope{
		Metadata: schema.Metadata{
			RequestID: "req-fw-1",
			TenantID:  "tenant-1",
			Provider:  "framework",
		},
		AgentContext: schema.AgentContext{
			Actor: schema.Actor{ID: "actor-1"},
		},
		ToolName:   "send_slack_message",
		Parameters: []byte(`{"channel":"ops","message":"hello"}`),
	})

	req := httptest.NewRequest(http.MethodPost, "/v1/intercept/framework/generic", bytes.NewReader(body))
	recorder := httptest.NewRecorder()
	mux.ServeHTTP(recorder, req)
	if recorder.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", recorder.Code, recorder.Body.String())
	}
}

func TestServiceStreamRaceRejectsToolOutsideFastGate(t *testing.T) {
	t.Parallel()

	service := NewService(Config{
		MaxBodyBytes:      4096,
		MaxParameterBytes: 1024,
		DecisionTimeout:   time.Second,
		StateLookupLimit:  5,
		FastAllowedTools:  []string{"send_slack_message"},
	}, state.NewMemoryStore(), pdp.StaticDecider{
		Decision: schema.Decision{
			Allow:         true,
			Reason:        "allowed",
			PolicyPackage: "arbiter.authz",
			PolicyVersion: "v1",
			DataRevision:  "rev-1",
			DecisionID:    "decision-fast-gate",
		},
	}, executorauth.NewIssuerVerifier([]byte("top-secret"), "arbiter", time.Minute, executorauth.NewMemoryReplayCache()), nil, nil)

	mux := http.NewServeMux()
	service.RegisterRoutes(mux)

	body, _ := json.Marshal(translator.OpenAIStreamEnvelope{
		Metadata: schema.Metadata{
			RequestID: "req-stream-fast",
			TenantID:  "tenant-1",
			Provider:  "openai",
		},
		AgentContext: schema.AgentContext{
			Actor: schema.Actor{ID: "actor-1"},
		},
		Chunks: []translator.OpenAIToolCallChunk{
			{ID: "call-1", Type: "function", FunctionName: "create_stripe_refund", ArgumentsDelta: `{"amount_cents":100}`},
		},
	})

	req := httptest.NewRequest(http.MethodPost, "/v1/intercept/openai/stream/race", bytes.NewReader(body))
	recorder := httptest.NewRecorder()
	mux.ServeHTTP(recorder, req)

	if recorder.Code != http.StatusForbidden {
		t.Fatalf("expected 403, got %d: %s", recorder.Code, recorder.Body.String())
	}
}

func TestServiceInjectsTraceIDFromContext(t *testing.T) {
	t.Parallel()

	service := newTestService(deciderFunc(func(_ context.Context, req schema.CanonicalRequest) (schema.Decision, error) {
		if req.Metadata.TraceID == "" {
			t.Fatal("expected trace id on canonical request")
		}
		return schema.Decision{
			Allow:         true,
			Reason:        "allowed",
			PolicyPackage: "arbiter.authz",
			PolicyVersion: "v1",
			DataRevision:  "rev-1",
			DecisionID:    "decision-trace",
		}, nil
	}), state.NewMemoryStore())

	mux := http.NewServeMux()
	service.RegisterRoutes(mux)
	handler := telemetry.WithTrace(mux)

	body, _ := json.Marshal(translator.OpenAIEnvelope{
		Metadata: schema.Metadata{
			RequestID: "req-trace-1",
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
	})

	req := httptest.NewRequest(http.MethodPost, "/v1/intercept/openai", bytes.NewReader(body))
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, req)

	if recorder.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", recorder.Code, recorder.Body.String())
	}
	if recorder.Header().Get(telemetry.HeaderTraceID) == "" {
		t.Fatal("expected trace id header")
	}
}

func TestServiceVerifyCanonicalRejectsReplay(t *testing.T) {
	t.Parallel()

	service := newTestService(pdp.StaticDecider{
		Decision: schema.Decision{
			Allow:         true,
			Reason:        "allowed",
			PolicyPackage: "arbiter.authz",
			PolicyVersion: "v1",
			DataRevision:  "rev-1",
			DecisionID:    "decision-canonical-verify",
		},
	}, state.NewMemoryStore())

	mux := http.NewServeMux()
	service.RegisterRoutes(mux)

	envelope := translator.GenericFrameworkEnvelope{
		Metadata: schema.Metadata{
			RequestID: "req-fw-2",
			TenantID:  "tenant-1",
			Provider:  "framework",
		},
		AgentContext: schema.AgentContext{
			Actor: schema.Actor{ID: "actor-1"},
		},
		ToolName:   "run_sql_query",
		Parameters: []byte(`{"query":"select 1"}`),
	}

	interceptBody, _ := json.Marshal(envelope)
	interceptReq := httptest.NewRequest(http.MethodPost, "/v1/intercept/framework/generic", bytes.NewReader(interceptBody))
	interceptRecorder := httptest.NewRecorder()
	mux.ServeHTTP(interceptRecorder, interceptReq)

	var signed schema.SignedDecision
	if err := json.NewDecoder(interceptRecorder.Body).Decode(&signed); err != nil {
		t.Fatalf("decode intercept response: %v", err)
	}

	req, err := translator.NormalizeGenericFramework(envelope, 1024)
	if err != nil {
		t.Fatalf("normalize request: %v", err)
	}

	verifyBody, _ := json.Marshal(map[string]any{
		"token":   signed.Token,
		"request": req,
	})

	verifyReq := httptest.NewRequest(http.MethodPost, "/v1/execute/verify/canonical", bytes.NewReader(verifyBody))
	verifyRecorder := httptest.NewRecorder()
	mux.ServeHTTP(verifyRecorder, verifyReq)
	if verifyRecorder.Code != http.StatusOK {
		t.Fatalf("expected first verify to pass, got %d", verifyRecorder.Code)
	}

	replayReq := httptest.NewRequest(http.MethodPost, "/v1/execute/verify/canonical", bytes.NewReader(verifyBody))
	replayRecorder := httptest.NewRecorder()
	mux.ServeHTTP(replayRecorder, replayReq)
	if replayRecorder.Code != http.StatusForbidden {
		t.Fatalf("expected replay verify to fail, got %d", replayRecorder.Code)
	}
}
