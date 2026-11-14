#!/usr/bin/env bash
# Copy this checkout to the VM and (re)start Inbound there.
#   scripts/deploy.sh ubuntu@203.0.113.10 [~/.ssh/oracle_key]
# Afterwards deploy/.env on this Mac holds the server address and phone token
# (not the OpenAI key) for scripts/release_miniapp.sh.
set -euo pipefail
target=${1:?Usage: scripts/deploy.sh user@host [ssh-key]}
ssh_opts=(-o StrictHostKeyChecking=accept-new)
if [ -n "${2:-}" ]; then ssh_opts+=(-i "$2"); fi
root=$(cd "$(dirname "$0")/.." && pwd)

rsync -az --delete -e "ssh ${ssh_opts[*]}" \
  --exclude .git --exclude .venv --exclude __pycache__ --exclude .pytest_cache --exclude runtime \
  --exclude app/node_modules --exclude app/dist --exclude app/build \
  --exclude deploy/.env --exclude deploy/data \
  "$root/" "$target:inbound/"
ssh "${ssh_opts[@]}" "$target" 'bash inbound/deploy/vm-setup.sh'

umask 077
ssh "${ssh_opts[@]}" "$target" 'grep -E "^INBOUND_(DEVICE_TOKEN|DASHBOARD_PASSWORD)=" inbound/deploy/.env; echo "INBOUND_URL=$(cat inbound/deploy/public-url)"' > "$root/deploy/.env"
. "$root/deploy/.env"
echo
echo "Dashboard: $INBOUND_URL  (any username; password is INBOUND_DASHBOARD_PASSWORD in deploy/.env)"
echo "Add OPENAI_API_KEY on the VM: ssh $target 'nano inbound/deploy/.env && sudo systemctl restart inbound'"
echo "Then install the MiniApp: scripts/release_miniapp.sh"
