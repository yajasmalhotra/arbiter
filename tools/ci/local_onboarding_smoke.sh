#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
smoke_dir="$(mktemp -d)"
arbiter_binary="${smoke_dir}/arbiter"
config_path="${smoke_dir}/config.json"

cleanup() {
  ARBITER_LOCAL_CONFIG="${config_path}" "${arbiter_binary}" local stop >/dev/null 2>&1 || true
  rm -rf "${smoke_dir}"
}
trap cleanup EXIT

cd "${repo_root}"
go build -o "${arbiter_binary}" ./cmd/arbiter

onboard_output="$(ARBITER_LOCAL_CONFIG="${config_path}" "${arbiter_binary}" onboard --harness custom)"
grep -q "Arbiter started in the background" <<<"${onboard_output}"

ARBITER_LOCAL_CONFIG="${config_path}" "${arbiter_binary}" local status | grep -q "Local runtime is ready"
ARBITER_LOCAL_CONFIG="${config_path}" "${arbiter_binary}" doctor --harness custom | grep -q "Runtime ready"

repeat_output="$(ARBITER_LOCAL_CONFIG="${config_path}" "${arbiter_binary}" onboard --harness custom)"
grep -q "Arbiter is already ready" <<<"${repeat_output}"

ARBITER_LOCAL_CONFIG="${config_path}" "${arbiter_binary}" local stop | grep -q "Stopped local Arbiter runtime"
if ARBITER_LOCAL_CONFIG="${config_path}" "${arbiter_binary}" local status >/dev/null 2>&1; then
  echo "local runtime remained reachable after stop" >&2
  exit 1
fi
if [[ -e "${smoke_dir}/data/runtime.json" ]]; then
  echo "local runtime state remained after stop" >&2
  exit 1
fi

echo "local onboarding smoke passed"
