#!/usr/bin/env bash
set -euo pipefail

dry_run="${1:-}"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "${script_dir}/../../.." && pwd)"
package_json="${repo_root}/integrations/pi-extension/package.json"
version="$(node -e "console.log(require(process.argv[1]).version)" "${package_json}")"
tag="pi-extension-v${version}"

if [[ -z "${version}" ]]; then
  echo "failed to resolve version from ${package_json}."
  exit 1
fi

if [[ "${dry_run}" == "--dry-run" ]]; then
  echo "dry run: would create and push ${tag}"
  exit 0
fi

if [[ -n "${dry_run}" ]]; then
  echo "usage: npm run release:tag [-- --dry-run]"
  exit 1
fi

if ! git -C "${repo_root}" diff --quiet || ! git -C "${repo_root}" diff --cached --quiet; then
  echo "working tree is not clean. commit or stash changes before tagging."
  exit 1
fi

if git -C "${repo_root}" rev-parse -q --verify "refs/tags/${tag}" >/dev/null; then
  echo "tag ${tag} already exists."
  exit 1
fi

git -C "${repo_root}" tag -a "${tag}" -m "Pi extension ${version}"
git -C "${repo_root}" push origin "${tag}"
echo "created and pushed ${tag}"
