package translator

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"arbiter/internal/schema"
)

var ErrUnsupportedToolType = errors.New("unsupported tool type")

type OpenAIEnvelope struct {
	Metadata        schema.Metadata     `json:"metadata"`
	AgentContext    schema.AgentContext `json:"agent_context"`
	RequiredContext []string            `json:"required_context,omitempty"`
	ToolCall        OpenAIToolCall      `json:"tool_call"`
}

type OpenAIToolCall struct {
	ID       string                 `json:"id,omitempty"`
	Type     string                 `json:"type"`
	Function OpenAIFunctionToolCall `json:"function"`
}

type OpenAIFunctionToolCall struct {
	Name      string `json:"name"`
	Arguments string `json:"arguments"`
}

func NormalizeOpenAI(env OpenAIEnvelope, maxParameterBytes int) (schema.CanonicalRequest, error) {
	toolType := strings.TrimSpace(env.ToolCall.Type)
	if toolType != "" && toolType != "function" {
		return schema.CanonicalRequest{}, ErrUnsupportedToolType
	}

	args := strings.TrimSpace(env.ToolCall.Function.Arguments)
	if args == "" {
		args = "{}"
	}

	var parsed json.RawMessage
	if err := json.Unmarshal([]byte(args), &parsed); err != nil {
		return schema.CanonicalRequest{}, fmt.Errorf("parse arguments: %w", err)
	}

	req := schema.CanonicalRequest{
		SchemaVersion:   schema.CurrentSchemaVersion,
		Metadata:        env.Metadata,
		AgentContext:    env.AgentContext,
		ToolName:        env.ToolCall.Function.Name,
		Parameters:      parsed,
		RequiredContext: env.RequiredContext,
	}
	req.Normalize()

	if err := req.Validate(maxParameterBytes); err != nil {
		return schema.CanonicalRequest{}, err
	}

	return req, nil
}
