package translator

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"arbiter/internal/schema"
)

var ErrUnsupportedToolType = errors.New("unsupported tool type")
var ErrMissingToolName = errors.New("missing tool name")

type OpenAIEnvelope struct {
	Metadata        schema.Metadata     `json:"metadata"`
	AgentContext    schema.AgentContext `json:"agent_context"`
	RequiredContext []string            `json:"required_context,omitempty"`
	ToolCall        OpenAIToolCall      `json:"tool_call"`
}

type OpenAIStreamEnvelope struct {
	Metadata        schema.Metadata       `json:"metadata"`
	AgentContext    schema.AgentContext   `json:"agent_context"`
	RequiredContext []string              `json:"required_context,omitempty"`
	Chunks          []OpenAIToolCallChunk `json:"chunks"`
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

type OpenAIToolCallChunk struct {
	ID             string `json:"id,omitempty"`
	Type           string `json:"type,omitempty"`
	FunctionName   string `json:"function_name,omitempty"`
	ArgumentsDelta string `json:"arguments_delta,omitempty"`
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

func ReconstructOpenAIToolCall(chunks []OpenAIToolCallChunk, maxArgumentBytes int) (OpenAIToolCall, error) {
	if len(chunks) == 0 {
		return OpenAIToolCall{}, schema.ErrInvalidParams
	}
	if maxArgumentBytes <= 0 {
		maxArgumentBytes = 32 << 10
	}

	var (
		toolCall OpenAIToolCall
		builder  strings.Builder
	)
	builder.Grow(min(maxArgumentBytes, 4096))

	for _, chunk := range chunks {
		if toolCall.ID == "" && chunk.ID != "" {
			toolCall.ID = chunk.ID
		}

		toolType := strings.TrimSpace(chunk.Type)
		if toolCall.Type == "" && toolType != "" {
			toolCall.Type = toolType
		}
		if toolCall.Type != "" && toolType != "" && toolCall.Type != toolType {
			return OpenAIToolCall{}, ErrUnsupportedToolType
		}

		if toolCall.Function.Name == "" && strings.TrimSpace(chunk.FunctionName) != "" {
			toolCall.Function.Name = chunk.FunctionName
		}

		if chunk.ArgumentsDelta != "" {
			if builder.Len()+len(chunk.ArgumentsDelta) > maxArgumentBytes {
				return OpenAIToolCall{}, fmt.Errorf("streamed arguments exceed max size: %d", maxArgumentBytes)
			}
			builder.WriteString(chunk.ArgumentsDelta)
		}
	}

	if toolCall.Function.Name == "" {
		return OpenAIToolCall{}, ErrMissingToolName
	}
	if toolCall.Type == "" {
		toolCall.Type = "function"
	}

	args := strings.TrimSpace(builder.String())
	if args == "" {
		args = "{}"
	}
	toolCall.Function.Arguments = args

	var parsed json.RawMessage
	if err := json.Unmarshal([]byte(args), &parsed); err != nil {
		return OpenAIToolCall{}, fmt.Errorf("parse streamed arguments: %w", err)
	}

	return toolCall, nil
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
