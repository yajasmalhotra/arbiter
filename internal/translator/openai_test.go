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

func TestReconstructOpenAIToolCall(t *testing.T) {
	t.Parallel()

	toolCall, err := ReconstructOpenAIToolCall([]OpenAIToolCallChunk{
		{ID: "call-1", Type: "function", FunctionName: "send_slack_message", ArgumentsDelta: `{"channel":"`},
		{ArgumentsDelta: `ops","message":"`},
		{ArgumentsDelta: `hello"}`},
	}, 1024)
	if err != nil {
		t.Fatalf("reconstruct: %v", err)
	}

	if toolCall.Function.Name != "send_slack_message" {
		t.Fatalf("unexpected function name: %s", toolCall.Function.Name)
	}
	if toolCall.Function.Arguments != `{"channel":"ops","message":"hello"}` {
		t.Fatalf("unexpected arguments: %s", toolCall.Function.Arguments)
	}
}

func TestReconstructOpenAIToolCallRejectsMalformedJSON(t *testing.T) {
	t.Parallel()

	_, err := ReconstructOpenAIToolCall([]OpenAIToolCallChunk{
		{Type: "function", FunctionName: "send_slack_message", ArgumentsDelta: `{"channel":"ops"`},
	}, 1024)
	if err == nil {
		t.Fatal("expected malformed streamed arguments error")
	}
}

func TestReconstructOpenAIToolCallRejectsOversizedPayload(t *testing.T) {
	t.Parallel()

	_, err := ReconstructOpenAIToolCall([]OpenAIToolCallChunk{
		{Type: "function", FunctionName: "send_slack_message", ArgumentsDelta: `{"message":"abcdefghijklmnopqrstuvwxyz"}`},
	}, 10)
	if err == nil {
		t.Fatal("expected oversized streamed argument error")
	}
}

func TestOpenAIToolCallAssemblerBuildsIncrementally(t *testing.T) {
	t.Parallel()

	assembler := NewOpenAIToolCallAssembler(1024)
	if err := assembler.AddChunk(OpenAIToolCallChunk{
		ID:           "call-1",
		Type:         "function",
		FunctionName: "run_sql_query",
	}); err != nil {
		t.Fatalf("add name chunk: %v", err)
	}
	if assembler.ToolName() != "run_sql_query" {
		t.Fatalf("unexpected tool name: %s", assembler.ToolName())
	}

	if err := assembler.AddChunk(OpenAIToolCallChunk{ArgumentsDelta: `{"query":"select 1"}`}); err != nil {
		t.Fatalf("add args chunk: %v", err)
	}

	toolCall, err := assembler.Build()
	if err != nil {
		t.Fatalf("build: %v", err)
	}
	if toolCall.Function.Name != "run_sql_query" {
		t.Fatalf("unexpected function name: %s", toolCall.Function.Name)
	}
}
