# Python Integrations

This package provides drop-in client wrappers for:

- LiteLLM/OpenAI-style tool calls (`arbiter_integrations.litellm`)
- OpenClaw/generic framework tool calls (`arbiter_integrations.openclaw`)

It wraps Arbiter intercept and verify APIs while handling shared-key headers.

## Layout

- `arbiter_integrations/http_client.py`: HTTP transport + auth headers.
- `arbiter_integrations/litellm.py`: OpenAI envelope builder + guardrail wrapper.
- `arbiter_integrations/openclaw.py`: Generic framework/canonical builders + wrapper.

## Example (LiteLLM)

```python
from arbiter_integrations.http_client import ArbiterHTTPClient
from arbiter_integrations.litellm import LiteLLMGuardrail

client = ArbiterHTTPClient(
    "http://localhost:8080",
    gateway_shared_key="gw-key",
    service_shared_key="svc-key",
)
guard = LiteLLMGuardrail(client, tenant_id="tenant-demo", actor_id="agent-42")

status, body = guard.intercept_tool_call(
    request_id="req-1",
    tool_name="send_slack_message",
    arguments={"channel": "ops", "message": "deploy finished"},
)
if status != 200 or not body.get("token"):
    raise RuntimeError("tool call denied")

verify_status, verify_body = guard.verify_tool_call(
    token=body["token"],
    request_id="req-1",
    tool_name="send_slack_message",
    arguments={"channel": "ops", "message": "deploy finished"},
)
assert verify_status == 200 and verify_body.get("status") == "verified"
```

## Example (OpenClaw)

```python
from arbiter_integrations.http_client import ArbiterHTTPClient
from arbiter_integrations.openclaw import OpenClawGuardrail

client = ArbiterHTTPClient("http://localhost:8080")
guard = OpenClawGuardrail(client, tenant_id="tenant-demo", actor_id="agent-99")

status, body = guard.intercept_action(
    request_id="req-2",
    tool_name="run_sql_query",
    parameters={"query": "select 1"},
)
```

## Run Tests

```bash
python3 -m unittest discover integrations/python/tests -v
```
