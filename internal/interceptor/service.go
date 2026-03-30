package interceptor

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"arbiter/internal/audit"
	"arbiter/internal/executorauth"
	"arbiter/internal/pdp"
	"arbiter/internal/schema"
	"arbiter/internal/state"
	"arbiter/internal/telemetry"
	"arbiter/internal/translator"
)

type Config struct {
	MaxBodyBytes      int64
	MaxParameterBytes int
	DecisionTimeout   time.Duration
	StateLookupLimit  int
	FastAllowedTools  []string
}

type Service struct {
	config      Config
	stateStore  state.Store
	decider     pdp.Decider
	issuer      *executorauth.IssuerVerifier
	audit       audit.Recorder
	telemetry   telemetry.Recorder
	fastToolSet map[string]struct{}
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
	if telemetryRecorder == nil {
		telemetryRecorder = telemetry.NopRecorder{}
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
		config:      config,
		stateStore:  stateStore,
		decider:     decider,
		issuer:      issuer,
		audit:       auditRecorder,
		telemetry:   telemetryRecorder,
		fastToolSet: fastToolSet,
	}
}

func (s *Service) RegisterRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /healthz", s.handleHealthz)
	mux.HandleFunc("POST /v1/intercept/openai", s.handleOpenAIIntercept)
	mux.HandleFunc("POST /v1/intercept/openai/stream", s.handleOpenAIStreamIntercept)
	mux.HandleFunc("POST /v1/intercept/openai/stream/race", s.handleOpenAIStreamRaceIntercept)
	mux.HandleFunc("POST /v1/intercept/anthropic", s.handleAnthropicIntercept)
	mux.HandleFunc("POST /v1/intercept/framework/generic", s.handleGenericFrameworkIntercept)
	mux.HandleFunc("POST /v1/intercept/framework/langchain", s.handleLangChainIntercept)
	mux.HandleFunc("POST /v1/execute/verify/openai", s.handleOpenAIVerify)
	mux.HandleFunc("POST /v1/execute/verify/anthropic", s.handleAnthropicVerify)
	mux.HandleFunc("POST /v1/execute/verify/canonical", s.handleCanonicalVerify)
	mux.HandleFunc("POST /v1/state/actions", s.handleRecordAction)
}

func (s *Service) handleHealthz(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (s *Service) handleOpenAIIntercept(w http.ResponseWriter, r *http.Request) {
	var envelope translator.OpenAIEnvelope
	if err := decodeJSON(w, r, s.config.MaxBodyBytes, &envelope); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	envelope.Metadata.TraceID = traceIDForRequest(r, envelope.Metadata.TraceID)

	s.handleOpenAIInterceptEnvelope(w, r, envelope)
}

func (s *Service) handleOpenAIStreamIntercept(w http.ResponseWriter, r *http.Request) {
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

func (s *Service) handleCanonicalVerify(w http.ResponseWriter, r *http.Request) {
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

func (s *Service) handleCanonicalIntercept(w http.ResponseWriter, r *http.Request, req schema.CanonicalRequest) {
	start := time.Now()
	req.Metadata.TraceID = traceIDForRequest(r, req.Metadata.TraceID)

	var err error
	if len(req.RequiredContext) > 0 {
		req.PreviousActions, err = s.stateStore.RecentActions(r.Context(), state.LookupRequest{
			TenantID:  req.Metadata.TenantID,
			ActorID:   req.AgentContext.Actor.ID,
			SessionID: req.Metadata.SessionID,
			Limit:     s.config.StateLookupLimit,
		})
		if err != nil {
			writeError(w, http.StatusServiceUnavailable, err)
			return
		}
	}

	ctx, cancel := context.WithTimeout(r.Context(), s.config.DecisionTimeout)
	defer cancel()

	decision, err := s.decider.Decide(ctx, req)
	if err != nil {
		status := http.StatusServiceUnavailable
		if errors.Is(err, pdp.ErrDeniedByPolicy) {
			status = http.StatusForbidden
		}
		s.recordDecision(ctx, req, decision, start)
		writeJSON(w, status, schema.SignedDecision{Decision: decision})
		return
	}

	token, err := s.issuer.Issue(req, decision)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}

	s.recordDecision(ctx, req, decision, start)
	writeJSON(w, http.StatusOK, schema.SignedDecision{
		Decision: decision,
		Token:    token,
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

func (s *Service) recordDecision(ctx context.Context, req schema.CanonicalRequest, decision schema.Decision, startedAt time.Time) {
	latency := time.Since(startedAt)
	s.telemetry.ObserveDecision(req.ToolName, decision.Allow, latency)
	if s.audit == nil {
		return
	}

	s.audit.Record(ctx, audit.Event{
		DecisionID:    decision.DecisionID,
		RequestID:     req.Metadata.RequestID,
		TraceID:       req.Metadata.TraceID,
		TenantID:      req.Metadata.TenantID,
		ToolName:      req.ToolName,
		Allow:         decision.Allow,
		Reason:        decision.Reason,
		PolicyVersion: decision.PolicyVersion,
		Latency:       latency,
	})
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
