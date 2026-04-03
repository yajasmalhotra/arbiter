package arbiter.authz

import rego.v1

default allow := false
default required_context_missing := false

known_tool if {
	object.get(data.arbiter.tools, input.tool_name, null) != null
}

required_context_missing if {
	count(object.get(input, "required_context", [])) > 0
	count(object.get(input, "previous_actions", [])) == 0
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

allow if {
	known_tool
	not required_context_missing
	domain_allow
}

reason := "allowed" if {
	allow
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
	not allow
}

decision := {
	"allow": allow,
	"reason": reason,
	"policy_package": "arbiter.authz",
	"policy_version": object.get(data.arbiter.config, "policy_version", "dev"),
	"data_revision": object.get(data.arbiter.config, "data_revision", "local"),
	"decision_id": object.get(input.metadata, "request_id", ""),
	"required_context_missing": required_context_missing,
}
