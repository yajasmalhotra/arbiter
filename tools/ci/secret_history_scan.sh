#!/usr/bin/env bash

set -euo pipefail

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT
matches="${tmp_dir}/matches"
filtered="${tmp_dir}/filtered"

generated_path_pattern='^apps/control-plane/\.next/|^apps/control-plane/\.data/control-plane\.json$|^apps/control-plane/\.DS_Store$'
tracked_file_pattern='(^|/)\.env($|\.)|(^|/)id_rsa$|(^|/)id_ed25519$|(^|/).+\.pem$|(^|/).+\.p12$|(^|/).+\.pfx$'
secret_pattern='BEGIN [A-Z ]*PRIVATE KEY|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,}|sk-[A-Za-z0-9]{20,}|previewModeSigningKey|previewModeEncryptionKey'
# These are exact, inert placeholders used to verify fail-closed production
# configuration and document PEM-valued settings. The match is line-scoped,
# so real key material or another token in the same files is still rejected.
allowed_secret_match_pattern='^([0-9a-f]{40}:)?(apps/control-plane/lib/signing-key-encryption\.test\.ts:[0-9]+:.*BEGIN PRIVATE KEY.*private-material.*END PRIVATE KEY.*|cmd/(arbiter-mcp|interceptor)/production_test\.go:[0-9]+:[[:space:]]*RS256PrivateKey:[[:space:]]*"-----BEGIN PRIVATE KEY-----\.\.\.",|deploy/env\.example:[0-9]+:# ARBITER_(BUNDLE_SIGNING_SECRET|TOKEN_RS256_PRIVATE_KEY|CAPABILITY_PRIVATE_KEY)=-----BEGIN PRIVATE KEY-----\.\.\.)$'
history_revset="${ARB_HISTORY_SCAN_REVSET:-HEAD}"

filter_allowed_placeholders() {
  grep -E -v "$allowed_secret_match_pattern" "$matches" >"$filtered" || true
  mv "$filtered" "$matches"
}

echo "[scan] checking tracked file hygiene"
if git ls-files | grep -E "${generated_path_pattern}|${tracked_file_pattern}" >"$matches"; then
  echo "[scan] unexpected tracked generated or secret-like files:"
  cat "$matches"
  exit 1
fi

echo "[scan] checking current tree for secret patterns"
git grep -nI -E "$secret_pattern" -- . \
  ':(exclude)package-lock.json' \
  ':(exclude)tools/ci/secret_history_scan.sh' >"$matches" || true
filter_allowed_placeholders
if [[ -s "$matches" ]]; then
  echo "[scan] secret-like content found in current tree:"
  cat "$matches"
  exit 1
fi

echo "[scan] checking ${history_revset} ancestry for generated artifacts"
git log "$history_revset" --name-only --pretty=format: | grep -E "$generated_path_pattern" >"$matches" || true
if [[ -s "$matches" ]]; then
  echo "[scan] generated control-plane artifacts still exist in ${history_revset} ancestry:"
  cat "$matches"
  exit 1
fi

echo "[scan] checking ${history_revset} ancestry for preview-mode key leakage"
git grep -nI 'previewModeSigningKey\|previewModeEncryptionKey\|previewModeId' \
  $(git rev-list "$history_revset") -- \
  ':(exclude)tools/ci/secret_history_scan.sh' >"$matches" 2>/dev/null || true
if [[ -s "$matches" ]]; then
  echo "[scan] preview-mode keys found in ${history_revset} ancestry:"
  cat "$matches"
  exit 1
fi

echo "[scan] checking ${history_revset} ancestry for common secret patterns"
git grep -nI -E "$secret_pattern" $(git rev-list "$history_revset") -- . \
  ':(exclude)package-lock.json' \
  ':(exclude)tools/ci/secret_history_scan.sh' >"$matches" 2>/dev/null || true
filter_allowed_placeholders
if [[ -s "$matches" ]]; then
  echo "[scan] secret-like patterns found in ${history_revset} ancestry:"
  cat "$matches"
  exit 1
fi

echo "[scan] passed"
