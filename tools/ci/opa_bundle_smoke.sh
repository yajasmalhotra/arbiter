#!/usr/bin/env bash

set -euo pipefail

compose_file="deploy/docker-compose.yml"
bundle_token="${ARBITER_BUNDLE_SERVICE_TOKEN:-dev-bundle-token}"
artifact_url="http://localhost:3000/api/bundles/channels/prod/artifact"

cleanup() {
  docker compose -f "${compose_file}" down -v >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "[smoke] starting compose stack"
run_started_at="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
docker compose -f "${compose_file}" up -d --build control-plane postgres redis opa arbiter

echo "[smoke] waiting for control-plane artifact endpoint readiness"
artifact_deadline=$((SECONDS + 360))
while ((SECONDS < artifact_deadline)); do
  status_code="$(
    curl -sS --max-time 5 -o /dev/null -w "%{http_code}" \
      -H "Authorization: Bearer ${bundle_token}" \
      "${artifact_url}" || true
  )"
  if [[ "${status_code}" == "200" ]]; then
    echo "[smoke] control-plane artifact endpoint is ready"
    break
  fi
  sleep 5
done

if ((SECONDS >= artifact_deadline)); then
  echo "[smoke] timed out waiting for control-plane artifact endpoint readiness"
  docker compose -f "${compose_file}" logs --tail=200 control-plane postgres opa
  exit 1
fi

echo "[smoke] waiting for OPA bundle activation"
deadline=$((SECONDS + 240))
while ((SECONDS < deadline)); do
  logs="$(docker compose -f "${compose_file}" logs --since "${run_started_at}" --tail=200 opa || true)"
  if grep -q "digest mismatch" <<<"${logs}"; then
    echo "[smoke] digest mismatch found in OPA logs"
    echo "${logs}"
    exit 1
  fi
  if grep -q "Bundle loaded and activated successfully" <<<"${logs}"; then
    echo "[smoke] OPA bundle loaded without digest mismatch"
    break
  fi
  sleep 5
done

if ((SECONDS >= deadline)); then
  echo "[smoke] timed out waiting for OPA bundle activation"
  docker compose -f "${compose_file}" logs --tail=200 control-plane opa arbiter
  exit 1
fi

echo "[smoke] validating bundle artifact endpoint"
status_code="$(
  curl -sS -o /dev/null -w "%{http_code}" \
    -H "Authorization: Bearer ${bundle_token}" \
    "${artifact_url}"
)"
if [[ "${status_code}" != "200" ]]; then
  echo "[smoke] expected HTTP 200 from artifact endpoint, got ${status_code}"
  docker compose -f "${compose_file}" logs --tail=200 control-plane opa
  exit 1
fi

echo "[smoke] passed"
