package arbiter.authz_test

import data.arbiter.authz

test_slack_allow {
	result := authz.decision with input as {
		"metadata": {
			"request_id": "req-1"
		},
		"tool_name": "send_slack_message",
		"parameters": {
			"channel": "ops",
			"message": "deploy complete"
		}
	}

	result.allow
	result.reason == "allowed"
}

test_required_context_missing {
	result := authz.decision with input as {
		"metadata": {
			"request_id": "req-2"
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

test_required_context_present_allows {
	result := authz.decision with input as {
		"metadata": {
			"request_id": "req-3"
		},
		"tool_name": "delete_backup",
		"required_context": [
			"backup"
		],
		"previous_actions": [
			{
				"tool_name": "backup_database",
				"outcome": "allowed"
			}
		],
		"parameters": {
			"backup_id": "b-1"
		}
	}

	result.allow
}

test_sql_drop_denied {
	result := authz.decision with input as {
		"metadata": {
			"request_id": "req-4"
		},
		"tool_name": "run_sql_query",
		"parameters": {
			"query": "DROP TABLE users"
		}
	}

	not result.allow
	result.reason == "tool policy denied"
}

test_slack_channel_denied {
	result := authz.decision with input as {
		"metadata": {
			"request_id": "req-5"
		},
		"tool_name": "send_slack_message",
		"parameters": {
			"channel": "random",
			"message": "should fail"
		}
	}

	not result.allow
}

test_stripe_refund_over_cap_denied {
	result := authz.decision with input as {
		"metadata": {
			"request_id": "req-6"
		},
		"tool_name": "create_stripe_refund",
		"parameters": {
			"amount_cents": 999999
		}
	}

	not result.allow
}
