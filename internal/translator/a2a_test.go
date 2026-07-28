package translator

import (
	"testing"

	"arbiter/internal/schema"
)

func TestNormalizeA2ATaskSend(t *testing.T) {
	t.Parallel()
	req, err := NormalizeA2ATaskSend(A2ATaskSendEnvelope{
		Metadata:     schema.Metadata{RequestID: "task-1", TenantID: "tenant-1"},
		AgentContext: schema.AgentContext{Actor: schema.Actor{ID: "agent:orchestrator"}},
		Target:       A2AAgentRef{ID: "agent:researcher", Endpoint: "https://researcher.example/a2a"},
		Task:         A2ATask{ID: "task-1", Message: []byte(`{"prompt":"research"}`)},
	}, 4096)
	if err != nil {
		t.Fatalf("normalize: %v", err)
	}
	if req.ToolName != "a2a_send_task" || req.Protocol == nil || req.Protocol.Name != "a2a" || req.Target == nil || req.Target.ServerID != "agent:researcher" {
		t.Fatalf("unexpected A2A request: %#v", req)
	}
}

func TestNormalizeA2ATaskSendRequiresTarget(t *testing.T) {
	t.Parallel()
	_, err := NormalizeA2ATaskSend(A2ATaskSendEnvelope{Metadata: schema.Metadata{RequestID: "task-1", TenantID: "tenant-1"}, AgentContext: schema.AgentContext{Actor: schema.Actor{ID: "agent-1"}}}, 4096)
	if err != ErrMissingA2ATarget {
		t.Fatalf("expected missing target error, got %v", err)
	}
}
