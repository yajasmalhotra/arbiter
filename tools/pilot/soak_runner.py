#!/usr/bin/env python3
"""
Pilot soak runner for Arbiter.

This script generates sustained allow/deny traffic against Arbiter, verifies
execution tokens, and validates metrics deltas for pilot readiness checks.
"""

from __future__ import annotations

import argparse
import json
import os
import statistics
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from typing import Any
from uuid import uuid4


def _json_request(
    method: str,
    url: str,
    body: dict[str, Any] | None = None,
    headers: dict[str, str] | None = None,
    timeout: float = 15.0,
) -> tuple[int, Any]:
    payload: bytes | None = None
    req_headers = {"Accept": "application/json"}
    if headers:
        req_headers.update(headers)
    if body is not None:
        payload = json.dumps(body).encode("utf-8")
        req_headers["Content-Type"] = "application/json"

    request = urllib.request.Request(url, data=payload, headers=req_headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            raw = response.read().decode("utf-8")
            return response.getcode(), (json.loads(raw) if raw else None)
    except urllib.error.HTTPError as err:
        raw = err.read().decode("utf-8")
        if not raw:
            return err.code, None
        try:
            return err.code, json.loads(raw)
        except json.JSONDecodeError:
            return err.code, {"error": raw}


def _text_request(url: str, headers: dict[str, str] | None = None, timeout: float = 15.0) -> tuple[int, str]:
    req_headers = {"Accept": "text/plain"}
    if headers:
        req_headers.update(headers)
    request = urllib.request.Request(url, headers=req_headers, method="GET")
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return response.getcode(), response.read().decode("utf-8")
    except urllib.error.HTTPError as err:
        return err.code, err.read().decode("utf-8")


def parse_metrics(raw: str) -> dict[str, float]:
    metrics: dict[str, float] = {}
    for line in raw.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        parts = line.split()
        if len(parts) != 2:
            continue
        key = parts[0]
        try:
            value = float(parts[1])
        except ValueError:
            continue
        metrics[key] = value
    return metrics


def build_openai_envelope(
    *,
    request_id: str,
    tenant_id: str,
    actor_id: str,
    trace_id: str,
    tool_name: str,
    arguments: dict[str, Any],
) -> dict[str, Any]:
    return {
        "metadata": {
            "request_id": request_id,
            "tenant_id": tenant_id,
            "provider": "openai",
            "trace_id": trace_id,
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


@dataclass
class SoakStats:
    loops: int = 0
    allow_intercepts_ok: int = 0
    allow_intercepts_fail: int = 0
    verify_ok: int = 0
    verify_fail: int = 0
    replay_expected_fail: int = 0
    replay_unexpected: int = 0
    deny_intercepts_ok: int = 0
    deny_intercepts_fail: int = 0
    failures: list[str] = field(default_factory=list)
    allow_intercept_ms: list[float] = field(default_factory=list)
    verify_ms: list[float] = field(default_factory=list)
    deny_intercept_ms: list[float] = field(default_factory=list)

    def add_failure(self, message: str) -> None:
        self.failures.append(message)

    def latency_summary(self) -> dict[str, dict[str, float]]:
        def summarize(values: list[float]) -> dict[str, float]:
            if not values:
                return {}
            return {
                "p50": statistics.median(values),
                "p95": statistics.quantiles(values, n=20)[18] if len(values) > 1 else values[0],
                "max": max(values),
            }

        return {
            "allow_intercept_ms": summarize(self.allow_intercept_ms),
            "verify_ms": summarize(self.verify_ms),
            "deny_intercept_ms": summarize(self.deny_intercept_ms),
        }


def main() -> None:
    parser = argparse.ArgumentParser(description="Run Arbiter pilot soak traffic and checks")
    parser.add_argument("--arbiter-url", default=os.getenv("ARBITER_URL", "http://localhost:8080"))
    parser.add_argument("--duration-seconds", type=int, default=120)
    parser.add_argument("--interval-ms", type=int, default=250)
    parser.add_argument("--tenant-id", default=os.getenv("ARBITER_TENANT_ID", "tenant-pilot"))
    parser.add_argument("--actor-id", default=os.getenv("ARBITER_ACTOR_ID", "pilot-agent"))
    parser.add_argument("--gateway-key", default=os.getenv("ARBITER_GATEWAY_SHARED_KEY", ""))
    parser.add_argument("--service-key", default=os.getenv("ARBITER_SERVICE_SHARED_KEY", ""))
    parser.add_argument("--replay-check-every", type=int, default=10)
    parser.add_argument("--max-failures", type=int, default=10)
    parser.add_argument("--skip-metrics-check", action="store_true")
    args = parser.parse_args()

    arbiter_url = args.arbiter_url.rstrip("/")
    gateway_headers = {"X-Arbiter-Gateway-Key": args.gateway_key} if args.gateway_key else {}
    service_headers = {"X-Arbiter-Service-Key": args.service_key} if args.service_key else {}

    baseline_metrics: dict[str, float] = {}
    if not args.skip_metrics_check:
        status, metrics_raw = _text_request(f"{arbiter_url}/metrics")
        if status == 200:
            baseline_metrics = parse_metrics(metrics_raw)

    started_at = time.time()
    deadline = started_at + args.duration_seconds
    stats = SoakStats()

    while time.time() < deadline:
        stats.loops += 1
        req_suffix = uuid4().hex[:10]
        trace_id = f"pilot-{req_suffix}"

        allow_envelope = build_openai_envelope(
            request_id=f"allow-{req_suffix}",
            tenant_id=args.tenant_id,
            actor_id=args.actor_id,
            trace_id=trace_id,
            tool_name="send_slack_message",
            arguments={"channel": "ops", "message": "pilot soak event"},
        )

        allow_start = time.time()
        allow_status, allow_body = _json_request(
            "POST",
            f"{arbiter_url}/v1/intercept/openai",
            allow_envelope,
            headers=gateway_headers,
        )
        stats.allow_intercept_ms.append((time.time() - allow_start) * 1000.0)

        token = ""
        allow_flag = None
        if isinstance(allow_body, dict):
            decision = allow_body.get("decision")
            if isinstance(decision, dict):
                allow_flag = decision.get("allow")
            token = str(allow_body.get("token") or "")

        if allow_status == 200 and allow_flag is True and token:
            stats.allow_intercepts_ok += 1
        else:
            stats.allow_intercepts_fail += 1
            stats.add_failure(f"allow intercept failed: status={allow_status} body={allow_body}")

        if token:
            verify_start = time.time()
            verify_status, verify_body = _json_request(
                "POST",
                f"{arbiter_url}/v1/execute/verify/openai",
                {"token": token, "envelope": allow_envelope},
                headers=service_headers,
            )
            stats.verify_ms.append((time.time() - verify_start) * 1000.0)
            if verify_status == 200 and isinstance(verify_body, dict) and verify_body.get("status") == "verified":
                stats.verify_ok += 1
            else:
                stats.verify_fail += 1
                stats.add_failure(f"verify failed: status={verify_status} body={verify_body}")

            if args.replay_check_every > 0 and stats.loops % args.replay_check_every == 0:
                replay_status, replay_body = _json_request(
                    "POST",
                    f"{arbiter_url}/v1/execute/verify/openai",
                    {"token": token, "envelope": allow_envelope},
                    headers=service_headers,
                )
                if replay_status == 403:
                    stats.replay_expected_fail += 1
                else:
                    stats.replay_unexpected += 1
                    stats.add_failure(f"replay check failed: status={replay_status} body={replay_body}")

        deny_envelope = build_openai_envelope(
            request_id=f"deny-{req_suffix}",
            tenant_id=args.tenant_id,
            actor_id=args.actor_id,
            trace_id=trace_id,
            tool_name="run_sql_query",
            arguments={"query": "DROP TABLE users;"},
        )
        deny_start = time.time()
        deny_status, deny_body = _json_request(
            "POST",
            f"{arbiter_url}/v1/intercept/openai",
            deny_envelope,
            headers=gateway_headers,
        )
        stats.deny_intercept_ms.append((time.time() - deny_start) * 1000.0)
        deny_allow_flag = None
        if isinstance(deny_body, dict):
            decision = deny_body.get("decision")
            if isinstance(decision, dict):
                deny_allow_flag = decision.get("allow")

        if deny_status == 403 and deny_allow_flag is False:
            stats.deny_intercepts_ok += 1
        else:
            stats.deny_intercepts_fail += 1
            stats.add_failure(f"deny intercept failed: status={deny_status} body={deny_body}")

        if len(stats.failures) >= args.max_failures:
            break

        time.sleep(max(args.interval_ms / 1000.0, 0.0))

    metrics_validation: dict[str, Any] = {}
    if not args.skip_metrics_check:
        status, metrics_raw = _text_request(f"{arbiter_url}/metrics")
        if status != 200:
            metrics_validation["error"] = f"metrics endpoint returned HTTP {status}"
            stats.add_failure(metrics_validation["error"])
        else:
            current = parse_metrics(metrics_raw)
            required = [
                "arbiter_decisions_total",
                "arbiter_decisions_allow_total",
                "arbiter_decisions_deny_total",
            ]
            missing = [name for name in required if name not in current]
            if missing:
                metrics_validation["missing"] = missing
                stats.add_failure(f"missing metrics: {','.join(missing)}")
            else:
                baseline_total = baseline_metrics.get("arbiter_decisions_total", 0.0)
                baseline_allow = baseline_metrics.get("arbiter_decisions_allow_total", 0.0)
                baseline_deny = baseline_metrics.get("arbiter_decisions_deny_total", 0.0)
                metrics_validation = {
                    "delta_total": current["arbiter_decisions_total"] - baseline_total,
                    "delta_allow": current["arbiter_decisions_allow_total"] - baseline_allow,
                    "delta_deny": current["arbiter_decisions_deny_total"] - baseline_deny,
                }

                expected_total_min = float(stats.allow_intercepts_ok + stats.deny_intercepts_ok)
                if metrics_validation["delta_total"] < expected_total_min:
                    stats.add_failure(
                        f"metrics delta_total too low ({metrics_validation['delta_total']} < {expected_total_min})"
                    )

    summary = {
        "config": {
            "arbiter_url": arbiter_url,
            "duration_seconds": args.duration_seconds,
            "interval_ms": args.interval_ms,
            "tenant_id": args.tenant_id,
            "actor_id": args.actor_id,
            "loops": stats.loops,
        },
        "results": {
            "allow_intercepts_ok": stats.allow_intercepts_ok,
            "allow_intercepts_fail": stats.allow_intercepts_fail,
            "verify_ok": stats.verify_ok,
            "verify_fail": stats.verify_fail,
            "replay_expected_fail": stats.replay_expected_fail,
            "replay_unexpected": stats.replay_unexpected,
            "deny_intercepts_ok": stats.deny_intercepts_ok,
            "deny_intercepts_fail": stats.deny_intercepts_fail,
            "latency_ms": stats.latency_summary(),
            "metrics": metrics_validation,
        },
        "failures": stats.failures,
    }
    print(json.dumps(summary, indent=2))

    if stats.failures:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
