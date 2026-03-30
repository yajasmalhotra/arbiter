package translator

import (
	"testing"

	"arbiter/internal/schema"
)

func TestNormalizeGenericFramework(t *testing.T) {
	t.Parallel()

	req, err := NormalizeGenericFramework(GenericFrameworkEnvelope{
		Metadata: schema.Metadata{
			RequestID: "req-fw-1",
			TenantID:  "tenant-1",
			Provider:  "framework",
		},
		AgentContext: schema.AgentContext{
			Actor: schema.Actor{ID: "actor-1"},
		},
		ToolName:   "send_slack_message",
		Parameters: []byte(`{"channel":"ops","message":"hello"}`),
	}, 1024)
	if err != nil {
		t.Fatalf("normalize framework: %v", err)
	}

	if req.ToolName != "send_slack_message" {
		t.Fatalf("unexpected tool name: %s", req.ToolName)
	}
}

func TestNormalizeLangChain(t *testing.T) {
	t.Parallel()

	req, err := NormalizeLangChain(LangChainEnvelope{
		Metadata: schema.Metadata{
			RequestID: "req-lc-1",
			TenantID:  "tenant-1",
			Provider:  "langchain",
		},
		AgentContext: schema.AgentContext{
			Actor: schema.Actor{ID: "actor-1"},
		},
		Invocation: LangChainInvocation{
			Tool:  "run_sql_query",
			Input: []byte(`{"query":"select 1"}`),
		},
	}, 1024)
	if err != nil {
		t.Fatalf("normalize langchain: %v", err)
	}

	if req.ToolName != "run_sql_query" {
		t.Fatalf("unexpected tool name: %s", req.ToolName)
	}
}

func TestNormalizeGenericFrameworkRejectsMissingTool(t *testing.T) {
	t.Parallel()

	_, err := NormalizeGenericFramework(GenericFrameworkEnvelope{
		Metadata: schema.Metadata{
			RequestID: "req-fw-1",
			TenantID:  "tenant-1",
		},
		AgentContext: schema.AgentContext{
			Actor: schema.Actor{ID: "actor-1"},
		},
		Parameters: []byte(`{"query":"select 1"}`),
	}, 1024)
	if err != ErrMissingFrameworkToolName {
		t.Fatalf("expected missing framework tool name, got %v", err)
	}
}
