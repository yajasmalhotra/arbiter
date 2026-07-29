package interceptor

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"arbiter/internal/audit"
	"arbiter/internal/enforcement"
	"arbiter/internal/executorauth"
	"arbiter/internal/identity"
	"arbiter/internal/intent"
	"arbiter/internal/pdp"
	"arbiter/internal/schema"
	"arbiter/internal/state"
	"arbiter/internal/telemetry"
	"arbiter/internal/translator"
)

type Config struct {
	MaxBodyBytes                  int64
	MaxParameterBytes             int
	DecisionTimeout               time.Duration
	StateLookupLimit              int
	FastAllowedTools              []string
	GatewaySharedKey              string
	ServiceSharedKey              string
	Authenticator                 identity.Authenticator
	RequireAuthenticatedPrincipal bool
	IntentLabeler                 intent.Labeler
}

type Service struct {
	config           Config
	stateStore       state.Store
	decider          pdp.Decider
	issuer           *executorauth.IssuerVerifier
	auditRecorder    audit.Recorder
	engine           *enforcement.Engine
	fastToolSet      map[string]struct{}
	gatewaySharedKey string
	serviceSharedKey string
	authenticator    identity.Authenticator
}

type verifyExecutionRequest struct {
	Token    string                    `json:"token"`
	Envelope translator.OpenAIEnvelope `json:"envelope"`
}

type verifyAnthropicExecutionRequest struct {
	Token    string                       `json:"token"`
	Envelope translator.AnthropicEnvelope `json:"envelope"`
}

type verifyCanonicalExecutionRequest struct {
	Token   string                  `json:"token"`
	Request schema.CanonicalRequest `json:"request"`
}

type errorResponse struct {
	Error string `json:"error"`
}

type readyChecker interface {
	Ready(context.Context) error
}

func NewService(config Config, stateStore state.Store, decider pdp.Decider, issuer *executorauth.IssuerVerifier, auditRecorder audit.Recorder, telemetryRecorder telemetry.Recorder) *Service {
	if config.MaxBodyBytes <= 0 {
		config.MaxBodyBytes = 1 << 20
	}
	if config.MaxParameterBytes <= 0 {
		config.MaxParameterBytes = 32 << 10
	}
	if config.DecisionTimeout <= 0 {
		config.DecisionTimeout = 2 * time.Second
	}
	if config.StateLookupLimit <= 0 {
		config.StateLookupLimit = 10
	}
	if config.IntentLabeler == nil {
		config.IntentLabeler = intent.NopLabeler{}
	}

	fastToolSet := make(map[string]struct{}, len(config.FastAllowedTools))
	for _, tool := range config.FastAllowedTools {
		trimmed := strings.TrimSpace(tool)
		if trimmed == "" {
			continue
		}
		fastToolSet[trimmed] = struct{}{}
	}

	return &Service{
		config:        config,
		stateStore:    stateStore,
		decider:       decider,
		issuer:        issuer,
		auditRecorder: auditRecorder,
		engine: enforcement.New(enforcement.Config{
			DecisionTimeout:  config.DecisionTimeout,
			StateLookupLimit: config.StateLookupLimit,
			IntentLabeler:    config.IntentLabeler,
		}, stateStore, decider, issuer, auditRecorder, telemetryRecorder),
		fastToolSet:      fastToolSet,
		gatewaySharedKey: strings.TrimSpace(config.GatewaySharedKey),
		serviceSharedKey: strings.TrimSpace(config.ServiceSharedKey),
		authenticator:    config.Authenticator,
	}
}

func (s *Service) RegisterRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /healthz", s.handleHealthz)
	mux.HandleFunc("GET /readyz", s.handleReadyz)
	mux.HandleFunc("POST /v1/intercept/openai", s.handleOpenAIIntercept)
	mux.HandleFunc("POST /v1/intercept/openai/stream", s.handleOpenAIStreamIntercept)
	mux.HandleFunc("POST /v1/intercept/openai/stream/race", s.handleOpenAIStreamRaceIntercept)
	mux.HandleFunc("POST /v1/intercept/anthropic", s.handleAnthropicIntercept)
	mux.HandleFunc("POST /v1/intercept/framework/generic", s.handleGenericFrameworkIntercept)
	mux.HandleFunc("POST /v1/intercept/framework/langchain", s.handleLangChainIntercept)
	mux.HandleFunc("POST /v1/intercept/a2a/tasks/send", s.handleA2ATaskSendIntercept)
	mux.HandleFunc("POST /v1/execute/verify/openai", s.handleOpenAIVerify)
	mux.HandleFunc("POST /v1/execute/verify/anthropic", s.handleAnthropicVerify)
	mux.HandleFunc("POST /v1/execute/verify/canonical", s.handleCanonicalVerify)
	mux.HandleFunc("POST /v1/state/actions", s.handleRecordAction)
}

