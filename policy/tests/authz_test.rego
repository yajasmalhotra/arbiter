package arbiter.authz_test

import rego.v1
import data.arbiter.authz

test_slack_allow if {
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

test_required_context_missing if {
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

test_required_context_present_allows if {
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

test_sql_drop_denied if {
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

test_slack_channel_denied if {
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

test_stripe_refund_over_cap_denied if {
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

test_openclaw_read_file_allowed if {
	result := authz.decision with input as {
		"metadata": {
			"request_id": "req-7"
		},
		"tool_name": "read_file",
		"parameters": {
			"path": "/tmp/notes.txt"
		}
	}

	result.allow
	result.reason == "allowed"
}

test_openclaw_shell_list_allowed if {
	result := authz.decision with input as {
		"metadata": {
			"request_id": "req-8"
		},
		"tool_name": "run_shell_command",
		"parameters": {
			"command": "ls -la /tmp"
		}
	}

	result.allow
	result.reason == "allowed"
}

test_openclaw_delete_file_denied if {
	result := authz.decision with input as {
		"metadata": {
			"request_id": "req-9"
		},
		"tool_name": "delete_file",
		"parameters": {
			"path": "/tmp/notes.txt"
		}
	}

	not result.allow
	result.reason == "tool policy denied"
}

test_openclaw_stock_read_allowed if {
	result := authz.decision with input as {
		"metadata": {
			"request_id": "req-10"
		},
		"tool_name": "read",
		"parameters": {
			"path": "/tmp/notes.txt"
		}
	}

	result.allow
	result.reason == "allowed"
}

test_openclaw_stock_exec_list_allowed if {
	result := authz.decision with input as {
		"metadata": {
			"request_id": "req-11"
		},
		"tool_name": "exec",
		"parameters": {
			"command": "ls -la /tmp"
		}
	}

	result.allow
	result.reason == "allowed"
}

test_openclaw_stock_edit_allowed if {
	result := authz.decision with input as {
		"metadata": {
			"request_id": "req-12"
		},
		"tool_name": "edit",
		"parameters": {
			"path": "/tmp/notes.txt",
			"find": "hello",
			"replace": "hello world"
		}
	}

	result.allow
	result.reason == "allowed"
}

test_openclaw_apply_patch_non_delete_allowed if {
	result := authz.decision with input as {
		"metadata": {
			"request_id": "req-13"
		},
		"tool_name": "apply_patch",
		"parameters": {
			"patch": "*** Begin Patch\n*** Update File: notes.txt\n@@\n-hello\n+hello world\n*** End Patch\n"
		}
	}

	result.allow
	result.reason == "allowed"
}
