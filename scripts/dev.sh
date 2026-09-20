#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
pids=()

cleanup() {
  for pid in "${pids[@]:-}"; do
    kill "$pid" 2>/dev/null || true
  done
}
trap cleanup EXIT INT TERM

bash "${ROOT}/scripts/dev-service.sh" "${ROOT}" mail &
pids+=("$!")
bash "${ROOT}/scripts/dev-service.sh" "${ROOT}" agent &
pids+=("$!")
bash "${ROOT}/scripts/dev-service.sh" "${ROOT}" web &
pids+=("$!")

wait
