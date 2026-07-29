// Package enforcement contains the protocol-neutral Arbiter decision flow.
//
// Protocol adapters are responsible only for authenticating and normalizing
// their native requests. Every adapter then calls Engine.Enforce so state
// enrichment, policy evaluation, permit issuance, audit, and metrics remain
// identical across HTTP, MCP, and future A2A boundaries.
package enforcement

import (
	"context"
	"errors"
	"strings"
	"time"

	"arbiter/internal/audit"
	"arbiter/internal/executorauth"
	"arbiter/internal/intent"
	"arbiter/internal/obligations"
	"arbiter/internal/pdp"
	"arbiter/internal/schema"
	"arbiter/internal/state"
	"arbiter/internal/telemetry"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
)

type Config struct {
	DecisionTimeout        time.Duration
	StateLookupLimit       int
	IntentLabeler          intent.Labeler
	PolicyOwnedObligations bool
	ObligationResolver     obligations.Resolver
}

type Result struct {
	Decision schema.Decision
	Token    string
}

type Engine struct {
	config             Config
	state              state.Store
	decider            pdp.Decider
	issuer             *executorauth.IssuerVerifier
	audit              audit.Recorder
	telemetry          telemetry.Recorder
	labeler            intent.Labeler
	obligationsEnabled bool
	obligationResolver obligations.Resolver
}

func New(config Config, stateStore state.Store, decider pdp.Decider, issuer *executorauth.IssuerVerifier, auditRecorder audit.Recorder, telemetryRecorder telemetry.Recorder) *Engine {
	if config.DecisionTimeout <= 0 {
		config.DecisionTimeout = 2 * time.Second
	}
	if config.StateLookupLimit <= 0 {
		config.StateLookupLimit = 10
	}
	if config.IntentLabeler == nil {
		config.IntentLabeler = intent.NopLabeler{}
	}
	if telemetryRecorder == nil {
		telemetryRecorder = telemetry.NopRecorder{}
	}
	if config.PolicyOwnedObligations && config.ObligationResolver == nil {
		config.ObligationResolver = obligations.New(stateStore, config.StateLookupLimit)
	}

	return &Engine{
		config:             config,
		state:              stateStore,
		decider:            decider,
		issuer:             issuer,
		audit:              auditRecorder,
		telemetry:          telemetryRecorder,
		labeler:            config.IntentLabeler,
		obligationsEnabled: config.PolicyOwnedObligations,
		obligationResolver: config.ObligationResolver,
	}
}

// Enforce evaluates one normalized request and issues an execution permit when
// it is allowed. A policy denial returns both its decision and
// pdp.ErrDeniedByPolicy; all other failures are operational failures.
func (e *Engine) Enforce(ctx context.Context, req schema.CanonicalRequest) (Result, error) {
	return e.evaluate(ctx, req, true)
}

// Preview evaluates a normalized request without minting an execution permit.
// It is intended for non-side-effecting protocol operations such as MCP tool
// discovery, where policy should be able to hide unavailable tools.
func (e *Engine) Preview(ctx context.Context, req schema.CanonicalRequest) (schema.Decision, error) {
	result, err := e.evaluate(ctx, req, false)
	return result.Decision, err
}

// Consume verifies and marks a permit as used. Protocol gateways call this
// immediately before forwarding an approved request to the side-effecting
// executor.
func (e *Engine) Consume(ctx context.Context, token string, req schema.CanonicalRequest) error {
	_, err := e.issuer.Verify(ctx, token, req)
	return err
}

func (e *Engine) evaluate(ctx context.Context, req schema.CanonicalRequest, issuePermit bool) (Result, error) {
	startedAt := time.Now()
	ctx, span := otel.Tracer("arbiter/enforcement").Start(ctx, "enforcement.decision")
	span.SetAttributes(
		attribute.String("request_id", req.Metadata.RequestID),
		attribute.String("trace_id", req.Metadata.TraceID),
		attribute.String("tenant_id", req.Metadata.TenantID),
		attribute.String("tool_name", req.ToolName),
	)
	defer span.End()

	if req.IntentLabel == "" && e.labeler != nil {
		label, err := e.labeler.Label(ctx, req)
		if err == nil && strings.TrimSpace(label) != "" {
			req.IntentLabel = strings.TrimSpace(label)
		}
	}

	if e.obligationsEnabled {
		planner, ok := e.decider.(pdp.ObligationPlanner)
		if !ok {
			err := errors.New("policy backend does not support obligations")
			span.RecordError(err)
			return Result{}, err
		}
		requested, err := planner.PlanObligations(ctx, req)
		if err != nil {
			span.RecordError(err)
			return Result{}, err
		}
		if e.obligationResolver == nil {
			err := errors.New("policy obligations enabled without a resolver")
			span.RecordError(err)
			return Result{}, err
		}
		req, err = e.obligationResolver.Resolve(ctx, req, requested)
		if err != nil {
			span.RecordError(err)
			return Result{}, err
		}
	} else if len(req.RequiredContext) > 0 {
		// Legacy adapters may still supply required_context. This remains only for
		// v1alpha1 compatibility while deployments migrate to policy-owned
		// obligations.
		actions, err := e.state.RecentActions(ctx, state.LookupRequest{
			TenantID:  req.Metadata.TenantID,
			ActorID:   req.AgentContext.Actor.ID,
			SessionID: req.Metadata.SessionID,
			Limit:     e.config.StateLookupLimit,
		})
		if err != nil {
			span.RecordError(err)
			return Result{}, err
		}
		req.PreviousActions = actions
	}

	decisionCtx, cancel := context.WithTimeout(ctx, e.config.DecisionTimeout)
	defer cancel()
	decision, err := e.decider.Decide(decisionCtx, req)
	if err != nil {
		span.RecordError(err)
		e.record(decisionCtx, req, decision, startedAt)
		return Result{Decision: decision}, err
	}
	// Decider implementations should return pdp.ErrDeniedByPolicy for a deny,
	// but the permit boundary cannot rely on every adapter or test double doing
	// so. An explicit false decision is never eligible for a permit.
	if !decision.Allow {
		span.RecordError(pdp.ErrDeniedByPolicy)
		e.record(decisionCtx, req, decision, startedAt)
		return Result{Decision: decision}, pdp.ErrDeniedByPolicy
	}

	if !issuePermit {
		e.record(decisionCtx, req, decision, startedAt)
		return Result{Decision: decision}, nil
	}

	token, err := e.issuer.Issue(req, decision)
	if err != nil {
		span.RecordError(err)
		return Result{Decision: decision}, err
	}

	e.record(decisionCtx, req, decision, startedAt)
	return Result{Decision: decision, Token: token}, nil
}

func (e *Engine) record(ctx context.Context, req schema.CanonicalRequest, decision schema.Decision, startedAt time.Time) {
	latency := time.Since(startedAt)
	e.telemetry.ObserveDecision(req.ToolName, decision.Allow, latency)
	if e.audit == nil {
		return
	}
	e.audit.Record(ctx, audit.Event{
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

// IsDenied reports whether an error represents a policy decision rather than
// an operational failure.
func IsDenied(err error) bool {
	return errors.Is(err, pdp.ErrDeniedByPolicy)
}
