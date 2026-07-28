// Package obligations resolves the bounded, trusted context requested by
// policy. It intentionally contains a closed resolver registry: policies name
// resolver types, never arbitrary network locations.
package obligations

import (
	"context"
	"fmt"

	"arbiter/internal/schema"
	"arbiter/internal/state"
)

const (
	RecentActions = "recent_actions"
	Approval      = "approval"
)

type Resolver interface {
	Resolve(context.Context, schema.CanonicalRequest, []schema.Obligation) (schema.CanonicalRequest, error)
}

type Registry struct {
	stateStore state.Store
	maxLimit   int
}

func New(stateStore state.Store, maxLimit int) *Registry {
	if maxLimit <= 0 {
		maxLimit = 10
	}
	return &Registry{stateStore: stateStore, maxLimit: maxLimit}
}

func (r *Registry) Resolve(ctx context.Context, req schema.CanonicalRequest, requested []schema.Obligation) (schema.CanonicalRequest, error) {
	req.Obligations = append([]schema.Obligation(nil), requested...)
	for _, obligation := range requested {
		switch obligation.Type {
		case RecentActions:
			if r.stateStore == nil {
				return schema.CanonicalRequest{}, fmt.Errorf("resolve %s: state store unavailable", obligation.Type)
			}
			limit := obligation.Limit
			if limit <= 0 || limit > r.maxLimit {
				limit = r.maxLimit
			}
			actions, err := r.stateStore.RecentActions(ctx, state.LookupRequest{
				TenantID:  req.Metadata.TenantID,
				ActorID:   req.AgentContext.Actor.ID,
				SessionID: req.Metadata.SessionID,
				Limit:     limit,
			})
			if err != nil {
				return schema.CanonicalRequest{}, fmt.Errorf("resolve %s: %w", obligation.Type, err)
			}
			req.PreviousActions = actions
		case Approval:
			if req.Approval == nil || req.Approval.ApprovalID == "" {
				return schema.CanonicalRequest{}, fmt.Errorf("resolve %s: missing verified approval", obligation.Type)
			}
			if obligation.Class != "" && req.Approval.Class != obligation.Class {
				return schema.CanonicalRequest{}, fmt.Errorf("resolve %s: approval class mismatch", obligation.Type)
			}
		default:
			return schema.CanonicalRequest{}, fmt.Errorf("unsupported policy obligation: %s", obligation.Type)
		}
	}
	return req, nil
}
