#!/usr/bin/env bash
set -euo pipefail

REPO="${ARBITER_INSTALL_REPO:-yajasmalhotra/arbiter}"
VERSION_INPUT="${ARBITER_VERSION:-latest}"
INSTALL_DIR="${ARBITER_INSTALL_DIR:-}"

usage() {
  cat <<'EOF'
Usage: install.sh [--version <semver>] [--install-dir <path>]

Environment variables:
  ARBITER_VERSION        Version without leading v (default: latest release)
  ARBITER_INSTALL_DIR    Install directory override
  ARBITER_INSTALL_REPO   GitHub repo owner/name (default: yajasmalhotra/arbiter)
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --version)
      VERSION_INPUT="${2:-}"
      shift 2
      ;;
    --install-dir)
      INSTALL_DIR="${2:-}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "unknown argument: $1" >&2
      usage
      exit 1
      ;;
  esac
done

if ! command -v curl >/dev/null 2>&1; then
  echo "curl is required." >&2
  exit 1
fi

detect_os() {
  local os
  os="$(uname -s | tr '[:upper:]' '[:lower:]')"
  case "${os}" in
    darwin|linux) echo "${os}" ;;
    *)
      echo "unsupported OS: ${os}" >&2
      exit 1
      ;;
  esac
}

detect_arch() {
  local arch
  arch="$(uname -m)"
  case "${arch}" in
    x86_64|amd64) echo "amd64" ;;
    arm64|aarch64) echo "arm64" ;;
    *)
      echo "unsupported architecture: ${arch}" >&2
      exit 1
      ;;
  esac
}

latest_version() {
  local api_url tag
  api_url="https://api.github.com/repos/${REPO}/releases/latest"
  tag="$(curl -fsSL "${api_url}" | grep -m1 '"tag_name"' | sed -E 's/.*"([^"]+)".*/\1/' || true)"
  if [[ -z "${tag}" ]]; then
    echo "failed to resolve latest release from ${api_url}" >&2
    echo "set ARBITER_VERSION or pass --version <semver>" >&2
    exit 1
  fi
  echo "${tag#arbiter-v}"
}

if [[ "${VERSION_INPUT}" == "latest" ]]; then
  VERSION="$(latest_version)"
else
  VERSION="${VERSION_INPUT#v}"
fi

OS="$(detect_os)"
ARCH="$(detect_arch)"
ASSET="arbiter_${VERSION}_${OS}_${ARCH}.tar.gz"
BASE_URL="https://github.com/${REPO}/releases/download/arbiter-v${VERSION}"

tmpdir="$(mktemp -d)"
cleanup() {
  rm -rf "${tmpdir}"
}
trap cleanup EXIT

echo "Downloading ${ASSET}..."
curl -fsSL "${BASE_URL}/${ASSET}" -o "${tmpdir}/${ASSET}"
curl -fsSL "${BASE_URL}/checksums.txt" -o "${tmpdir}/checksums.txt"

expected_sha="$(awk -v name="${ASSET}" '{
  file=$2
  sub(/^\.\//, "", file)
  if (file == name) print $1
}' "${tmpdir}/checksums.txt")"

if [[ -z "${expected_sha}" ]]; then
  echo "missing checksum for ${ASSET}" >&2
  exit 1
fi

if command -v sha256sum >/dev/null 2>&1; then
  actual_sha="$(sha256sum "${tmpdir}/${ASSET}" | awk '{print $1}')"
elif command -v shasum >/dev/null 2>&1; then
  actual_sha="$(shasum -a 256 "${tmpdir}/${ASSET}" | awk '{print $1}')"
else
  echo "sha256sum or shasum is required for checksum verification." >&2
  exit 1
fi

if [[ "${expected_sha}" != "${actual_sha}" ]]; then
  echo "checksum mismatch for ${ASSET}" >&2
  exit 1
fi

tar -xzf "${tmpdir}/${ASSET}" -C "${tmpdir}"
if [[ ! -f "${tmpdir}/arbiter" ]]; then
  echo "release archive missing arbiter binary" >&2
  exit 1
fi

if [[ -z "${INSTALL_DIR}" ]]; then
  if [[ -w "/usr/local/bin" ]]; then
    INSTALL_DIR="/usr/local/bin"
  else
    INSTALL_DIR="${HOME}/.local/bin"
  fi
fi

mkdir -p "${INSTALL_DIR}"
target="${INSTALL_DIR}/arbiter"

if [[ -w "${INSTALL_DIR}" ]]; then
  install -m 755 "${tmpdir}/arbiter" "${target}"
else
  if command -v sudo >/dev/null 2>&1; then
    sudo install -m 755 "${tmpdir}/arbiter" "${target}"
  else
    echo "install directory is not writable and sudo is unavailable: ${INSTALL_DIR}" >&2
    exit 1
  fi
fi

echo "Installed arbiter ${VERSION} to ${target}"
if [[ ":${PATH}:" != *":${INSTALL_DIR}:"* ]]; then
  echo "Add ${INSTALL_DIR} to PATH if needed."
fi
echo "Next:"
echo "  arbiter local init"
echo "  arbiter local start"