func (s *Service) handleHealthz(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (s *Service) handleReadyz(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), s.config.DecisionTimeout)
	defer cancel()
	if s.config.RequireAuthenticatedPrincipal && s.authenticator == nil {
		writeError(w, http.StatusServiceUnavailable, errors.New("workload identity is required but no authenticator is configured"))
		return
	}

	if checker, ok := s.stateStore.(readyChecker); ok {
		if err := checker.Ready(ctx); err != nil {
			writeError(w, http.StatusServiceUnavailable, err)
			return
		}
	}

	if checker, ok := s.decider.(readyChecker); ok {
		if err := checker.Ready(ctx); err != nil {
			writeError(w, http.StatusServiceUnavailable, err)
			return
		}
	}
	if err := s.issuer.Ready(ctx); err != nil {
		writeError(w, http.StatusServiceUnavailable, err)
		return
	}
	if checker, ok := s.auditRecorder.(audit.ReadyChecker); ok {
		if err := checker.Ready(ctx); err != nil {
			writeError(w, http.StatusServiceUnavailable, err)
			return
		}
	}

	writeJSON(w, http.StatusOK, map[string]string{"status": "ready"})
}

func (s *Service) handleOpenAIIntercept(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeGateway(w, r) {
		return
	}

	var envelope translator.OpenAIEnvelope
	if err := decodeJSON(w, r, s.config.MaxBodyBytes, &envelope); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	envelope.Metadata.TraceID = traceIDForRequest(r, envelope.Metadata.TraceID)

	s.handleOpenAIInterceptEnvelope(w, r, envelope)
}

func (s *Service) handleOpenAIStreamIntercept(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeGateway(w, r) {
		return
	}

	var streamEnvelope translator.OpenAIStreamEnvelope
	if err := decodeJSON(w, r, s.config.MaxBodyBytes, &streamEnvelope); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	streamEnvelope.Metadata.TraceID = traceIDForRequest(r, streamEnvelope.Metadata.TraceID)

	toolCall, err := translator.ReconstructOpenAIToolCall(streamEnvelope.Chunks, s.config.MaxParameterBytes)
	if err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}

	envelope := translator.OpenAIEnvelope{
		Metadata:        streamEnvelope.Metadata,
		AgentContext:    streamEnvelope.AgentContext,
		RequiredContext: streamEnvelope.RequiredContext,
		ToolCall:        toolCall,
	}
	s.handleOpenAIInterceptEnvelope(w, r, envelope)
}

func (s *Service) handleOpenAIStreamRaceIntercept(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeGateway(w, r) {
		return
	}

	var streamEnvelope translator.OpenAIStreamEnvelope
	if err := decodeJSON(w, r, s.config.MaxBodyBytes, &streamEnvelope); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	streamEnvelope.Metadata.TraceID = traceIDForRequest(r, streamEnvelope.Metadata.TraceID)
	if len(streamEnvelope.Chunks) == 0 {
		writeError(w, http.StatusBadRequest, translator.ErrEmptyStreamChunks)
		return
	}

	assembler := translator.NewOpenAIToolCallAssembler(s.config.MaxParameterBytes)
	permissionCh := make(chan error, 1)
	permissionStarted := false

	for _, chunk := range streamEnvelope.Chunks {
		if err := assembler.AddChunk(chunk); err != nil {
			writeError(w, http.StatusBadRequest, err)
			return
		}

		toolName := assembler.ToolName()
		if !permissionStarted && toolName != "" {
			permissionStarted = true
			go func(name string) {
				permissionCh <- s.fastPermissionCheck(name)
			}(toolName)
		}
	}

	toolCall, err := assembler.Build()
	if err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}

	if permissionStarted {
		if err := <-permissionCh; err != nil {
			writeError(w, http.StatusForbidden, err)
			return
		}
	}

	envelope := translator.OpenAIEnvelope{
		Metadata:        streamEnvelope.Metadata,
		AgentContext:    streamEnvelope.AgentContext,
		RequiredContext: streamEnvelope.RequiredContext,
		ToolCall:        toolCall,
	}
	s.handleOpenAIInterceptEnvelope(w, r, envelope)
}

