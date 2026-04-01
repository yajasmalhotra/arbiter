"""Unit tests for envelope construction used by the manual harness."""

import json
import unittest

from litellm_arbiter_harness import build_envelope, extract_request_debug


class TestBuildEnvelope(unittest.TestCase):
    def test_slack_shape(self) -> None:
        env = build_envelope(
            request_id="r1",
            tenant_id="t1",
            actor_id="a1",
            tool_name="send_slack_message",
            arguments={"channel": "ops", "message": "hi"},
        )
        self.assertEqual(env["metadata"]["request_id"], "r1")
        self.assertEqual(env["metadata"]["tenant_id"], "t1")
        self.assertEqual(env["agent_context"]["actor"]["id"], "a1")
        self.assertEqual(env["tool_call"]["type"], "function")
        self.assertEqual(env["tool_call"]["function"]["name"], "send_slack_message")
        parsed = json.loads(env["tool_call"]["function"]["arguments"])
        self.assertEqual(parsed["channel"], "ops")

    def test_extract_request_debug(self) -> None:
        debug = extract_request_debug(
            {
                "x-litellm-call-id": "call-123",
                "llm_provider-x-request-id": "req-456",
                "llm_provider-openai-project": "proj-789",
            }
        )
        self.assertEqual(debug["litellm_call_id"], "call-123")
        self.assertEqual(debug["openai_x_request_id"], "req-456")
        self.assertEqual(debug["openai_project"], "proj-789")


if __name__ == "__main__":
    unittest.main()
