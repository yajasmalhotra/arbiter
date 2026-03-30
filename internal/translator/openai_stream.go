package translator

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
)

var ErrEmptyStreamChunks = errors.New("empty stream chunks")

type OpenAIToolCallAssembler struct {
	maxArgumentBytes int
	toolCall         OpenAIToolCall
	builder          strings.Builder
}

func NewOpenAIToolCallAssembler(maxArgumentBytes int) *OpenAIToolCallAssembler {
	if maxArgumentBytes <= 0 {
		maxArgumentBytes = 32 << 10
	}

	assembler := &OpenAIToolCallAssembler{
		maxArgumentBytes: maxArgumentBytes,
	}
	assembler.builder.Grow(min(maxArgumentBytes, 4096))
	return assembler
}

func (a *OpenAIToolCallAssembler) AddChunk(chunk OpenAIToolCallChunk) error {
	if a.toolCall.ID == "" && chunk.ID != "" {
		a.toolCall.ID = chunk.ID
	}

	toolType := strings.TrimSpace(chunk.Type)
	if a.toolCall.Type == "" && toolType != "" {
		a.toolCall.Type = toolType
	}
	if a.toolCall.Type != "" && toolType != "" && a.toolCall.Type != toolType {
		return ErrUnsupportedToolType
	}

	if a.toolCall.Function.Name == "" && strings.TrimSpace(chunk.FunctionName) != "" {
		a.toolCall.Function.Name = chunk.FunctionName
	}

	if chunk.ArgumentsDelta != "" {
		if a.builder.Len()+len(chunk.ArgumentsDelta) > a.maxArgumentBytes {
			return fmt.Errorf("streamed arguments exceed max size: %d", a.maxArgumentBytes)
		}
		a.builder.WriteString(chunk.ArgumentsDelta)
	}

	return nil
}

func (a *OpenAIToolCallAssembler) ToolName() string {
	return a.toolCall.Function.Name
}

func (a *OpenAIToolCallAssembler) Build() (OpenAIToolCall, error) {
	if a.toolCall.Function.Name == "" {
		return OpenAIToolCall{}, ErrMissingToolName
	}
	if a.toolCall.Type == "" {
		a.toolCall.Type = "function"
	}

	args := strings.TrimSpace(a.builder.String())
	if args == "" {
		args = "{}"
	}
	a.toolCall.Function.Arguments = args

	var parsed json.RawMessage
	if err := json.Unmarshal([]byte(args), &parsed); err != nil {
		return OpenAIToolCall{}, fmt.Errorf("parse streamed arguments: %w", err)
	}

	return a.toolCall, nil
}

func ReconstructOpenAIToolCall(chunks []OpenAIToolCallChunk, maxArgumentBytes int) (OpenAIToolCall, error) {
	if len(chunks) == 0 {
		return OpenAIToolCall{}, ErrEmptyStreamChunks
	}

	assembler := NewOpenAIToolCallAssembler(maxArgumentBytes)
	for _, chunk := range chunks {
		if err := assembler.AddChunk(chunk); err != nil {
			return OpenAIToolCall{}, err
		}
	}
	return assembler.Build()
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
