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

const (
	LegacySchemaVersion  = "v1alpha1"
	CurrentSchemaVersion = "v1alpha2"
)

var (
	ErrMissingRequestID         = errors.New("missing request id")
	ErrMissingTenantID          = errors.New("missing tenant id")
	ErrMissingActorID           = errors.New("missing actor id")
	ErrMissingToolName          = errors.New("missing tool name")
	ErrInvalidParams            = errors.New("parameters must be valid json")
	ErrUnsupportedSchemaVersion = errors.New("unsupported schema version")
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

// Protocol identifies the wire protocol that produced a canonical request.
// It is optional for v1alpha1 compatibility and required by protocol-native
// adapters such as the MCP gateway.
type Protocol struct {
	Name    string `json:"name"`
	Version string `json:"version,omitempty"`
}

// Target disambiguates a tool from the remote system that exposes it. Tool
// names alone are not an authority boundary: separate MCP servers can expose
// identically named tools with materially different side effects.
type Target struct {
	ServerID  string `json:"server_id,omitempty"`
	ServerURI string `json:"server_uri,omitempty"`
}

// Obligation is a policy-owned prerequisite for a decision. Only Arbiter's
// policy can create an obligation; protocol clients may provide hints but can
// never suppress a policy requirement by omitting a request field.
type Obligation struct {
	Type  string `json:"type"`
	Scope string `json:"scope,omitempty"`
	Limit int    `json:"limit,omitempty"`
	Class string `json:"class,omitempty"`
}

// Principal is the authenticated caller identity. It is intentionally
// separate from provider-supplied actor metadata, which must never become an
// authorization principal merely because it appears in a tool-call envelope.
type Principal struct {
	Subject    string `json:"subject"`
	TenantID   string `json:"tenant_id"`
	Kind       string `json:"kind,omitempty"`
	Issuer     string `json:"issuer,omitempty"`
	AuthMethod string `json:"auth_method,omitempty"`
	WorkloadID string `json:"workload_id,omitempty"`
	HumanOwner string `json:"human_owner,omitempty"`
}

// DelegationLink describes one verified, attenuating hop from a parent agent
// to the agent performing the current action.
type DelegationLink struct {
	ParentSubject   string `json:"parent_subject"`
	DelegateSubject string `json:"delegate_subject"`
	TaskID          string `json:"task_id,omitempty"`
	GrantID         string `json:"grant_id,omitempty"`
	MayDelegate     bool   `json:"may_delegate,omitempty"`
}

// Capability is the verified, non-secret summary of a scoped authority grant.
// The raw credential is never copied into requests, audit events, or permits.
type Capability struct {
	GrantID        string   `json:"grant_id"`
	Subject        string   `json:"subject"`
	TenantID       string   `json:"tenant_id"`
	ServerIDs      []string `json:"server_ids,omitempty"`
	ToolNames      []string `json:"tool_names,omitempty"`
	MaxAmountCents int64    `json:"max_amount_cents,omitempty"`
	MayDelegate    bool     `json:"may_delegate,omitempty"`
	WorkloadID     string   `json:"workload_id,omitempty"`
}

// Approval is a verified, non-secret receipt for one human-approved action.
// ActionHash is calculated without the approval itself to avoid a circular
// signature dependency, then the completed request hash binds the receipt to
// the final execution permit.
type Approval struct {
	ApprovalID string `json:"approval_id"`
	ActionHash string `json:"action_hash"`
	Class      string `json:"class,omitempty"`
	ApprovedBy string `json:"approved_by,omitempty"`
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
	Protocol        *Protocol        `json:"protocol,omitempty"`
	Target          *Target          `json:"target,omitempty"`
	Operation       string           `json:"operation,omitempty"`
	Obligations     []Obligation     `json:"obligations,omitempty"`
	Principal       *Principal       `json:"principal,omitempty"`
	Delegation      []DelegationLink `json:"delegation,omitempty"`
	Capability      *Capability      `json:"capability,omitempty"`
	Approval        *Approval        `json:"approval,omitempty"`
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
	case r.SchemaVersion != LegacySchemaVersion && r.SchemaVersion != CurrentSchemaVersion:
		return ErrUnsupportedSchemaVersion
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
	return r.hash(true)
}

// ActionHash is the stable identity of a requested side effect before a human
// approval receipt is attached.
func (r CanonicalRequest) ActionHash() (string, error) {
	return r.hash(false)
}

func (r CanonicalRequest) hash(includeApproval bool) (string, error) {
	params, err := normalizeJSON(r.Parameters)
	if err != nil {
		return "", err
	}

	legacyPayload := struct {
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
	}
	if r.SchemaVersion == LegacySchemaVersion || r.SchemaVersion == "" {
		payload, err := json.Marshal(legacyPayload)
		if err != nil {
			return "", err
		}
		sum := sha256.Sum256(payload)
		return hex.EncodeToString(sum[:]), nil
	}

	payload, err := json.Marshal(struct {
		SchemaVersion string           `json:"schema_version"`
		RequestID     string           `json:"request_id"`
		TenantID      string           `json:"tenant_id"`
		ActorID       string           `json:"actor_id"`
		ToolName      string           `json:"tool_name"`
		Parameters    json.RawMessage  `json:"parameters"`
		Protocol      *Protocol        `json:"protocol,omitempty"`
		Target        *Target          `json:"target,omitempty"`
		Operation     string           `json:"operation"`
		Obligations   []Obligation     `json:"obligations,omitempty"`
		Principal     *Principal       `json:"principal,omitempty"`
		Delegation    []DelegationLink `json:"delegation,omitempty"`
		Capability    *Capability      `json:"capability,omitempty"`
		Approval      *Approval        `json:"approval,omitempty"`
	}{
		SchemaVersion: r.SchemaVersion,
		RequestID:     r.Metadata.RequestID,
		TenantID:      r.Metadata.TenantID,
		ActorID:       r.AgentContext.Actor.ID,
		ToolName:      r.ToolName,
		Parameters:    params,
		Protocol:      r.Protocol,
		Target:        r.Target,
		Operation:     r.Operation,
		Obligations:   r.Obligations,
		Principal:     r.Principal,
		Delegation:    r.Delegation,
		Capability:    r.Capability,
		Approval:      approvalForHash(r.Approval, includeApproval),
	})
	if err != nil {
		return "", err
	}

	sum := sha256.Sum256(payload)
	return hex.EncodeToString(sum[:]), nil
}

func approvalForHash(approval *Approval, include bool) *Approval {
	if !include {
		return nil
	}
	return approval
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

func (r CanonicalRequest) TargetServerID() string {
	if r.Target == nil {
		return ""
	}
	return r.Target.ServerID
}
