package schema

import "testing"

func TestCanonicalRequestHashIsStable(t *testing.T) {
	t.Parallel()

	left := CanonicalRequest{
		SchemaVersion: CurrentSchemaVersion,
		Metadata: Metadata{
			RequestID: "req-1",
			TenantID:  "tenant-1",
		},
		AgentContext: AgentContext{
			Actor: Actor{ID: "actor-1"},
		},
		ToolName:   "send_slack_message",
		Parameters: []byte(`{"channel":"ops","message":"hello","nested":{"b":2,"a":1}}`),
	}

	right := CanonicalRequest{
		SchemaVersion: CurrentSchemaVersion,
		Metadata: Metadata{
			RequestID: "req-1",
			TenantID:  "tenant-1",
		},
		AgentContext: AgentContext{
			Actor: Actor{ID: "actor-1"},
		},
		ToolName:   "send_slack_message",
		Parameters: []byte(`{"nested":{"a":1,"b":2},"message":"hello","channel":"ops"}`),
	}

	leftHash, err := left.Hash()
	if err != nil {
		t.Fatalf("left hash: %v", err)
	}

	rightHash, err := right.Hash()
	if err != nil {
		t.Fatalf("right hash: %v", err)
	}

	if leftHash != rightHash {
		t.Fatalf("expected hashes to match: %s != %s", leftHash, rightHash)
	}
}

func TestCanonicalRequestValidate(t *testing.T) {
	t.Parallel()

	req := CanonicalRequest{
		SchemaVersion: CurrentSchemaVersion,
		Metadata: Metadata{
			RequestID: "req-1",
			TenantID:  "tenant-1",
		},
		AgentContext: AgentContext{
			Actor: Actor{ID: "actor-1"},
		},
		ToolName:   "send_slack_message",
		Parameters: []byte(`{"channel":"ops"}`),
	}

	if err := req.Validate(128); err != nil {
		t.Fatalf("validate: %v", err)
	}
}

func TestCanonicalRequestValidateRejectsLargePayload(t *testing.T) {
	t.Parallel()

	req := CanonicalRequest{
		SchemaVersion: CurrentSchemaVersion,
		Metadata: Metadata{
			RequestID: "req-1",
			TenantID:  "tenant-1",
		},
		AgentContext: AgentContext{
			Actor: Actor{ID: "actor-1"},
		},
		ToolName:   "send_slack_message",
		Parameters: []byte(`{"message":"this is longer than ten bytes"}`),
	}

	if err := req.Validate(10); err == nil {
		t.Fatal("expected payload size validation error")
	}
}

func TestV1Alpha2HashBindsProtocolAuthorityAndCapability(t *testing.T) {
	t.Parallel()
	base := CanonicalRequest{
		SchemaVersion: CurrentSchemaVersion,
		Metadata:      Metadata{RequestID: "req-1", TenantID: "tenant-1"},
		AgentContext:  AgentContext{Actor: Actor{ID: "agent-1"}},
		ToolName:      "write_file",
		Parameters:    []byte(`{"path":"/tmp/a"}`),
		Protocol:      &Protocol{Name: "mcp"},
		Target:        &Target{ServerID: "server-a"},
		Capability:    &Capability{GrantID: "grant-a", Subject: "agent-1", TenantID: "tenant-1"},
	}
	changed := base
	changed.Target = &Target{ServerID: "server-b"}
	baseHash, err := base.Hash()
	if err != nil {
		t.Fatalf("base hash: %v", err)
	}
	changedHash, err := changed.Hash()
	if err != nil {
		t.Fatalf("changed hash: %v", err)
	}
	if baseHash == changedHash {
		t.Fatal("target server must be bound into v1alpha2 hash")
	}
}
