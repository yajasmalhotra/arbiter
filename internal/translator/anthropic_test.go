package translator

import (
	"testing"

	"arbiter/internal/schema"
)

func TestNormalizeAnthropic(t *testing.T) {
	t.Parallel()

	req, err := NormalizeAnthropic(AnthropicEnvelope{
		Metadata: schema.Metadata{
			RequestID: "req-1",
			TenantID:  "tenant-1",
			Provider:  "anthropic",
		},
		AgentContext: schema.AgentContext{
			Actor: schema.Actor{ID: "actor-1"},
		},
		ToolUse: AnthropicToolUse{
			ID:    "toolu_1",
			Name:  "send_slack_message",
			Input: []byte(`{"channel":"ops","message":"hello"}`),
		},
	}, 1024)
	if err != nil {
		t.Fatalf("normalize anthropic: %v", err)
	}

	if req.ToolName != "send_slack_message" {
		t.Fatalf("unexpected tool name: %s", req.ToolName)
	}
}

func TestNormalizeAnthropicRejectsMissingToolName(t *testing.T) {
	t.Parallel()

	_, err := NormalizeAnthropic(AnthropicEnvelope{
		Metadata: schema.Metadata{
			RequestID: "req-1",
			TenantID:  "tenant-1",
		},
		AgentContext: schema.AgentContext{
			Actor: schema.Actor{ID: "actor-1"},
		},
		ToolUse: AnthropicToolUse{
			Input: []byte(`{"channel":"ops"}`),
		},
	}, 1024)
	if err != ErrMissingToolUse {
		t.Fatalf("expected missing tool use error, got %v", err)
	}
}
