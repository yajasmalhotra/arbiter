#!/usr/bin/env bash
set -euo pipefail

DRY_RUN="${1:-}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
PACKAGE_JSON="${REPO_ROOT}/integrations/openclaw-plugin/package.json"

if ! command -v node >/dev/null 2>&1; then
  echo "node is required but not found in PATH."
  exit 1
fi

VERSION="$(node -e "console.log(require(process.argv[1]).version)" "$PACKAGE_JSON")"
TAG="openclaw-plugin-v${VERSION}"

if [[ -z "${VERSION}" ]]; then
  echo "failed to resolve version from ${PACKAGE_JSON}."
  exit 1
fi

if [[ "${DRY_RUN}" == "--dry-run" ]]; then
  if ! git -C "${REPO_ROOT}" diff --quiet || ! git -C "${REPO_ROOT}" diff --cached --quiet; then
    echo "dry run: working tree is not clean; a real tag run would fail."
  fi
  echo "dry run: would run 'git tag -a ${TAG} -m \"OpenClaw plugin ${VERSION}\"'"
  echo "dry run: would run 'git push origin ${TAG}'"
  exit 0
fi

if ! git -C "${REPO_ROOT}" diff --quiet || ! git -C "${REPO_ROOT}" diff --cached --quiet; then
  echo "working tree is not clean. commit or stash changes before tagging."
  exit 1
fi

if git -C "${REPO_ROOT}" rev-parse -q --verify "refs/tags/${TAG}" >/dev/null; then
  echo "tag ${TAG} already exists."
  exit 1
fi

if [[ -n "${DRY_RUN}" ]]; then
  echo "unknown argument: ${DRY_RUN}"
  echo "usage: npm run release:tag [-- --dry-run]"
  exit 1
fi

git -C "${REPO_ROOT}" tag -a "${TAG}" -m "OpenClaw plugin ${VERSION}"
git -C "${REPO_ROOT}" push origin "${TAG}"
echo "created and pushed ${TAG}"
