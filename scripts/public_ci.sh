#!/usr/bin/env bash
set -euo pipefail

bash scripts/dispatch_ci.sh
node scripts/check-dependency-licenses.mjs --check THIRD_PARTY_NOTICES.md
