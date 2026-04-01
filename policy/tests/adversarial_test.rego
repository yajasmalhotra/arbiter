package arbiter.adversarial_test

import rego.v1
import data.arbiter.authz

test_unknown_tool_denied if {
	result := authz.decision with input as {
		"metadata": {
			"request_id": "adv-1"
		},
		"tool_name": "exfiltrate_secrets",
		"parameters": {
			"target": "attacker"
		}
	}

	not result.allow
	contains(result.reason, "unknown tool")
}

test_sql_delete_denied if {
	result := authz.decision with input as {
		"metadata": {
			"request_id": "adv-2"
		},
		"tool_name": "run_sql_query",
		"parameters": {
			"query": "DELETE FROM payments WHERE 1=1"
		}
	}

	not result.allow
	result.reason == "tool policy denied"
}

test_slack_empty_channel_denied if {
	result := authz.decision with input as {
		"metadata": {
			"request_id": "adv-3"
		},
		"tool_name": "send_slack_message",
		"parameters": {
			"channel": "",
			"message": "hello"
		}
	}

	not result.allow
}

test_stripe_zero_amount_denied if {
	result := authz.decision with input as {
		"metadata": {
			"request_id": "adv-4"
		},
		"tool_name": "create_stripe_refund",
		"parameters": {
			"amount_cents": 0
		}
	}

	not result.allow
}

test_required_context_without_history_denied if {
	result := authz.decision with input as {
		"metadata": {
			"request_id": "adv-5"
		},
		"tool_name": "delete_backup",
		"required_context": [
			"backup"
		],
		"parameters": {
			"backup_id": "b-1"
		}
	}

	not result.allow
	result.required_context_missing
}
