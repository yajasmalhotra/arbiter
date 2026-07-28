package arbiter.domain.a2a

import rego.v1

default allow := false

allow if {
	input.tool_name == "a2a_send_task"
	target := object.get(object.get(input, "target", {}), "server_id", "")
	data.arbiter.domain_config.a2a.allowed_agents[_] == target
}
