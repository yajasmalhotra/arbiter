package translator

import (
	"encoding/json"
	"errors"
	"strings"

	"arbiter/internal/schema"
)

var ErrMissingToolUse = errors.New("missing anthropic tool use block")

type AnthropicEnvelope struct {
	Metadata        schema.Metadata     `json:"metadata"`
	AgentContext    schema.AgentContext `json:"agent_context"`
	RequiredContext []string            `json:"required_context,omitempty"`
	ToolUse         AnthropicToolUse    `json:"tool_use"`
}

type AnthropicToolUse struct {
	ID    string          `json:"id,omitempty"`
	Name  string          `json:"name"`
	Input json.RawMessage `json:"input"`
}

func NormalizeAnthropic(env AnthropicEnvelope, maxParameterBytes int) (schema.CanonicalRequest, error) {
	if strings.TrimSpace(env.ToolUse.Name) == "" {
		return schema.CanonicalRequest{}, ErrMissingToolUse
	}
	if len(env.ToolUse.Input) == 0 {
		env.ToolUse.Input = []byte(`{}`)
	}

	req := schema.CanonicalRequest{
		SchemaVersion:   schema.CurrentSchemaVersion,
		Metadata:        env.Metadata,
		AgentContext:    env.AgentContext,
		ToolName:        env.ToolUse.Name,
		Parameters:      env.ToolUse.Input,
		RequiredContext: env.RequiredContext,
	}
	req.Normalize()

	if err := req.Validate(maxParameterBytes); err != nil {
		return schema.CanonicalRequest{}, err
	}
	return req, nil
}
