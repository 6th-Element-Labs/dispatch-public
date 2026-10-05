#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

for service in mail agent work web; do
  echo "install: services/${service}"
  npm --prefix "${ROOT}/services/${service}" install
done

