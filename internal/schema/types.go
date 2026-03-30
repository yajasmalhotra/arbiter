package schema

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
)

const CurrentSchemaVersion = "v1alpha1"

var (
	ErrMissingRequestID = errors.New("missing request id")
	ErrMissingTenantID  = errors.New("missing tenant id")
	ErrMissingActorID   = errors.New("missing actor id")
	ErrMissingToolName  = errors.New("missing tool name")
	ErrInvalidParams    = errors.New("parameters must be valid json")
)

type Metadata struct {
	RequestID string `json:"request_id"`
	TenantID  string `json:"tenant_id"`
	SessionID string `json:"session_id,omitempty"`
	TraceID   string `json:"trace_id,omitempty"`
	Provider  string `json:"provider,omitempty"`
}

type Actor struct {
	ID    string   `json:"id"`
	Type  string   `json:"type,omitempty"`
	Roles []string `json:"roles,omitempty"`
}

type AgentContext struct {
	AgentID string            `json:"agent_id,omitempty"`
	RunID   string            `json:"run_id,omitempty"`
	Actor   Actor             `json:"actor"`
	Labels  map[string]string `json:"labels,omitempty"`
}

type PreviousAction struct {
	ToolName string    `json:"tool_name"`
	Outcome  string    `json:"outcome"`
	At       time.Time `json:"at"`
}

type CanonicalRequest struct {
	SchemaVersion   string           `json:"schema_version"`
	Metadata        Metadata         `json:"metadata"`
	AgentContext    AgentContext     `json:"agent_context"`
	ToolName        string           `json:"tool_name"`
	Parameters      json.RawMessage  `json:"parameters"`
	RequiredContext []string         `json:"required_context,omitempty"`
	PreviousActions []PreviousAction `json:"previous_actions,omitempty"`
	IntentLabel     string           `json:"intent_label,omitempty"`
}

type Decision struct {
	Allow                  bool   `json:"allow"`
	Reason                 string `json:"reason"`
	PolicyPackage          string `json:"policy_package"`
	PolicyVersion          string `json:"policy_version"`
	DataRevision           string `json:"data_revision"`
	DecisionID             string `json:"decision_id"`
	RequiredContextMissing bool   `json:"required_context_missing,omitempty"`
}

type SignedDecision struct {
	Decision Decision `json:"decision"`
	Token    string   `json:"token,omitempty"`
}

func (r *CanonicalRequest) Normalize() {
	if r.SchemaVersion == "" {
		r.SchemaVersion = CurrentSchemaVersion
	}
	r.ToolName = strings.TrimSpace(r.ToolName)
}

func (r CanonicalRequest) Validate(maxParameterBytes int) error {
	switch {
	case strings.TrimSpace(r.Metadata.RequestID) == "":
		return ErrMissingRequestID
	case strings.TrimSpace(r.Metadata.TenantID) == "":
		return ErrMissingTenantID
	case strings.TrimSpace(r.AgentContext.Actor.ID) == "":
		return ErrMissingActorID
	case strings.TrimSpace(r.ToolName) == "":
		return ErrMissingToolName
	}

	if len(r.Parameters) == 0 {
		return ErrInvalidParams
	}
	if maxParameterBytes > 0 && len(r.Parameters) > maxParameterBytes {
		return fmt.Errorf("parameters exceed max size: %d", maxParameterBytes)
	}

	var normalized any
	if err := json.Unmarshal(r.Parameters, &normalized); err != nil {
		return ErrInvalidParams
	}

	return nil
}

func (r CanonicalRequest) Hash() (string, error) {
	params, err := normalizeJSON(r.Parameters)
	if err != nil {
		return "", err
	}

	payload, err := json.Marshal(struct {
		SchemaVersion string          `json:"schema_version"`
		RequestID     string          `json:"request_id"`
		TenantID      string          `json:"tenant_id"`
		ActorID       string          `json:"actor_id"`
		ToolName      string          `json:"tool_name"`
		Parameters    json.RawMessage `json:"parameters"`
	}{
		SchemaVersion: r.SchemaVersion,
		RequestID:     r.Metadata.RequestID,
		TenantID:      r.Metadata.TenantID,
		ActorID:       r.AgentContext.Actor.ID,
		ToolName:      r.ToolName,
		Parameters:    params,
	})
	if err != nil {
		return "", err
	}

	sum := sha256.Sum256(payload)
	return hex.EncodeToString(sum[:]), nil
}

func normalizeJSON(raw json.RawMessage) (json.RawMessage, error) {
	var value any
	if err := json.Unmarshal(raw, &value); err != nil {
		return nil, err
	}

	normalized, err := json.Marshal(value)
	if err != nil {
		return nil, err
	}

	return normalized, nil
}
