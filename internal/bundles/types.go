package bundles

import "time"

type RolloutState string

const (
	RolloutDraft      RolloutState = "draft"
	RolloutShadow     RolloutState = "shadow"
	RolloutCanary     RolloutState = "canary"
	RolloutEnforced   RolloutState = "enforced"
	RolloutRolledBack RolloutState = "rolled_back"
)

type Status string

const (
	StatusDraft      Status = "draft"
	StatusPublished  Status = "published"
	StatusActive     Status = "active"
	StatusRolledBack Status = "rolled_back"
)

type PolicyRevision struct {
	ID             string            `json:"id"`
	PolicyIDs      []string          `json:"policy_ids"`
	PolicyVersions map[string]string `json:"policy_versions"`
	CreatedBy      string            `json:"created_by"`
	CreatedAt      time.Time         `json:"created_at"`
}

type DataRevision struct {
	ID        string         `json:"id"`
	Data      map[string]any `json:"data"`
	CreatedBy string         `json:"created_by"`
	CreatedAt time.Time      `json:"created_at"`
}

type PolicySnapshot struct {
	ID          string         `json:"id"`
	Name        string         `json:"name"`
	PackageName string         `json:"package_name"`
	Version     string         `json:"version"`
	Rules       map[string]any `json:"rules"`
}

type Snapshot struct {
	Policies []PolicySnapshot `json:"policies"`
	Data     map[string]any   `json:"data"`
}

type Artifact struct {
	ID               string       `json:"id"`
	PolicyRevisionID string       `json:"policy_revision_id"`
	DataRevisionID   string       `json:"data_revision_id"`
	RolloutState     RolloutState `json:"rollout_state"`
	Digest           string       `json:"digest"`
	Status           Status       `json:"status"`
	CreatedBy        string       `json:"created_by"`
	CreatedAt        time.Time    `json:"created_at"`
	Snapshot         Snapshot     `json:"snapshot"`
}

type Activation struct {
	ID          string    `json:"id"`
	ArtifactID  string    `json:"artifact_id"`
	State       Status    `json:"state"`
	ActivatedBy string    `json:"activated_by"`
	ActivatedAt time.Time `json:"activated_at"`
	Notes       string    `json:"notes,omitempty"`
}
