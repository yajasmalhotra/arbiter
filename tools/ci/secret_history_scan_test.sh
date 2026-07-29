#!/usr/bin/env bash

set -euo pipefail

scanner="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/secret_history_scan.sh"
test_root="$(mktemp -d)"
trap 'rm -rf "$test_root"' EXIT

new_repo() {
  local name="$1"
  local repo="${test_root}/${name}"
  mkdir -p "${repo}/tools/ci"
  cp "$scanner" "${repo}/tools/ci/secret_history_scan.sh"
  chmod +x "${repo}/tools/ci/secret_history_scan.sh"
  git -C "$repo" init -q
  git -C "$repo" config user.name "Arbiter CI"
  git -C "$repo" config user.email "ci@arbiter.invalid"
  printf '%s\n' "clean fixture" >"${repo}/README.md"
  git -C "$repo" add .
  git -C "$repo" commit -qm "initial"
  printf '%s\n' "$repo"
}

expect_failure() {
  local description="$1"
  local repo="$2"
  if (cd "$repo" && ./tools/ci/secret_history_scan.sh >/dev/null 2>&1); then
    echo "[test] expected scanner failure: ${description}" >&2
    exit 1
  fi
}

echo "[test] clean repository passes"
repo="$(new_repo clean)"
(cd "$repo" && ./tools/ci/secret_history_scan.sh >/dev/null)

echo "[test] current token leakage fails"
repo="$(new_repo current-token)"
printf 'gh%s%s\n' 'p_' '0123456789abcdefghijklmnop' >"${repo}/leaked.txt"
git -C "$repo" add leaked.txt
expect_failure "current token" "$repo"

echo "[test] historical token leakage fails after deletion"
repo="$(new_repo historical-token)"
printf 'gh%s%s\n' 'p_' '0123456789abcdefghijklmnop' >"${repo}/leaked.txt"
git -C "$repo" add leaked.txt
git -C "$repo" commit -qm "add leak"
git -C "$repo" rm -q leaked.txt
git -C "$repo" commit -qm "remove leak"
expect_failure "historical token" "$repo"

echo "[test] generated build artifacts fail"
repo="$(new_repo generated-artifact)"
mkdir -p "${repo}/apps/control-plane/.next"
printf '%s\n' "generated" >"${repo}/apps/control-plane/.next/BUILD_ID"
git -C "$repo" add -f apps/control-plane/.next/BUILD_ID
expect_failure "tracked generated artifact" "$repo"

echo "[test] documented and test-only PEM placeholders pass"
repo="$(new_repo placeholders)"
mkdir -p \
  "${repo}/apps/control-plane/lib" \
  "${repo}/cmd/arbiter-mcp" \
  "${repo}/cmd/interceptor" \
  "${repo}/deploy"
printf '%s %s %s%s%s %s %s\n' \
  'const secret = "-----BEGIN' 'PRIVATE' 'KEY-----\\n' \
  'private-material' '\\n-----END' 'PRIVATE' 'KEY-----";' \
  >"${repo}/apps/control-plane/lib/signing-key-encryption.test.ts"
printf '%s %s %s\n' \
  'RS256PrivateKey: "-----BEGIN' 'PRIVATE' 'KEY-----...",' \
  >"${repo}/cmd/arbiter-mcp/production_test.go"
printf '%s %s %s\n' \
  'RS256PrivateKey: "-----BEGIN' 'PRIVATE' 'KEY-----...",' \
  >"${repo}/cmd/interceptor/production_test.go"
printf '%s %s %s\n' \
  '# ARBITER_BUNDLE_SIGNING_SECRET=-----BEGIN' 'PRIVATE' 'KEY-----...' \
  >"${repo}/deploy/env.example"
git -C "$repo" add .
git -C "$repo" commit -qm "add inert placeholders"
(cd "$repo" && ./tools/ci/secret_history_scan.sh >/dev/null)

echo "[test] real PEM marker in an allowlisted fixture path still fails"
repo="$(new_repo real-key-in-fixture)"
mkdir -p "${repo}/apps/control-plane/lib"
{
  printf '%s %s %s\n' '-----BEGIN' 'PRIVATE' 'KEY-----'
  printf '%s\n' 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASC'
  printf '%s %s %s\n' '-----END' 'PRIVATE' 'KEY-----'
} >"${repo}/apps/control-plane/lib/signing-key-encryption.test.ts"
git -C "$repo" add .
expect_failure "real PEM marker in fixture path" "$repo"

echo "[test] secret history scanner passed"
