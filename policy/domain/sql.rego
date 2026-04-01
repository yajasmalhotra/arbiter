package arbiter.domain.sql

import rego.v1

default allow := false

query := lower(object.get(input.parameters, "query", ""))

allow if {
	input.tool_name == "run_sql_query"
	not contains(query, "drop ")
	not contains(query, "delete ")
}

allow if {
	input.tool_name == "backup_database"
}

allow if {
	input.tool_name == "delete_backup"
}
