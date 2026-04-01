from __future__ import annotations

import json
from typing import Any

from .http_client import ArbiterHTTPClient


def build_openai_tool_envelope(
    *,
    request_id: str,
    tenant_id: str,
    actor_id: str,
    tool_name: str,
    arguments: dict[str, Any],
    session_id: str = "",
    trace_id: str = "",
    required_context: list[str] | None = None,
) -> dict[str, Any]:
    metadata: dict[str, Any] = {
        "request_id": request_id,
        "tenant_id": tenant_id,
        "provider": "openai",
    }
    if session_id.strip():
        metadata["session_id"] = session_id.strip()
    if trace_id.strip():
        metadata["trace_id"] = trace_id.strip()

    envelope: dict[str, Any] = {
        "metadata": metadata,
        "agent_context": {"actor": {"id": actor_id}},
        "tool_call": {
            "type": "function",
            "function": {
                "name": tool_name,
                "arguments": json.dumps(arguments, separators=(",", ":")),
            },
        },
    }
    if required_context:
        envelope["required_context"] = required_context
    return envelope


class LiteLLMGuardrail:
    def __init__(self, client: ArbiterHTTPClient, *, tenant_id: str, actor_id: str) -> None:
        self.client = client
        self.tenant_id = tenant_id
        self.actor_id = actor_id

    def intercept_tool_call(
        self,
        *,
        request_id: str,
        tool_name: str,
        arguments: dict[str, Any],
        session_id: str = "",
        trace_id: str = "",
        required_context: list[str] | None = None,
    ) -> tuple[int, Any]:
        envelope = build_openai_tool_envelope(
            request_id=request_id,
            tenant_id=self.tenant_id,
            actor_id=self.actor_id,
            tool_name=tool_name,
            arguments=arguments,
            session_id=session_id,
            trace_id=trace_id,
            required_context=required_context,
        )
        return self.client.intercept_openai(envelope)

    def verify_tool_call(
        self,
        *,
        token: str,
        request_id: str,
        tool_name: str,
        arguments: dict[str, Any],
        session_id: str = "",
        trace_id: str = "",
        required_context: list[str] | None = None,
    ) -> tuple[int, Any]:
        envelope = build_openai_tool_envelope(
            request_id=request_id,
            tenant_id=self.tenant_id,
            actor_id=self.actor_id,
            tool_name=tool_name,
            arguments=arguments,
            session_id=session_id,
            trace_id=trace_id,
            required_context=required_context,
        )
        return self.client.verify_openai(token, envelope)