func (s *Service) handleOpenAIInterceptEnvelope(w http.ResponseWriter, r *http.Request, envelope translator.OpenAIEnvelope) {
	req, err := translator.NormalizeOpenAI(envelope, s.config.MaxParameterBytes)
	if err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	s.handleCanonicalIntercept(w, r, req)
}

func (s *Service) handleOpenAIVerify(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeService(w, r) {
		return
	}

	var reqBody verifyExecutionRequest
	if err := decodeJSON(w, r, s.config.MaxBodyBytes, &reqBody); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}

	req, err := translator.NormalizeOpenAI(reqBody.Envelope, s.config.MaxParameterBytes)
	if err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}

	if _, err := s.issuer.Verify(r.Context(), reqBody.Token, req); err != nil {
		status := http.StatusForbidden
		if !errors.Is(err, executorauth.ErrInvalidToken) && !errors.Is(err, executorauth.ErrReplayDetected) {
			status = http.StatusServiceUnavailable
		}
		writeError(w, status, err)
		return
	}

	writeJSON(w, http.StatusOK, map[string]string{"status": "verified"})
}

func (s *Service) handleAnthropicIntercept(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeGateway(w, r) {
		return
	}

	var envelope translator.AnthropicEnvelope
	if err := decodeJSON(w, r, s.config.MaxBodyBytes, &envelope); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	envelope.Metadata.TraceID = traceIDForRequest(r, envelope.Metadata.TraceID)

	req, err := translator.NormalizeAnthropic(envelope, s.config.MaxParameterBytes)
	if err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}

	s.handleCanonicalIntercept(w, r, req)
}

func (s *Service) handleAnthropicVerify(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeService(w, r) {
		return
	}

	var reqBody verifyAnthropicExecutionRequest
	if err := decodeJSON(w, r, s.config.MaxBodyBytes, &reqBody); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}

	req, err := translator.NormalizeAnthropic(reqBody.Envelope, s.config.MaxParameterBytes)
	if err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}

	if _, err := s.issuer.Verify(r.Context(), reqBody.Token, req); err != nil {
		status := http.StatusForbidden
		if !errors.Is(err, executorauth.ErrInvalidToken) && !errors.Is(err, executorauth.ErrReplayDetected) {
			status = http.StatusServiceUnavailable
		}
		writeError(w, status, err)
		return
	}

	writeJSON(w, http.StatusOK, map[string]string{"status": "verified"})
}

func (s *Service) handleGenericFrameworkIntercept(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeGateway(w, r) {
		return
	}

	var envelope translator.GenericFrameworkEnvelope
	if err := decodeJSON(w, r, s.config.MaxBodyBytes, &envelope); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	envelope.Metadata.TraceID = traceIDForRequest(r, envelope.Metadata.TraceID)

	req, err := translator.NormalizeGenericFramework(envelope, s.config.MaxParameterBytes)
	if err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}

	s.handleCanonicalIntercept(w, r, req)
}

func (s *Service) handleLangChainIntercept(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeGateway(w, r) {
		return
	}

	var envelope translator.LangChainEnvelope
	if err := decodeJSON(w, r, s.config.MaxBodyBytes, &envelope); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	envelope.Metadata.TraceID = traceIDForRequest(r, envelope.Metadata.TraceID)

	req, err := translator.NormalizeLangChain(envelope, s.config.MaxParameterBytes)
	if err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}

	s.handleCanonicalIntercept(w, r, req)
}

func (s *Service) handleA2ATaskSendIntercept(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeGateway(w, r) {
		return
	}
	var envelope translator.A2ATaskSendEnvelope
	if err := decodeJSON(w, r, s.config.MaxBodyBytes, &envelope); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	envelope.Metadata.TraceID = traceIDForRequest(r, envelope.Metadata.TraceID)
	req, err := translator.NormalizeA2ATaskSend(envelope, s.config.MaxParameterBytes)
	if err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	s.handleCanonicalIntercept(w, r, req)
}

