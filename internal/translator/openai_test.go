package translator

import (
	"testing"

	"arbiter/internal/schema"
)

func TestNormalizeOpenAISuccess(t *testing.T) {
	t.Parallel()

	req, err := NormalizeOpenAI(OpenAIEnvelope{
		Metadata: schema.Metadata{
			RequestID: "req-1",
			TenantID:  "tenant-1",
			Provider:  "openai",
		},
		AgentContext: schema.AgentContext{
			Actor: schema.Actor{ID: "actor-1"},
		},
		ToolCall: OpenAIToolCall{
			Type: "function",
			Function: OpenAIFunctionToolCall{
				Name:      "send_slack_message",
				Arguments: `{"channel":"ops","message":"hello"}`,
			},
		},
	}, 1024)
	if err != nil {
		t.Fatalf("normalize: %v", err)
	}

	if req.ToolName != "send_slack_message" {
		t.Fatalf("unexpected tool name: %s", req.ToolName)
	}

	if string(req.Parameters) != `{"channel":"ops","message":"hello"}` {
		t.Fatalf("unexpected parameters: %s", string(req.Parameters))
	}
}

func TestNormalizeOpenAIRejectsMalformedArguments(t *testing.T) {
	t.Parallel()

	_, err := NormalizeOpenAI(OpenAIEnvelope{
		Metadata: schema.Metadata{
			RequestID: "req-1",
			TenantID:  "tenant-1",
		},
		AgentContext: schema.AgentContext{
			Actor: schema.Actor{ID: "actor-1"},
		},
		ToolCall: OpenAIToolCall{
			Type: "function",
			Function: OpenAIFunctionToolCall{
				Name:      "send_slack_message",
				Arguments: `{"channel":`,
			},
		},
	}, 1024)
	if err == nil {
		t.Fatal("expected malformed argument error")
	}
}

func TestNormalizeOpenAIRejectsUnsupportedType(t *testing.T) {
	t.Parallel()

	_, err := NormalizeOpenAI(OpenAIEnvelope{
		Metadata: schema.Metadata{
			RequestID: "req-1",
			TenantID:  "tenant-1",
		},
		AgentContext: schema.AgentContext{
			Actor: schema.Actor{ID: "actor-1"},
		},
		ToolCall: OpenAIToolCall{
			Type: "computer_use",
			Function: OpenAIFunctionToolCall{
				Name:      "send_slack_message",
				Arguments: `{}`,
			},
		},
	}, 1024)
	if err != ErrUnsupportedToolType {
		t.Fatalf("expected unsupported tool type error, got %v", err)
	}
}
