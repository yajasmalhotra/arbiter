#!/usr/bin/env bash
set -euo pipefail

VERSION="${1:-}"
if [[ -z "${VERSION}" ]]; then
  echo "usage: $0 <version>" >&2
  exit 1
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DIST_DIR="${ROOT_DIR}/dist"

rm -rf "${DIST_DIR}"
mkdir -p "${DIST_DIR}"

platforms=(
  "darwin amd64"
  "darwin arm64"
  "linux amd64"
  "linux arm64"
)

for platform in "${platforms[@]}"; do
  read -r goos goarch <<<"${platform}"
  archive="arbiter_${VERSION}_${goos}_${goarch}.tar.gz"

  echo "Building ${goos}/${goarch}..."
  (
    cd "${ROOT_DIR}"
    CGO_ENABLED=0 GOOS="${goos}" GOARCH="${goarch}" \
      go build -trimpath -ldflags="-s -w" -o "${DIST_DIR}/arbiter" ./cmd/arbiter
    CGO_ENABLED=0 GOOS="${goos}" GOARCH="${goarch}" \
      go build -trimpath -ldflags="-s -w" -o "${DIST_DIR}/arbiter-mcp" ./cmd/arbiter-mcp
  )

  (
    cd "${DIST_DIR}"
    tar -czf "${archive}" arbiter arbiter-mcp
    rm -f arbiter arbiter-mcp
  )
done

(
  cd "${DIST_DIR}"
  sha256sum ./*.tar.gz > checksums.txt
)

echo "Artifacts written to ${DIST_DIR}"
