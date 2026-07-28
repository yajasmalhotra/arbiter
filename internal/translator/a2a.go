package translator

import (
	"encoding/json"
	"errors"
	"strings"

	"arbiter/internal/schema"
)

var ErrMissingA2ATarget = errors.New("missing A2A target agent")

// A2ATaskSendEnvelope is the Arbiter adapter envelope for an A2A task-send
// operation. The task payload remains opaque JSON; Arbiter governs the target
// agent and delegation boundary rather than attempting to interpret messages.
type A2ATaskSendEnvelope struct {
	Metadata     schema.Metadata     `json:"metadata"`
	AgentContext schema.AgentContext `json:"agent_context"`
	Target       A2AAgentRef         `json:"target"`
	Task         A2ATask             `json:"task"`
}

type A2AAgentRef struct {
	ID       string `json:"id"`
	Endpoint string `json:"endpoint,omitempty"`
}

type A2ATask struct {
	ID      string          `json:"id,omitempty"`
	Message json.RawMessage `json:"message,omitempty"`
}

func NormalizeA2ATaskSend(env A2ATaskSendEnvelope, maxParameterBytes int) (schema.CanonicalRequest, error) {
	if strings.TrimSpace(env.Target.ID) == "" {
		return schema.CanonicalRequest{}, ErrMissingA2ATarget
	}
	if len(env.Task.Message) == 0 {
		env.Task.Message = []byte(`{}`)
	}
	var message any
	if err := json.Unmarshal(env.Task.Message, &message); err != nil {
		return schema.CanonicalRequest{}, err
	}
	parameters, err := json.Marshal(map[string]any{"task_id": env.Task.ID, "message": message})
	if err != nil {
		return schema.CanonicalRequest{}, err
	}
	req := schema.CanonicalRequest{
		SchemaVersion: schema.CurrentSchemaVersion,
		Metadata:      env.Metadata,
		AgentContext:  env.AgentContext,
		ToolName:      "a2a_send_task",
		Parameters:    parameters,
		Protocol:      &schema.Protocol{Name: "a2a"},
		Target:        &schema.Target{ServerID: strings.TrimSpace(env.Target.ID), ServerURI: strings.TrimSpace(env.Target.Endpoint)},
		Operation:     "a2a.tasks/send",
	}
	req.Normalize()
	if err := req.Validate(maxParameterBytes); err != nil {
		return schema.CanonicalRequest{}, err
	}
	return req, nil
}
