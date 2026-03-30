package arbiter.domain.sql

default allow = false

query := lower(object.get(input.parameters, "query", ""))

allow {
	input.tool_name == "run_sql_query"
	not contains(query, "drop ")
	not contains(query, "delete ")
}

allow {
	input.tool_name == "backup_database"
}

allow {
	input.tool_name == "delete_backup"
}
