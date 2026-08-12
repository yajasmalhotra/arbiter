package arbiter.authz

import rego.v1

default policy_allow := false
default allow := false
default required_context_missing := false

enforcement_mode := object.get(data.arbiter.config, "enforcement_mode", "enforce")

policy_obligations := object.get(data.arbiter.context_requirements, input.tool_name, [])

# Shadow bundles must observe the decision that would have been made without
# requiring side-effecting prerequisites such as human approval. The decision
# rule still evaluates policy_obligations below and reports the raw verdict.
obligations := [] if {
	enforcement_mode == "shadow"
}

obligations := policy_obligations if {
	enforcement_mode != "shadow"
}

known_tool if {
	object.get(data.arbiter.tools, input.tool_name, null) != null
}

required_context_missing if {
	count(object.get(input, "required_context", [])) > 0
	count(object.get(input, "previous_actions", [])) == 0
}

required_context_missing if {
	obligation := policy_obligations[_]
	obligation.type == "recent_actions"
	count(object.get(input, "previous_actions", [])) == 0
}

required_context_missing if {
	obligation := policy_obligations[_]
	obligation.type == "approval"
	approval := object.get(input, "approval", null)
	approval == null
}

required_context_missing if {
	obligation := policy_obligations[_]
	obligation.type == "approval"
	class := object.get(obligation, "class", "")
	class != ""
	approval := object.get(input, "approval", {})
	object.get(approval, "class", "") != class
}

domain_allow if {
	data.arbiter.domain.sql.allow with input as input
}

domain_allow if {
	data.arbiter.domain.slack.allow with input as input
}

domain_allow if {
	data.arbiter.domain.stripe.allow with input as input
}

domain_allow if {
	data.arbiter.domain.filesystem.allow with input as input
}

domain_allow if {
	data.arbiter.domain.a2a.allow with input as input
}

# Tool discovery is a non-side-effecting protocol operation. It is evaluated
# independently from invocation rules so callers can only discover registered
# tools, while argument-specific policy remains enforced at tools/call time.
mcp_tool_discovery if {
	input.operation == "mcp.tools/list"
	known_tool
}

policy_allow if {
	known_tool
	not required_context_missing
	domain_allow
}

policy_allow if {
	mcp_tool_discovery
}

allow if {
	policy_allow
}

allow if {
	enforcement_mode == "shadow"
}

reason := "allowed" if {
	policy_allow
}

reason := "required context missing" if {
	required_context_missing
}

reason := sprintf("unknown tool: %s", [input.tool_name]) if {
	not known_tool
}

reason := "tool policy denied" if {
	known_tool
	not required_context_missing
	not policy_allow
}

decision := {
	"allow": allow,
	"policy_allow": policy_allow,
	"enforcement_mode": enforcement_mode,
	"reason": reason,
	"policy_package": "arbiter.authz",
	"policy_version": object.get(data.arbiter.config, "policy_version", "dev"),
	"data_revision": object.get(data.arbiter.config, "data_revision", "local"),
	"decision_id": object.get(input.metadata, "request_id", ""),
	"required_context_missing": required_context_missing,
}
