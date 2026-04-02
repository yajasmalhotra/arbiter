#!/usr/bin/env bash

set -euo pipefail

tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT

generated_path_pattern='^apps/control-plane/\.next/|^apps/control-plane/\.data/control-plane\.json$|^apps/control-plane/\.DS_Store$'
tracked_file_pattern='(^|/)\.env($|\.)|(^|/)id_rsa$|(^|/)id_ed25519$|(^|/).+\.pem$|(^|/).+\.p12$|(^|/).+\.pfx$'
secret_pattern='BEGIN [A-Z ]*PRIVATE KEY|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,}|sk-[A-Za-z0-9]{20,}|previewModeSigningKey|previewModeEncryptionKey'

echo "[scan] checking tracked file hygiene"
if git ls-files | grep -E "${generated_path_pattern}|${tracked_file_pattern}" >"$tmp"; then
  echo "[scan] unexpected tracked generated or secret-like files:"
  cat "$tmp"
  exit 1
fi

echo "[scan] checking current tree for secret patterns"
if git grep -nI -E "$secret_pattern" -- . ':(exclude)package-lock.json' >"$tmp"; then
  echo "[scan] secret-like content found in current tree:"
  cat "$tmp"
  exit 1
fi

echo "[scan] checking reachable history for generated artifacts"
git log --all --name-only --pretty=format: | grep -E "$generated_path_pattern" >"$tmp" || true
if [[ -s "$tmp" ]]; then
  echo "[scan] generated control-plane artifacts still exist in reachable history:"
  cat "$tmp"
  exit 1
fi

echo "[scan] checking reachable history for preview-mode key leakage"
git grep -nI 'previewModeSigningKey\|previewModeEncryptionKey\|previewModeId' $(git rev-list --all) -- >"$tmp" 2>/dev/null || true
if [[ -s "$tmp" ]]; then
  echo "[scan] preview-mode keys found in reachable history:"
  cat "$tmp"
  exit 1
fi

echo "[scan] checking reachable history for common secret patterns"
git log --all -G "$secret_pattern" --oneline -- . >"$tmp" || true
if [[ -s "$tmp" ]]; then
  echo "[scan] secret-like patterns found in reachable history:"
  cat "$tmp"
  exit 1
fi

echo "[scan] passed"
