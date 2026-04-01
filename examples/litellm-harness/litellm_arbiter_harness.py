#!/usr/bin/env python3
"""
Manual harness: OpenAI-compatible tool call (via LiteLLM proxy) -> Arbiter intercept -> verify.

Scenarios:
  allowed  — model returns send_slack_message; expect intercept 200 + token; verify once.
  denied   — forced run_sql_query with DROP; expect intercept 403, allow=false, no execution verify.
  replay   — same as allowed, then verify twice; second verify must fail (replay protection).

Environment (defaults shown):
  LITELLM_BASE_URL   http://localhost:4000/v1
  LITELLM_API_KEY    sk-anything
  ARBITER_URL        http://localhost:8080
  LITELLM_MODEL      gpt-4o-mini

Use --arbiter-only to skip LiteLLM and send fixed envelopes (stack / policy smoke test without a model).
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.request
from typing import Any
from uuid import uuid4


def _json_request(
    method: str,
    url: str,
    body: dict[str, Any] | None = None,
    timeout: float = 60.0,
) -> tuple[int, Any]:
    data: bytes | None = None
    headers = {"Accept": "application/json"}
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8")
            status = resp.getcode()
            if not raw:
                return status, None
            return status, json.loads(raw)
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8")
        try:
            parsed = json.loads(raw) if raw else None
        except json.JSONDecodeError:
            parsed = {"raw": raw}
        return e.code, parsed


def build_envelope(
    *,
    request_id: str,
    tenant_id: str,
    actor_id: str,
    tool_name: str,
    arguments: dict[str, Any],
) -> dict[str, Any]:
    return {
        "metadata": {
            "request_id": request_id,
            "tenant_id": tenant_id,
            "provider": "openai",
        },
        "agent_context": {"actor": {"id": actor_id}},
        "tool_call": {
            "type": "function",
            "function": {
                "name": tool_name,
                "arguments": json.dumps(arguments, separators=(",", ":")),
            },
        },
    }


def arbiter_intercept(arbiter_url: str, envelope: dict[str, Any]) -> tuple[int, Any]:
    url = arbiter_url.rstrip("/") + "/v1/intercept/openai"
    return _json_request("POST", url, envelope)


def arbiter_verify(arbiter_url: str, token: str, envelope: dict[str, Any]) -> tuple[int, Any]:
    url = arbiter_url.rstrip("/") + "/v1/execute/verify/openai"
    return _json_request("POST", url, {"token": token, "envelope": envelope})


def tool_defs() -> list[dict[str, Any]]:
    return [
        {
            "type": "function",
            "function": {
                "name": "send_slack_message",
                "description": "Send a message to a Slack channel.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "channel": {"type": "string"},
                        "message": {"type": "string"},
                    },
                    "required": ["channel", "message"],
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "run_sql_query",
                "description": "Run a SQL query against the application database.",
                "parameters": {
                    "type": "object",
                    "properties": {"query": {"type": "string"}},
                    "required": ["query"],
                },
            },
        },
    ]


def extract_request_debug(headers: Any) -> dict[str, str]:
    debug: dict[str, str] = {}
    if headers is None:
        return debug

    pairs = dict(headers.items()) if hasattr(headers, "items") else dict(headers)
    if pairs.get("x-litellm-call-id"):
        debug["litellm_call_id"] = pairs["x-litellm-call-id"]
    if pairs.get("llm_provider-x-request-id"):
        debug["openai_x_request_id"] = pairs["llm_provider-x-request-id"]
    if pairs.get("llm_provider-openai-project"):
        debug["openai_project"] = pairs["llm_provider-openai-project"]
    return debug


def envelope_from_litellm(
    *,
    litellm_base: str,
    api_key: str,
    model: str,
    scenario: str,
    tenant_id: str,
    actor_id: str,
) -> tuple[dict[str, Any], dict[str, str]]:
    from openai import OpenAI

    client = OpenAI(base_url=litellm_base, api_key=api_key)
    rid = f"litellm-{uuid4().hex[:12]}"

    tools = tool_defs()
    if scenario in ("allowed", "replay"):
        response = client.chat.completions.with_raw_response.create(
            model=model,
            messages=[
                {
                    "role": "user",
                    "content": (
                        "Use the tool send_slack_message to send the message 'Deploy finished' "
                        "to channel ops. Do not explain; call the tool."
                    ),
                }
            ],
            tools=tools,
            tool_choice="auto",
        )
    else:
        response = client.chat.completions.with_raw_response.create(
            model=model,
            messages=[
                {
                    "role": "user",
                    "content": "Execute DROP TABLE users; as a SQL query using run_sql_query.",
                }
            ],
            tools=tools,
            tool_choice={
                "type": "function",
                "function": {"name": "run_sql_query"},
            },
        )

    completion = response.parse()
    debug = extract_request_debug(response.headers)
    msg = completion.choices[0].message
    tool_calls = getattr(msg, "tool_calls", None)
    if not tool_calls:
        raise RuntimeError(
            "No tool_calls in model response. Check LiteLLM is running, model supports tools, "
            "and credentials are valid."
        )
    tc = tool_calls[0]
    name = tc.function.name
    args_raw = tc.function.arguments or "{}"
    try:
        args = json.loads(args_raw)
    except json.JSONDecodeError as e:
        raise RuntimeError(f"Invalid tool arguments JSON: {args_raw}") from e

    return (
        build_envelope(
            request_id=rid,
            tenant_id=tenant_id,
            actor_id=actor_id,
            tool_name=name,
            arguments=args,
        ),
        debug,
    )


def run_scenario(
    *,
    scenario: str,
    arbiter_url: str,
    arbiter_only: bool,
    litellm_base: str,
    litellm_api_key: str,
    model: str,
    tenant_id: str,
    actor_id: str,
) -> int:
    request_debug: dict[str, str] = {}
    if arbiter_only:
        if scenario == "denied":
            envelope = build_envelope(
                request_id=f"direct-{uuid4().hex[:12]}",
                tenant_id=tenant_id,
                actor_id=actor_id,
                tool_name="run_sql_query",
                arguments={"query": "DROP TABLE users;"},
            )
        else:
            envelope = build_envelope(
                request_id=f"direct-{uuid4().hex[:12]}",
                tenant_id=tenant_id,
                actor_id=actor_id,
                tool_name="send_slack_message",
                arguments={"channel": "ops", "message": "Deploy finished"},
            )
    else:
        envelope, request_debug = envelope_from_litellm(
            litellm_base=litellm_base,
            api_key=litellm_api_key,
            model=model,
            scenario=scenario,
            tenant_id=tenant_id,
            actor_id=actor_id,
        )

    if request_debug:
        print("--- LiteLLM / Provider Request Debug ---")
        print(json.dumps(request_debug, indent=2))

    print("--- Envelope to Arbiter (intercept) ---")
    print(json.dumps(envelope, indent=2))

    status, body = arbiter_intercept(arbiter_url, envelope)
    print(f"\nIntercept HTTP {status}")
    print(json.dumps(body, indent=2) if body is not None else "(empty)")

    decision = (body or {}).get("decision") if isinstance(body, dict) else None
    allow = decision.get("allow") if isinstance(decision, dict) else None
    token = (body or {}).get("token") if isinstance(body, dict) else None

    if scenario == "denied":
        if status != 403 or allow is not False:
            print("\nFAIL: expected HTTP 403 and decision.allow=false for denied scenario.", file=sys.stderr)
            return 1
        print("\nOK: policy denied as expected (no token to verify).")
        return 0

    if status != 200 or not token or allow is not True:
        print("\nFAIL: expected HTTP 200, allow=true, and a non-empty token.", file=sys.stderr)
        return 1

    v1_status, v1_body = arbiter_verify(arbiter_url, token, envelope)
    print(f"\nVerify #1 HTTP {v1_status}")
    print(json.dumps(v1_body, indent=2) if v1_body is not None else "(empty)")
    if v1_status != 200 or (isinstance(v1_body, dict) and v1_body.get("status") != "verified"):
        print("\nFAIL: first verify should succeed with status verified.", file=sys.stderr)
        return 1

    if scenario == "replay":
        v2_status, v2_body = arbiter_verify(arbiter_url, token, envelope)
        print(f"\nVerify #2 HTTP {v2_status} (expect replay / forbidden)")
        print(json.dumps(v2_body, indent=2) if v2_body is not None else "(empty)")
        if v2_status != 403:
            print("\nFAIL: second verify should return HTTP 403 (replay protection).", file=sys.stderr)
            return 1
        print("\nOK: replay rejected as expected.")
        return 0

    print("\nOK: allowed path and verify succeeded.")
    return 0


def main() -> None:
    p = argparse.ArgumentParser(description="LiteLLM -> Arbiter manual harness")
    p.add_argument(
        "scenario",
        choices=("allowed", "denied", "replay"),
        help="allowed: slack + verify; denied: SQL DROP; replay: slack + verify twice",
    )
    p.add_argument("--arbiter-url", default=os.environ.get("ARBITER_URL", "http://localhost:8080"))
    p.add_argument(
        "--litellm-base-url",
        default=os.environ.get("LITELLM_BASE_URL", "http://localhost:4000/v1"),
        help="OpenAI-compatible base URL (LiteLLM proxy)",
    )
    p.add_argument(
        "--litellm-api-key",
        default=os.environ.get("LITELLM_API_KEY", "sk-anything"),
    )
    p.add_argument("--model", default=os.environ.get("LITELLM_MODEL", "gpt-4o-mini"))
    p.add_argument("--tenant-id", default="tenant-demo")
    p.add_argument("--actor-id", default="user-1")
    p.add_argument(
        "--arbiter-only",
        action="store_true",
        help="Skip LiteLLM; send fixed envelopes (for testing Arbiter without a model)",
    )
    args = p.parse_args()

    code = run_scenario(
        scenario=args.scenario,
        arbiter_url=args.arbiter_url,
        arbiter_only=args.arbiter_only,
        litellm_base=args.litellm_base_url,
        litellm_api_key=args.litellm_api_key,
        model=args.model,
        tenant_id=args.tenant_id,
        actor_id=args.actor_id,
    )
    raise SystemExit(code)


if __name__ == "__main__":
    main()
