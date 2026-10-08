#!/usr/bin/env bash
# Run Legion's checks on Linux from any machine with Docker (the architecture follows the Docker host).
#
#   scripts/linux/check.sh [unit|e2e|packaged|all] [playwright args…]     (default: unit)
#   scripts/linux/check.sh e2e tests/e2e/layout.spec.ts                    (one spec)
#
# unit: typecheck + vitest · e2e: build + Playwright against Electron under Xvfb · packaged: electron-builder --dir +
# the packaged-app test. Lint is left out: it doesn't depend on the OS. The working tree is copied in (read-only
# mount); node_modules are installed fresh inside, since the host's are built for the host.
set -euo pipefail
root=$(cd "$(dirname "$0")/../.." && pwd)
image=legion-linux-check

docker build --quiet --tag "$image" "$root/scripts/linux" >/dev/null
# seccomp=unconfined lets Chromium create the user namespaces its sandbox needs (Docker's default profile blocks them).
docker run --rm --init \
  --security-opt seccomp=unconfined \
  --shm-size=1g \
  --volume "$root:/src:ro" \
  --volume legion-linux-pnpm-store:/home/node/.pnpm-store \
  "$image" bash /src/scripts/linux/in-container.sh "${@:-unit}"
