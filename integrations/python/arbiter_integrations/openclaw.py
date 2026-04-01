from __future__ import annotations

from typing import Any

from .http_client import ArbiterHTTPClient


def build_framework_envelope(
    *,
    request_id: str,
    tenant_id: str,
    actor_id: str,
    tool_name: str,
    parameters: dict[str, Any],
    session_id: str = "",
    trace_id: str = "",
    required_context: list[str] | None = None,
) -> dict[str, Any]:
    metadata: dict[str, Any] = {
        "request_id": request_id,
        "tenant_id": tenant_id,
        "provider": "framework",
    }
    if session_id.strip():
        metadata["session_id"] = session_id.strip()
    if trace_id.strip():
        metadata["trace_id"] = trace_id.strip()

    envelope: dict[str, Any] = {
        "schema_version": "v1alpha1",
        "metadata": metadata,
        "agent_context": {"actor": {"id": actor_id}},
        "tool_name": tool_name,
        "parameters": parameters,
    }
    if required_context:
        envelope["required_context"] = required_context
    return envelope


def build_canonical_request(
    *,
    request_id: str,
    tenant_id: str,
    actor_id: str,
    tool_name: str,
    parameters: dict[str, Any],
    session_id: str = "",
    trace_id: str = "",
    required_context: list[str] | None = None,
) -> dict[str, Any]:
    request: dict[str, Any] = {
        "schema_version": "v1alpha1",
        "metadata": {
            "request_id": request_id,
            "tenant_id": tenant_id,
            "provider": "framework",
        },
        "agent_context": {"actor": {"id": actor_id}},
        "tool_name": tool_name,
        "parameters": parameters,
    }
    if session_id.strip():
        request["metadata"]["session_id"] = session_id.strip()
    if trace_id.strip():
        request["metadata"]["trace_id"] = trace_id.strip()
    if required_context:
        request["required_context"] = required_context
    return request


class OpenClawGuardrail:
    def __init__(self, client: ArbiterHTTPClient, *, tenant_id: str, actor_id: str) -> None:
        self.client = client
        self.tenant_id = tenant_id
        self.actor_id = actor_id

    def intercept_action(
        self,
        *,
        request_id: str,
        tool_name: str,
        parameters: dict[str, Any],
        session_id: str = "",
        trace_id: str = "",
        required_context: list[str] | None = None,
    ) -> tuple[int, Any]:
        envelope = build_framework_envelope(
            request_id=request_id,
            tenant_id=self.tenant_id,
            actor_id=self.actor_id,
            tool_name=tool_name,
            parameters=parameters,
            session_id=session_id,
            trace_id=trace_id,
            required_context=required_context,
        )
        return self.client.intercept_framework_generic(envelope)

    def verify_action(
        self,
        *,
        token: str,
        request_id: str,
        tool_name: str,
        parameters: dict[str, Any],
        session_id: str = "",
        trace_id: str = "",
        required_context: list[str] | None = None,
    ) -> tuple[int, Any]:
        request = build_canonical_request(
            request_id=request_id,
            tenant_id=self.tenant_id,
            actor_id=self.actor_id,
            tool_name=tool_name,
            parameters=parameters,
            session_id=session_id,
            trace_id=trace_id,
            required_context=required_context,
        )
        return self.client.verify_canonical(token, request)
