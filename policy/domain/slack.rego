package arbiter.domain.slack

default allow = false

channel := object.get(input.parameters, "channel", "")

allow {
	input.tool_name == "send_slack_message"
	channel != ""
	object.get(data.arbiter.domain_config.slack, "allowed_channels", [])[_] == channel
}
