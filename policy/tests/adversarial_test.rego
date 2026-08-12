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

test_shell_rm_rf_denied if {
	result := authz.decision with input as {
		"metadata": {
			"request_id": "adv-6"
		},
		"tool_name": "run_shell_command",
		"parameters": {
			"command": "rm -rf /tmp/cache"
		}
	}

	not result.allow
	result.reason == "tool policy denied"
}

test_shell_argv_delete_denied if {
	result := authz.decision with input as {
		"metadata": {
			"request_id": "adv-7"
		},
		"tool_name": "execute_command",
		"parameters": {
			"argv": ["rm", "-rf", "/tmp/cache"]
		}
	}

	not result.allow
	result.reason == "tool policy denied"
}

test_shell_find_delete_denied if {
	result := authz.decision with input as {
		"metadata": {
			"request_id": "adv-8"
		},
		"tool_name": "bash",
		"parameters": {
			"cmd": "find /tmp -name '*.tmp' -delete"
		}
	}

	not result.allow
	result.reason == "tool policy denied"
}

test_delete_directory_tool_denied if {
	result := authz.decision with input as {
		"metadata": {
			"request_id": "adv-9"
		},
		"tool_name": "delete_directory",
		"parameters": {
			"path": "/tmp/cache",
			"recursive": true
		}
	}

	not result.allow
	result.reason == "tool policy denied"
}

test_stock_exec_rm_rf_denied if {
	result := authz.decision with input as {
		"metadata": {
			"request_id": "adv-10"
		},
		"tool_name": "exec",
		"parameters": {
			"command": "rm -rf /tmp/cache"
		}
	}

	not result.allow
	result.reason == "tool policy denied"
}

test_stock_process_rm_denied if {
	result := authz.decision with input as {
		"metadata": {
			"request_id": "adv-11"
		},
		"tool_name": "process",
		"parameters": {
			"command": ["rm", "-rf", "/tmp/cache"]
		}
	}

	not result.allow
	result.reason == "tool policy denied"
}

test_stock_exec_canary_path_denied if {
	result := authz.decision with input as {
		"metadata": {
			"request_id": "adv-11b"
		},
		"tool_name": "exec",
		"parameters": {
			"command": "mkdir -p /tmp/arbiter-deny-test/nested"
		}
	}

	not result.allow
	result.reason == "tool policy denied"
}

test_stock_process_canary_path_denied if {
	result := authz.decision with input as {
		"metadata": {
			"request_id": "adv-11c"
		},
		"tool_name": "process",
		"parameters": {
			"command": ["mkdir", "-p", "/tmp/arbiter-deny-test/nested"]
		}
	}

	not result.allow
	result.reason == "tool policy denied"
}

test_write_canary_path_denied if {
	result := authz.decision with input as {
		"metadata": {
			"request_id": "adv-11d"
		},
		"tool_name": "write",
		"parameters": {
			"path": "/tmp/arbiter-deny-test/canary.txt",
			"content": "hello"
		}
	}

	not result.allow
	result.reason == "tool policy denied"
}

test_claude_write_file_path_canary_denied if {
	not data.arbiter.authz.allow with input as {
		"schema_version": "v1alpha1",
		"metadata": {"request_id": "claude-write-canary", "tenant_id": "tenant-local"},
		"agent_context": {"actor": {"id": "claude-code-agent", "type": "agent"}},
		"tool_name": "write",
		"parameters": {"file_path": "/tmp/arbiter-deny-test/claude.txt", "content": "blocked"},
	}
}

test_apply_patch_delete_file_denied if {
	result := authz.decision with input as {
		"metadata": {
			"request_id": "adv-12"
		},
		"tool_name": "apply_patch",
		"parameters": {
			"patch": "*** Begin Patch\n*** Delete File: secret.txt\n*** End Patch\n"
		}
	}

	not result.allow
	result.reason == "tool policy denied"
}

test_opencode_patch_text_delete_file_denied if {
	not data.arbiter.authz.allow with input as {
		"schema_version": "v1alpha1",
		"metadata": {"request_id": "opencode-patch-delete", "tenant_id": "tenant-local"},
		"agent_context": {"actor": {"id": "opencode-agent", "type": "agent"}},
		"tool_name": "apply_patch",
		"parameters": {"patchText": "*** Begin Patch\n*** Delete File: src/secret.txt\n*** End Patch"},
	}
}

test_apply_patch_canary_path_denied if {
	result := authz.decision with input as {
		"metadata": {
			"request_id": "adv-13"
		},
		"tool_name": "apply_patch",
		"parameters": {
			"patch": "*** Begin Patch\n*** Add File: /tmp/arbiter-deny-test/canary.txt\n+hello\n*** End Patch\n"
		}
	}

	not result.allow
	result.reason == "tool policy denied"
}

test_shadow_mode_reports_would_deny_without_blocking if {
	result := authz.decision with input as {
		"schema_version": "v1alpha1",
		"metadata": {"request_id": "shadow-delete", "tenant_id": "tenant-local"},
		"agent_context": {"actor": {"id": "shadow-agent", "type": "agent"}},
		"tool_name": "bash",
		"parameters": {"command": "mkdir -p /tmp/arbiter-deny-test/shadow"},
	} with data.arbiter.config.enforcement_mode as "shadow"

	result.allow
	not result.policy_allow
	result.enforcement_mode == "shadow"
	result.reason == "tool policy denied"
}

test_shadow_mode_observes_missing_approval_without_planning_it if {
	request := {
		"schema_version": "v1alpha1",
		"metadata": {"request_id": "shadow-approval", "tenant_id": "tenant-local"},
		"agent_context": {"actor": {"id": "shadow-agent", "type": "agent"}},
		"tool_name": "create_stripe_refund",
		"parameters": {"amount_cents": 1000},
	}
	result := authz.decision with input as request with data.arbiter.config.enforcement_mode as "shadow"
	planned := authz.obligations with input as request with data.arbiter.config.enforcement_mode as "shadow"

	result.allow
	not result.policy_allow
	result.required_context_missing
	result.reason == "required context missing"
	planned == []
}

test_shadow_mode_preserves_raw_allow if {
	result := authz.decision with input as {
		"schema_version": "v1alpha1",
		"metadata": {"request_id": "shadow-allow", "tenant_id": "tenant-local"},
		"agent_context": {"actor": {"id": "shadow-agent", "type": "agent"}},
		"tool_name": "bash",
		"parameters": {"command": "pwd"},
	} with data.arbiter.config.enforcement_mode as "shadow"

	result.allow
	result.policy_allow
	result.reason == "allowed"
}
