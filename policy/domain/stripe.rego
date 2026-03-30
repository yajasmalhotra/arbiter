package arbiter.domain.stripe

default allow = false

amount := object.get(input.parameters, "amount_cents", 0)

allow {
	input.tool_name == "create_stripe_refund"
	amount > 0
	amount <= object.get(data.arbiter.domain_config.stripe, "max_refund_cents", 0)
}
