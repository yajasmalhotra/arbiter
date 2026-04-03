#!/usr/bin/env bash
set -euo pipefail

VERSION="${1:-}"
REPO="${2:-}"
CHECKSUMS_FILE="${3:-}"
OUTPUT_FILE="${4:-}"

if [[ -z "${VERSION}" || -z "${REPO}" || -z "${CHECKSUMS_FILE}" || -z "${OUTPUT_FILE}" ]]; then
  echo "usage: $0 <version> <repo> <checksums_file> <output_file>" >&2
  exit 1
fi

if [[ ! -f "${CHECKSUMS_FILE}" ]]; then
  echo "checksums file not found: ${CHECKSUMS_FILE}" >&2
  exit 1
fi

checksum_for() {
  local artifact="$1"
  awk -v name="${artifact}" '{
    file=$2
    sub(/^\.\//, "", file)
    if (file == name) {
      print $1
    }
  }' "${CHECKSUMS_FILE}"
}

DARWIN_AMD64="arbiter_${VERSION}_darwin_amd64.tar.gz"
DARWIN_ARM64="arbiter_${VERSION}_darwin_arm64.tar.gz"
LINUX_AMD64="arbiter_${VERSION}_linux_amd64.tar.gz"
LINUX_ARM64="arbiter_${VERSION}_linux_arm64.tar.gz"

DARWIN_AMD64_SHA="$(checksum_for "${DARWIN_AMD64}")"
DARWIN_ARM64_SHA="$(checksum_for "${DARWIN_ARM64}")"
LINUX_AMD64_SHA="$(checksum_for "${LINUX_AMD64}")"
LINUX_ARM64_SHA="$(checksum_for "${LINUX_ARM64}")"

for value in "${DARWIN_AMD64_SHA}" "${DARWIN_ARM64_SHA}" "${LINUX_AMD64_SHA}" "${LINUX_ARM64_SHA}"; do
  if [[ -z "${value}" ]]; then
    echo "missing checksum in ${CHECKSUMS_FILE}" >&2
    exit 1
  fi
done

BASE_URL="https://github.com/${REPO}/releases/download/arbiter-v${VERSION}"

cat > "${OUTPUT_FILE}" <<EOF
class Arbiter < Formula
  desc "Deterministic governance gate for LLM agent tool execution"
  homepage "https://github.com/${REPO}"
  license "Apache-2.0"
  version "${VERSION}"

  on_macos do
    if Hardware::CPU.arm?
      url "${BASE_URL}/${DARWIN_ARM64}"
      sha256 "${DARWIN_ARM64_SHA}"
    else
      url "${BASE_URL}/${DARWIN_AMD64}"
      sha256 "${DARWIN_AMD64_SHA}"
    end
  end

  on_linux do
    if Hardware::CPU.arm?
      url "${BASE_URL}/${LINUX_ARM64}"
      sha256 "${LINUX_ARM64_SHA}"
    else
      url "${BASE_URL}/${LINUX_AMD64}"
      sha256 "${LINUX_AMD64_SHA}"
    end
  end

  def install
    bin.install "arbiter"
  end

  test do
    system "#{bin}/arbiter", "local"
  end
end
EOF

echo "Wrote formula to ${OUTPUT_FILE}"