func (s *Service) handleCanonicalVerify(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeService(w, r) {
		return
	}

	var reqBody verifyCanonicalExecutionRequest
	if err := decodeJSON(w, r, s.config.MaxBodyBytes, &reqBody); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}

	reqBody.Request.Normalize()
	if err := reqBody.Request.Validate(s.config.MaxParameterBytes); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}

	if _, err := s.issuer.Verify(r.Context(), reqBody.Token, reqBody.Request); err != nil {
		status := http.StatusForbidden
		if !errors.Is(err, executorauth.ErrInvalidToken) && !errors.Is(err, executorauth.ErrReplayDetected) {
			status = http.StatusServiceUnavailable
		}
		writeError(w, status, err)
		return
	}

	writeJSON(w, http.StatusOK, map[string]string{"status": "verified"})
}

func (s *Service) handleRecordAction(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeService(w, r) {
		return
	}

	var record state.ActionRecord
	if err := decodeJSON(w, r, s.config.MaxBodyBytes, &record); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}

	if err := s.stateStore.RecordAction(r.Context(), record); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}

	writeJSON(w, http.StatusAccepted, map[string]string{"status": "recorded"})
}

func (s *Service) authorizeGateway(w http.ResponseWriter, r *http.Request) bool {
	return s.authorizeWithKey(w, r, s.gatewaySharedKey, "X-Arbiter-Gateway-Key")
}

func (s *Service) authorizeService(w http.ResponseWriter, r *http.Request) bool {
	return s.authorizeWithKey(w, r, s.serviceSharedKey, "X-Arbiter-Service-Key")
}

func (s *Service) authorizeWithKey(w http.ResponseWriter, r *http.Request, expected, header string) bool {
	if expected == "" {
		return true
	}
	if subtle.ConstantTimeCompare([]byte(r.Header.Get(header)), []byte(expected)) != 1 {
		writeJSON(w, http.StatusUnauthorized, errorResponse{Error: "unauthorized"})
		return false
	}
	return true
}

func (s *Service) handleCanonicalIntercept(w http.ResponseWriter, r *http.Request, req schema.CanonicalRequest) {
	if s.config.RequireAuthenticatedPrincipal && s.authenticator == nil {
		writeJSON(w, http.StatusUnauthorized, errorResponse{Error: "authenticated workload identity is required"})
		return
	}
	if s.authenticator != nil {
		principal, err := s.authenticator.Authenticate(r)
		if err != nil {
			writeJSON(w, http.StatusUnauthorized, errorResponse{Error: "unauthenticated principal"})
			return
		}
		// Provider envelopes are action descriptions, not identity assertions.
		// When workload authentication is configured, replace their tenant and
		// actor with verified identity before policy evaluation and permit minting.
		req.Metadata.TenantID = principal.TenantID
		req.AgentContext.Actor = schema.Actor{ID: principal.Subject, Type: principal.Kind}
		req.Principal = &principal
	}
	req.Metadata.TraceID = traceIDForRequest(r, req.Metadata.TraceID)
	result, err := s.engine.Enforce(r.Context(), req)
	if err != nil {
		status := http.StatusServiceUnavailable
		if enforcement.IsDenied(err) {
			status = http.StatusForbidden
		}
		writeJSON(w, status, schema.SignedDecision{Decision: result.Decision})
		return
	}
	writeJSON(w, http.StatusOK, schema.SignedDecision{
		Decision: result.Decision,
		Token:    result.Token,
	})
}

func (s *Service) fastPermissionCheck(toolName string) error {
	if len(s.fastToolSet) == 0 {
		return nil
	}
	if _, ok := s.fastToolSet[toolName]; ok {
		return nil
	}
	return errors.New("tool denied by fast permission gate")
}

func traceIDForRequest(r *http.Request, current string) string {
	if current != "" {
		return current
	}
	return telemetry.TraceIDFromContext(r.Context())
}

func decodeJSON(w http.ResponseWriter, r *http.Request, maxBytes int64, target any) error {
	r.Body = http.MaxBytesReader(w, r.Body, maxBytes)

	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return err
	}

	if decoder.More() {
		return errors.New("unexpected trailing json data")
	}

	return nil
}

func writeError(w http.ResponseWriter, status int, err error) {
	writeJSON(w, status, errorResponse{Error: err.Error()})
}

func writeJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}
