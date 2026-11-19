#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

step() {
  printf '\n== %s ==\n' "$*"
  "$@"
}

step npm run typecheck
step npm test
step npm run test:workerd
step npm run build

printf '\nCI passed.\n'
