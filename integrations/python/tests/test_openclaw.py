from __future__ import annotations

import pathlib
import sys
import unittest
from typing import Any

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from arbiter_integrations.openclaw import (
    OpenClawGuardrail,
    build_canonical_request,
    build_framework_envelope,
)


class StubClient:
    def __init__(self) -> None:
        self.last_intercept: dict[str, Any] | None = None
        self.last_verify_token: str | None = None
        self.last_verify_request: dict[str, Any] | None = None

    def intercept_framework_generic(self, envelope: dict[str, Any]) -> tuple[int, Any]:
        self.last_intercept = envelope
        return 403, {"decision": {"allow": False}, "error": "denied"}

    def verify_canonical(self, token: str, request: dict[str, Any]) -> tuple[int, Any]:
        self.last_verify_token = token
        self.last_verify_request = request
        return 200, {"status": "verified"}


class TestOpenClawIntegration(unittest.TestCase):
    def test_build_framework_envelope(self) -> None:
        envelope = build_framework_envelope(
            request_id="req-1",
            tenant_id="tenant-1",
            actor_id="agent-1",
            tool_name="run_sql_query",
            parameters={"query": "select 1"},
            required_context=["state.last_action"],
        )
        self.assertEqual(envelope["schema_version"], "v1alpha1")
        self.assertEqual(envelope["tool_name"], "run_sql_query")
        self.assertEqual(envelope["parameters"]["query"], "select 1")
        self.assertEqual(envelope["required_context"], ["state.last_action"])

    def test_build_canonical_request(self) -> None:
        request = build_canonical_request(
            request_id="req-2",
            tenant_id="tenant-2",
            actor_id="agent-2",
            tool_name="send_slack_message",
            parameters={"channel": "ops", "message": "hi"},
            trace_id="trace-1",
        )
        self.assertEqual(request["schema_version"], "v1alpha1")
        self.assertEqual(request["metadata"]["provider"], "framework")
        self.assertEqual(request["metadata"]["trace_id"], "trace-1")
        self.assertEqual(request["parameters"]["channel"], "ops")

    def test_guardrail_calls_client(self) -> None:
        client = StubClient()
        guard = OpenClawGuardrail(client, tenant_id="tenant-1", actor_id="agent-1")

        status, body = guard.intercept_action(
            request_id="req-3",
            tool_name="run_sql_query",
            parameters={"query": "DROP TABLE users;"},
        )
        self.assertEqual(status, 403)
        self.assertFalse(body["decision"]["allow"])
        self.assertEqual(client.last_intercept["metadata"]["tenant_id"], "tenant-1")
        self.assertEqual(client.last_intercept["agent_context"]["actor"]["id"], "agent-1")

        verify_status, verify_body = guard.verify_action(
            token="tok_2",
            request_id="req-4",
            tool_name="send_slack_message",
            parameters={"channel": "ops", "message": "done"},
        )
        self.assertEqual(verify_status, 200)
        self.assertEqual(verify_body["status"], "verified")
        self.assertEqual(client.last_verify_token, "tok_2")
        self.assertEqual(client.last_verify_request["tool_name"], "send_slack_message")


if __name__ == "__main__":
    unittest.main()
