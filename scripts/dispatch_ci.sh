#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

node "${ROOT}/scripts/check-boundaries.mjs"

script_tests=()
for candidate in "${ROOT}"/scripts/*.test.mjs "${ROOT}"/apps/desktop/scripts/*.test.mjs; do
  [ -f "$candidate" ] && script_tests+=("$candidate")
done
if [ "${#script_tests[@]}" -gt 0 ]; then
  node --test "${script_tests[@]}"
fi

for service in mail agent web; do
  echo "verify: services/${service}"
  npm --prefix "${ROOT}/services/${service}" ci --prefer-offline --no-audit --no-fund
  npm --prefix "${ROOT}/services/${service}" run typecheck
  npm --prefix "${ROOT}/services/${service}" test
done

npm --prefix "${ROOT}/services/web" run build
npm --prefix "${ROOT}/services/web" run test:ui
