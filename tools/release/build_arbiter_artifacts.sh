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
  bin_path="${DIST_DIR}/arbiter"
  archive="arbiter_${VERSION}_${goos}_${goarch}.tar.gz"

  echo "Building ${goos}/${goarch}..."
  (
    cd "${ROOT_DIR}"
    CGO_ENABLED=0 GOOS="${goos}" GOARCH="${goarch}" \
      go build -trimpath -ldflags="-s -w" -o "${bin_path}" ./cmd/arbiter
  )

  (
    cd "${DIST_DIR}"
    tar -czf "${archive}" arbiter
    rm -f arbiter
  )
done

(
  cd "${DIST_DIR}"
  sha256sum ./*.tar.gz > checksums.txt
)

echo "Artifacts written to ${DIST_DIR}"

