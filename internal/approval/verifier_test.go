package approval

import (
	"context"
	"testing"
	"time"

	"arbiter/internal/schema"
)

func approvalRequest() schema.CanonicalRequest {
	return schema.CanonicalRequest{SchemaVersion: schema.CurrentSchemaVersion, Metadata: schema.Metadata{RequestID: "request-1", TenantID: "tenant-1"}, AgentContext: schema.AgentContext{Actor: schema.Actor{ID: "agent-1"}}, ToolName: "create_stripe_refund", Parameters: []byte(`{"amount_cents":100}`), Protocol: &schema.Protocol{Name: "mcp"}, Target: &schema.Target{ServerID: "stripe"}}
}

func TestReceiptIsBoundToExactAction(t *testing.T) {
	t.Parallel()
	issuer := NewIssuerVerifier(map[string][]byte{"test": []byte("secret")}, "test", "arbiter", "arbiter-approval", time.Minute)
	principal := schema.Principal{Subject: "agent-1", TenantID: "tenant-1"}
	raw, err := issuer.Issue(approvalRequest(), principal, "reviewer-1", "financial")
	if err != nil {
		t.Fatalf("issue: %v", err)
	}
	receipt, err := issuer.Verify(context.Background(), raw, approvalRequest(), principal)
	if err != nil || receipt.Class != "financial" {
		t.Fatalf("verify receipt=%#v err=%v", receipt, err)
	}
	changed := approvalRequest()
	changed.Parameters = []byte(`{"amount_cents":101}`)
	if _, err := issuer.Verify(context.Background(), raw, changed, principal); err != ErrInvalidReceipt {
		t.Fatalf("expected exact-action binding failure, got %v", err)
	}
}
