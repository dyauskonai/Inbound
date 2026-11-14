#!/usr/bin/env bash
# Build the MiniApp for the internet server in deploy/.env and serve an install
# QR on this network. Phones keep the installed MiniApp; after installing they
# reach the server over cellular or any Wi-Fi, with no laptop.
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
. "$root/deploy/.env"
cd "$root/app"
bun=(bun)
command -v bun >/dev/null || bun=(npx -y bun@1.2.21)
INBOUND_SERVER="${INBOUND_URL:?Run scripts/deploy.sh first}" INBOUND_TOKEN="$INBOUND_DEVICE_TOKEN" "${bun[@]}" run release --no-cache
