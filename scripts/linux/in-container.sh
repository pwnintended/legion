#!/usr/bin/env bash
# Runs inside the check container (see check.sh): copy the tree, install, run the requested checks.
set -euo pipefail
mode=${1:-unit}
shift || true

tar -C /src \
  --exclude=./node_modules --exclude=./out --exclude=./dist --exclude=./test-results \
  --exclude=./playwright-report --exclude=./trailer --exclude=./.legion-test \
  -cf - . | tar -xf -
pnpm install --frozen-lockfile --reporter=append-only

run_unit() { pnpm typecheck && pnpm test; }
run_e2e() { xvfb-run --auto-servernum pnpm test:e2e "$@"; }
run_packaged() { xvfb-run --auto-servernum pnpm test:packaged; }

case "$mode" in
  unit) run_unit ;;
  e2e) run_e2e "$@" ;;
  packaged) run_packaged ;;
  all) run_unit && run_e2e && run_packaged ;;
  *) echo "unknown mode: $mode (unit|e2e|packaged|all)" >&2; exit 2 ;;
esac
