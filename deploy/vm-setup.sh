#!/usr/bin/env bash
# Install or update Inbound on a Linux VM (target: Oracle Cloud Ubuntu, ARM or x86).
# Inbound gets its own Python inside ~/inbound and a systemd service, inbound,
# on 127.0.0.1:8000. INBOUND_PUBLIC in deploy/.env picks how it reaches the internet:
#   tunnel (default)  inbound-tunnel: a Cloudflare quick tunnel. Needs no open ports
#                     or account, but its random address changes if the tunnel restarts.
#   caddy             inbound-caddy: HTTPS on ports 80/443 for INBOUND_DOMAIN. Needs those
#                     ports open in the cloud firewall (Oracle: the VCN security list).
# Other software on the VM is left alone. Safe to re-run: deploy/.env, the saved
# captures in deploy/data, and a running tunnel's address are kept.
set -euo pipefail
cd "$(dirname "$0")/.."
root=$(pwd)
user=$(id -un)
CADDY_VERSION=2.10.0

# Python 3.13 managed by uv, so the system Python stays untouched.
if [ ! -x "$HOME/.local/bin/uv" ]; then curl -LsSf https://astral.sh/uv/install.sh | UV_NO_MODIFY_PATH=1 INSTALLER_NO_MODIFY_PATH=1 sh; fi
uv="$HOME/.local/bin/uv"
[ -x .venv/bin/python ] || "$uv" venv --quiet --python 3.13 .venv
# Vosk only serves the Mac recorder's local voice commands, which the internet server doesn't offer.
grep -v '^vosk' requirements.txt > .venv/requirements-server.txt
"$uv" pip install --quiet --python .venv/bin/python -r .venv/requirements-server.txt
.venv/bin/python -c "import imageio_ffmpeg, subprocess; subprocess.run([imageio_ffmpeg.get_ffmpeg_exe(), '-version'], check=True, capture_output=True)" \
  || command -v ffmpeg >/dev/null || sudo apt-get install -y ffmpeg

arch=$(uname -m | sed 's/aarch64/arm64/; s/x86_64/amd64/')
if [ ! -x /usr/local/bin/cloudflared ]; then
  sudo curl -fsSL -o /usr/local/bin/cloudflared "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${arch}"
  sudo chmod +x /usr/local/bin/cloudflared
fi
if [ "$(caddy version 2>/dev/null | cut -d' ' -f1)" != "v$CADDY_VERSION" ]; then
  curl -fsSL "https://github.com/caddyserver/caddy/releases/download/v$CADDY_VERSION/caddy_${CADDY_VERSION}_linux_${arch}.tar.gz" | sudo tar -xz -C /usr/local/bin caddy
fi

if [ ! -f deploy/.env ]; then
  ip=$(curl -fsS https://api.ipify.org)
  (umask 077; cat > deploy/.env <<SETTINGS
# A free hostname that points at this VM, so Caddy can get an HTTPS certificate.
# Replace it with your own domain if you have one.
INBOUND_PUBLIC=tunnel
INBOUND_DOMAIN=${ip//./-}.sslip.io
INBOUND_DEVICE_TOKEN=$(openssl rand -hex 24)
INBOUND_DASHBOARD_PASSWORD=$(openssl rand -base64 18 | tr -d '/+=' | cut -c1-16)
OPENAI_API_KEY=
OPENAI_TRANSCRIBE_MODEL=gpt-transcribe
OPENAI_REPORT_MODEL=gpt-4.1
SETTINGS
  )
  echo "Created deploy/.env with new access secrets."
fi
mkdir -p deploy/data

# Oracle images reject web traffic in the VM's own firewall, even after the
# cloud security list allows it. Insert the rules ahead of the final REJECT.
for port in 80 443; do
  sudo iptables -C INPUT -p tcp --dport "$port" -j ACCEPT 2>/dev/null && continue
  reject=$(sudo iptables -L INPUT --line-numbers -n | awk '$2 == "REJECT" {print $1; exit}')
  if [ -n "$reject" ]; then sudo iptables -I INPUT "$reject" -p tcp --dport "$port" -j ACCEPT
  else sudo iptables -A INPUT -p tcp --dport "$port" -j ACCEPT; fi
done
if command -v netfilter-persistent >/dev/null; then sudo netfilter-persistent save >/dev/null 2>&1 || true; fi

sudo tee /etc/systemd/system/inbound.service >/dev/null <<UNIT
[Unit]
Description=Inbound handoff server
After=network-online.target

[Service]
User=$user
WorkingDirectory=$root
EnvironmentFile=$root/deploy/.env
Environment=INBOUND_DATA_DIR=$root/deploy/data PYTHONUNBUFFERED=1
ExecStart=$root/.venv/bin/uvicorn server.main:app --host 127.0.0.1 --port 8000 --proxy-headers
Restart=always
# Keep the VM's other workloads responsive while a report is processing.
Nice=5

[Install]
WantedBy=multi-user.target
UNIT
sudo tee /etc/systemd/system/inbound-caddy.service >/dev/null <<UNIT
[Unit]
Description=HTTPS for Inbound
After=network-online.target inbound.service

[Service]
User=$user
EnvironmentFile=$root/deploy/.env
ExecStart=/usr/local/bin/caddy run --config $root/deploy/Caddyfile --adapter caddyfile
ExecReload=/usr/local/bin/caddy reload --config $root/deploy/Caddyfile --adapter caddyfile
AmbientCapabilities=CAP_NET_BIND_SERVICE
Restart=always

[Install]
WantedBy=multi-user.target
UNIT
sudo tee /etc/systemd/system/inbound-tunnel.service >/dev/null <<UNIT
[Unit]
Description=Public HTTPS address for Inbound (Cloudflare quick tunnel)
After=network-online.target inbound.service

[Service]
User=$user
ExecStart=/usr/local/bin/cloudflared tunnel --no-autoupdate --url http://127.0.0.1:8000
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT
sudo systemctl daemon-reload
sudo systemctl enable --quiet inbound
sudo systemctl restart inbound
mode=$(sed -n 's/^INBOUND_PUBLIC=//p' deploy/.env)
if [ "${mode:-tunnel}" = caddy ]; then
  sudo systemctl disable --quiet --now inbound-tunnel 2>/dev/null || true
  sudo systemctl enable --quiet inbound-caddy
  sudo systemctl restart inbound-caddy
  url="https://$(sed -n 's/^INBOUND_DOMAIN=//p' deploy/.env)"
else
  sudo systemctl disable --quiet --now inbound-caddy 2>/dev/null || true
  sudo systemctl enable --quiet inbound-tunnel
  # Restarting the tunnel would change its address, so leave a running one alone.
  systemctl is-active --quiet inbound-tunnel || sudo systemctl restart inbound-tunnel
  url=""
  for _ in $(seq 30); do
    url=$(sudo journalctl -u inbound-tunnel --no-pager -o cat | grep -o 'https://[-a-z0-9]*\.trycloudflare\.com' | tail -1)
    [ -n "$url" ] && break
    sleep 1
  done
fi
echo "$url" > deploy/public-url
sleep 2
systemctl is-active inbound
echo "Public address: ${url:-not ready yet}"
