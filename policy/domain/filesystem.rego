package arbiter.domain.filesystem

import rego.v1

default allow := false

allow if {
	input.tool_name == "read_file"
}

allow if {
	input.tool_name == "list_directory"
}

allow if {
	input.tool_name == "stat_path"
}

allow if {
	input.tool_name == "read"
}

allow if {
	shell_tool
	not shell_delete_requested
	not blocked_test_target_requested
}

allow if {
	mutating_text_tool
	not explicit_delete_request
	not blocked_test_target_requested
}

allow if {
	input.tool_name == "apply_patch"
	not patch_delete_requested
	not blocked_test_target_requested
}

shell_tool if {
	input.tool_name == "run_shell_command"
}

shell_tool if {
	input.tool_name == "run_command"
}

shell_tool if {
	input.tool_name == "execute_command"
}

shell_tool if {
	input.tool_name == "bash"
}

shell_tool if {
	input.tool_name == "exec"
}

shell_tool if {
	input.tool_name == "process"
}

mutating_text_tool if {
	input.tool_name == "write"
}

mutating_text_tool if {
	input.tool_name == "edit"
}

shell_delete_requested if {
	command := object.get(input.parameters, "command", "")
	is_string(command)
	destructive_command_text(lower(command))
}

shell_delete_requested if {
	command := object.get(input.parameters, "command", [])
	is_array(command)
	count(command) > 0
	first := command[0]
	is_string(first)
	destructive_shell_verb(lower(first))
}

shell_delete_requested if {
	command := object.get(input.parameters, "cmd", "")
	is_string(command)
	destructive_command_text(lower(command))
}

shell_delete_requested if {
	args := object.get(input.parameters, "args", [])
	is_array(args)
	count(args) > 0
	first := args[0]
	is_string(first)
	destructive_shell_verb(lower(first))
}

shell_delete_requested if {
	argv := object.get(input.parameters, "argv", [])
	is_array(argv)
	count(argv) > 0
	first := argv[0]
	is_string(first)
	destructive_shell_verb(lower(first))
}

shell_delete_requested if {
	arguments := object.get(input.parameters, "arguments", [])
	is_array(arguments)
	count(arguments) > 0
	first := arguments[0]
	is_string(first)
	destructive_shell_verb(lower(first))
}

blocked_test_target_requested if {
	blocked_test_string_references_path(object.get(input.parameters, "command", ""))
}

blocked_test_target_requested if {
	blocked_test_array_references_path(object.get(input.parameters, "command", []))
}

blocked_test_target_requested if {
	blocked_test_string_references_path(object.get(input.parameters, "cmd", ""))
}

blocked_test_target_requested if {
	blocked_test_array_references_path(object.get(input.parameters, "args", []))
}

blocked_test_target_requested if {
	blocked_test_array_references_path(object.get(input.parameters, "argv", []))
}

blocked_test_target_requested if {
	blocked_test_array_references_path(object.get(input.parameters, "arguments", []))
}

blocked_test_target_requested if {
	blocked_test_string_references_path(object.get(input.parameters, "path", ""))
}

blocked_test_target_requested if {
	blocked_test_string_references_path(object.get(input.parameters, "file", ""))
}

blocked_test_target_requested if {
	blocked_test_string_references_path(object.get(input.parameters, "target", ""))
}

blocked_test_target_requested if {
	blocked_test_string_references_path(object.get(input.parameters, "destination", ""))
}

blocked_test_target_requested if {
	blocked_test_string_references_path(object.get(input.parameters, "patch", ""))
}

patch_delete_requested if {
	patch := object.get(input.parameters, "patch", "")
	is_string(patch)
	contains(lower(patch), "*** delete file:")
}

explicit_delete_request if {
	object.get(input.parameters, "delete", false) == true
}

explicit_delete_request if {
	value := object.get(input.parameters, "operation", "")
	is_string(value)
	destructive_action_text(lower(value))
}

explicit_delete_request if {
	value := object.get(input.parameters, "action", "")
	is_string(value)
	destructive_action_text(lower(value))
}

explicit_delete_request if {
	value := object.get(input.parameters, "mode", "")
	is_string(value)
	destructive_action_text(lower(value))
}

destructive_command_text(command) if {
	regex.match(`(^|[^[:alnum:]_])(rm|rmdir|unlink|shred)([^[:alnum:]_]|$)`, command)
}

destructive_command_text(command) if {
	regex.match(`(^|[^[:alnum:]_])find([^[:alnum:]_]|$)`, command)
	contains(command, "-delete")
}

destructive_action_text(value) if {
	contains(value, "delete")
}

destructive_action_text(value) if {
	contains(value, "remove")
}

destructive_action_text(value) if {
	contains(value, "unlink")
}

destructive_action_text(value) if {
	value == "rm"
}

destructive_action_text(value) if {
	value == "rmdir"
}

destructive_shell_verb(verb) if {
	verb == "rm"
}

destructive_shell_verb(verb) if {
	verb == "rmdir"
}

destructive_shell_verb(verb) if {
	verb == "unlink"
}

destructive_shell_verb(verb) if {
	verb == "shred"
}

blocked_test_string_references_path(value) if {
	is_string(value)
	prefix := object.get(object.get(data.arbiter.domain_config, "filesystem", {}), "blocked_test_path_prefixes", [])[_]
	prefix != ""
	contains(lower(value), lower(prefix))
}

blocked_test_array_references_path(value) if {
	is_array(value)
	entry := value[_]
	is_string(entry)
	blocked_test_string_references_path(entry)
}
