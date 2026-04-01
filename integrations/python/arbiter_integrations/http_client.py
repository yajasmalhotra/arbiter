from __future__ import annotations

import json
import urllib.error
import urllib.request
from typing import Any


class ArbiterHTTPClient:
    def __init__(
        self,
        base_url: str,
        *,
        gateway_shared_key: str = "",
        service_shared_key: str = "",
        timeout_seconds: float = 10.0,
    ) -> None:
        self.base_url = base_url.rstrip("/")
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
