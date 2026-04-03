from __future__ import annotations

import json
import os
from pathlib import Path
import urllib.error
import urllib.request
from typing import Any


def _discover_local_base_url() -> str:
    config_path = os.environ.get("ARBITER_LOCAL_CONFIG_PATH", str(Path.home() / ".arbiter" / "config.json"))
    try:
        with open(config_path, "r", encoding="utf-8") as fh:
            data = json.load(fh)
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return "http://localhost:8080"

    if isinstance(data, dict):
        base_url = str(data.get("base_url", "")).strip()
        if base_url:
            return base_url.rstrip("/")
        address = str(data.get("address", "")).strip()
        if address:
            if address.startswith("http://") or address.startswith("https://"):
                return address.rstrip("/")
            return f"http://{address}"
    return "http://localhost:8080"


class ArbiterHTTPClient:
    def __init__(
        self,
        base_url: str = "",
        *,
        gateway_shared_key: str = "",
        service_shared_key: str = "",
        timeout_seconds: float = 10.0,
    ) -> None:
        resolved = base_url.strip() if isinstance(base_url, str) else ""
        if not resolved:
            resolved = _discover_local_base_url()
        self.base_url = resolved.rstrip("/")
        self.gateway_shared_key = gateway_shared_key.strip()
        self.service_shared_key = service_shared_key.strip()
        self.timeout_seconds = timeout_seconds

    def _headers(self, *, gateway: bool) -> dict[str, str]:
        headers = {
            "Accept": "application/json",
            "Content-Type": "application/json",
        }
        if gateway and self.gateway_shared_key:
            headers["X-Arbiter-Gateway-Key"] = self.gateway_shared_key
        if not gateway and self.service_shared_key:
            headers["X-Arbiter-Service-Key"] = self.service_shared_key
        return headers

    def _json_request(
        self,
        method: str,
        path: str,
        payload: dict[str, Any],
        *,
        gateway: bool,
    ) -> tuple[int, Any]:
        url = f"{self.base_url}{path}"
        raw = json.dumps(payload).encode("utf-8")
        req = urllib.request.Request(
            url,
            data=raw,
            headers=self._headers(gateway=gateway),
            method=method,
        )

        try:
            with urllib.request.urlopen(req, timeout=self.timeout_seconds) as resp:
                body = resp.read().decode("utf-8")
                if not body:
                    return resp.getcode(), None
                return resp.getcode(), json.loads(body)
        except urllib.error.HTTPError as err:
            body = err.read().decode("utf-8")
            if not body:
                return err.code, None
            try:
                return err.code, json.loads(body)
            except json.JSONDecodeError:
                return err.code, {"error": body}

    def intercept_openai(self, envelope: dict[str, Any]) -> tuple[int, Any]:
        return self._json_request("POST", "/v1/intercept/openai", envelope, gateway=True)

    def intercept_framework_generic(self, envelope: dict[str, Any]) -> tuple[int, Any]:
        return self._json_request("POST", "/v1/intercept/framework/generic", envelope, gateway=True)

    def verify_openai(self, token: str, envelope: dict[str, Any]) -> tuple[int, Any]:
        return self._json_request(
            "POST",
            "/v1/execute/verify/openai",
            {"token": token, "envelope": envelope},
            gateway=False,
        )

    def verify_canonical(self, token: str, request: dict[str, Any]) -> tuple[int, Any]:
        return self._json_request(
            "POST",
            "/v1/execute/verify/canonical",
            {"token": token, "request": request},
            gateway=False,
        )
