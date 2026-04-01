from __future__ import annotations

import json
import pathlib
import sys
import unittest
from typing import Any

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from arbiter_integrations.litellm import LiteLLMGuardrail, build_openai_tool_envelope


class StubClient:
    def __init__(self) -> None:
        self.last_intercept: dict[str, Any] | None = None
        self.last_verify_token: str | None = None
        self.last_verify_envelope: dict[str, Any] | None = None

    def intercept_openai(self, envelope: dict[str, Any]) -> tuple[int, Any]:
        self.last_intercept = envelope
        return 200, {"decision": {"allow": True}, "token": "tok_1"}

    def verify_openai(self, token: str, envelope: dict[str, Any]) -> tuple[int, Any]:
        self.last_verify_token = token
        self.last_verify_envelope = envelope
        return 200, {"status": "verified"}


class TestLiteLLMIntegration(unittest.TestCase):
    def test_build_openai_tool_envelope(self) -> None:
        envelope = build_openai_tool_envelope(
            request_id="req-1",
            tenant_id="tenant-1",
            actor_id="agent-1",
            tool_name="send_slack_message",
            arguments={"channel": "ops", "message": "done"},
            session_id="sess-1",
        )
        self.assertEqual(envelope["metadata"]["request_id"], "req-1")
        self.assertEqual(envelope["metadata"]["tenant_id"], "tenant-1")
        self.assertEqual(envelope["metadata"]["session_id"], "sess-1")
        self.assertEqual(envelope["tool_call"]["function"]["name"], "send_slack_message")
        parsed = json.loads(envelope["tool_call"]["function"]["arguments"])
        self.assertEqual(parsed["channel"], "ops")
        self.assertEqual(parsed["message"], "done")

    def test_guardrail_calls_client(self) -> None:
        client = StubClient()
        guard = LiteLLMGuardrail(client, tenant_id="tenant-1", actor_id="agent-1")

        status, body = guard.intercept_tool_call(
            request_id="req-2",
            tool_name="send_slack_message",
            arguments={"channel": "ops", "message": "ok"},
        )
        self.assertEqual(status, 200)
        self.assertTrue(body["decision"]["allow"])
        self.assertEqual(client.last_intercept["metadata"]["tenant_id"], "tenant-1")
        self.assertEqual(client.last_intercept["agent_context"]["actor"]["id"], "agent-1")

        verify_status, verify_body = guard.verify_tool_call(
            token="tok_1",
            request_id="req-2",
            tool_name="send_slack_message",
            arguments={"channel": "ops", "message": "ok"},
        )
        self.assertEqual(verify_status, 200)
        self.assertEqual(verify_body["status"], "verified")
        self.assertEqual(client.last_verify_token, "tok_1")
        self.assertEqual(client.last_verify_envelope["tool_call"]["function"]["name"], "send_slack_message")


if __name__ == "__main__":
    unittest.main()
