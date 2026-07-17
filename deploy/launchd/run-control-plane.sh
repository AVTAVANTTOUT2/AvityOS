#!/usr/bin/env bash
# Launch helper for the AvityOS control plane under launchd.
# Does not contain secrets. Loads configuration from an external env file.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEFAULT_AVITY_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

AVITY_ROOT="${AVITY_ROOT:-${DEFAULT_AVITY_ROOT}}"
AVITY_ENV_FILE="${AVITY_ENV_FILE:-${HOME}/.config/avityos/control-plane.env}"
AVITY_LOG_DIR="${AVITY_LOG_DIR:-${HOME}/.avity/logs}"
NODE_BINARY="${NODE_BINARY:-}"

CONTROL_PLANE_ENTRYPOINT="${AVITY_ROOT}/services/control-plane/dist/main.js"

log() {
  printf '%s\n' "$*" >&2
}

die() {
  log "error: $*"
  exit 1
}

expand_path() {
  local value="$1"
  local tilde_slash
  # Expand a literal "~/..." prefix from config values (not shell tilde expansion).
  printf -v tilde_slash '%s/' '~'
  if [[ "${value}" == "${tilde_slash}"* ]]; then
    printf '%s\n' "${HOME}/${value#"${tilde_slash}"}"
  else
    printf '%s\n' "${value}"
  fi
}

check_env_permissions() {
  local file="$1"
  local mode=""

  if mode="$(stat -f '%Lp' "${file}" 2>/dev/null)"; then
    :
  elif mode="$(stat -c '%a' "${file}" 2>/dev/null)"; then
    :
  else
    die "unable to inspect permissions for ${file}"
  fi

  # Reject any group/other bits (must be owner-only, e.g. 600 or 400).
  if [[ "${mode}" =~ ^[0-7]+$ ]] && (( (8#${mode} & 8#077) != 0 )); then
    die "${file} has overly permissive mode ${mode}; run: chmod 600 ${file}"
  fi
}

load_env_file() {
  local file="$1"
  [[ -f "${file}" ]] || die "environment file not found: ${file}"
  [[ -r "${file}" ]] || die "environment file is not readable: ${file}"
  check_env_permissions "${file}"

  set -a
  # shellcheck disable=SC1090
  source "${file}"
  set +a
}

AVITY_ROOT="$(expand_path "${AVITY_ROOT}")"
AVITY_ENV_FILE="$(expand_path "${AVITY_ENV_FILE}")"
AVITY_LOG_DIR="$(expand_path "${AVITY_LOG_DIR}")"

load_env_file "${AVITY_ENV_FILE}"

# Re-resolve after env load so the external file can override defaults.
AVITY_ROOT="$(expand_path "${AVITY_ROOT:-${DEFAULT_AVITY_ROOT}}")"
AVITY_LOG_DIR="$(expand_path "${AVITY_LOG_DIR:-${HOME}/.avity/logs}")"
NODE_BINARY="$(expand_path "${NODE_BINARY:-}")"
CONTROL_PLANE_ENTRYPOINT="${AVITY_ROOT}/services/control-plane/dist/main.js"

mkdir -p "${AVITY_LOG_DIR}"

if [[ -z "${NODE_BINARY}" ]]; then
  NODE_BINARY="$(command -v node || true)"
fi
[[ -n "${NODE_BINARY}" ]] || die "Node.js binary not found; set NODE_BINARY to an absolute path"
[[ -x "${NODE_BINARY}" ]] || die "NODE_BINARY is not executable: ${NODE_BINARY}"

[[ -f "${CONTROL_PLANE_ENTRYPOINT}" ]] || die "control plane entrypoint not found: ${CONTROL_PLANE_ENTRYPOINT} (build with: pnpm -r build)"

export AVITY_ROOT AVITY_LOG_DIR NODE_BINARY

log "starting AvityOS control plane"
log "  root=${AVITY_ROOT}"
log "  entrypoint=${CONTROL_PLANE_ENTRYPOINT}"
log "  log_dir=${AVITY_LOG_DIR}"

# exec replaces this process so launchd signals reach Node directly.
exec "${NODE_BINARY}" "${CONTROL_PLANE_ENTRYPOINT}"
