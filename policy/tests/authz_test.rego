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
