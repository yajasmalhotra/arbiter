package translator

import (
	"encoding/json"
	"errors"
	"strings"

	"arbiter/internal/schema"
)

var ErrMissingFrameworkToolName = errors.New("missing framework tool name")

type GenericFrameworkEnvelope struct {
	SchemaVersion   string              `json:"schema_version,omitempty"`
	Metadata        schema.Metadata     `json:"metadata"`
	AgentContext    schema.AgentContext `json:"agent_context"`
	RequiredContext []string            `json:"required_context,omitempty"`
	ToolName        string              `json:"tool_name"`
	Parameters      json.RawMessage     `json:"parameters"`
}

type LangChainEnvelope struct {
	Metadata        schema.Metadata     `json:"metadata"`
	AgentContext    schema.AgentContext `json:"agent_context"`
	RequiredContext []string            `json:"required_context,omitempty"`
	Invocation      LangChainInvocation `json:"invocation"`
}

type LangChainInvocation struct {
	Tool  string          `json:"tool"`
	Input json.RawMessage `json:"input"`
}

func NormalizeGenericFramework(env GenericFrameworkEnvelope, maxParameterBytes int) (schema.CanonicalRequest, error) {
	if strings.TrimSpace(env.ToolName) == "" {
		return schema.CanonicalRequest{}, ErrMissingFrameworkToolName
	}
	if len(env.Parameters) == 0 {
		env.Parameters = []byte(`{}`)
	}

	req := schema.CanonicalRequest{
		SchemaVersion:   env.SchemaVersion,
		Metadata:        env.Metadata,
		AgentContext:    env.AgentContext,
		ToolName:        env.ToolName,
		Parameters:      env.Parameters,
		RequiredContext: env.RequiredContext,
	}
	req.Normalize()
	if err := req.Validate(maxParameterBytes); err != nil {
		return schema.CanonicalRequest{}, err
	}
	return req, nil
}

func NormalizeLangChain(env LangChainEnvelope, maxParameterBytes int) (schema.CanonicalRequest, error) {
	return NormalizeGenericFramework(GenericFrameworkEnvelope{
		Metadata:        env.Metadata,
		AgentContext:    env.AgentContext,
		RequiredContext: env.RequiredContext,
		ToolName:        env.Invocation.Tool,
		Parameters:      env.Invocation.Input,
	}, maxParameterBytes)
}
