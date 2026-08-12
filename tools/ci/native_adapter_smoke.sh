#!/usr/bin/env bash

set -euo pipefail

root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
tmp_dir="$(mktemp -d)"
runtime_pid=""

cleanup() {
  if [[ -n "${runtime_pid}" ]]; then
    kill "${runtime_pid}" >/dev/null 2>&1 || true
    wait "${runtime_pid}" >/dev/null 2>&1 || true
  fi
  rm -rf "${tmp_dir}"
}
trap cleanup EXIT

mkdir -p "${tmp_dir}/home/.arbiter/data"
token_secret="$(printf 'a%.0s' {1..64})"
node -e '
  const fs = require("fs");
  const path = require("path");
  const home = process.argv[1];
  const secret = process.argv[2];
  const data = path.join(home, ".arbiter", "data");
  fs.writeFileSync(path.join(home, ".arbiter", "config.json"), JSON.stringify({
    version: 1,
    address: "127.0.0.1:18080",
    base_url: "http://127.0.0.1:18080",
    tenant_id: "tenant-local",
    data_dir: data,
    db_path: path.join(data, "arbiter-local.db"),
    token_secret: secret
  }, null, 2) + "\n", { mode: 0o600 });
' "${tmp_dir}/home" "${token_secret}"

(
  cd "${root_dir}"
  go build -o "${tmp_dir}/arbiter" ./cmd/arbiter
)

HOME="${tmp_dir}/home" "${tmp_dir}/arbiter" local start >"${tmp_dir}/runtime.log" 2>&1 &
runtime_pid="$!"

for _ in {1..40}; do
  if curl -fsS "http://127.0.0.1:18080/healthz" >/dev/null 2>&1; then
    break
  fi
  if ! kill -0 "${runtime_pid}" >/dev/null 2>&1; then
    cat "${tmp_dir}/runtime.log" >&2
    exit 1
  fi
  sleep 0.25
done
curl -fsS "http://127.0.0.1:18080/healthz" >/dev/null

(
  cd "${root_dir}"
  HOME="${tmp_dir}/home" node ./tools/ci/native_adapter_smoke.mjs
)
