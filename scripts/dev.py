"""Start the local Inbound dashboard. Use --lan for a phone on the same network.

--tunnel also opens a Cloudflare quick tunnel so the glasses can upload their video
over the internet when their Wi-Fi can't reach this Mac. Only video uploads with the
phone's per-capture key get through it.
"""
import argparse
import os
import atexit
import re
import shutil
import signal
import subprocess
import sys
import threading
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
os.chdir(ROOT)

def start_tunnel(port: int):
    binary = shutil.which("cloudflared")
    if not binary:
        raise SystemExit("Install cloudflared first: brew install cloudflared")
    # An outgoing connection to Cloudflare; no port opens on this Mac.
    process = subprocess.Popen([binary, "tunnel", "--no-autoupdate", "--url", f"http://127.0.0.1:{port}"],
                               stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
    found = []

    def read():
        for line in process.stderr:
            match = re.search(r"https://[-a-z0-9]+\.trycloudflare\.com", line)
            if match and not found:
                found.append(match[0])
    threading.Thread(target=read, daemon=True).start()
    deadline = time.monotonic() + 45
    while not found:
        if process.poll() is not None or time.monotonic() > deadline:
            process.terminate()
            raise SystemExit("Could not open the Cloudflare tunnel. Check this Mac's internet connection.")
        time.sleep(0.2)
    return process, found[0]


if __name__ == "__main__":
    import uvicorn
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--lan", action="store_true", help="Listen on the local network for Mentra uploads")
    parser.add_argument("--port", default=8000, type=int)
    parser.add_argument("--rtmp-port", default=1935, type=int, help="Local port for live glasses video")
    parser.add_argument("--tunnel", action="store_true", help="Let the glasses upload video over the internet")
    args = parser.parse_args()
    if args.lan:
        os.environ["INBOUND_RTMP_PORT"] = str(args.rtmp_port)
    if args.tunnel:
        tunnel, os.environ["INBOUND_PUBLIC_URL"] = start_tunnel(args.port)
        # Close the tunnel with the server, however it stops. Uvicorn re-raises the signal
        # that stopped it, so handle it here instead of relying on `finally`.
        atexit.register(tunnel.terminate)
        for stop in (signal.SIGTERM, signal.SIGHUP):
            signal.signal(stop, lambda *_: sys.exit(0))
        print(f"Glasses video uploads go through {os.environ['INBOUND_PUBLIC_URL']} (video uploads only)", flush=True)
    uvicorn.run("server.main:app", host="0.0.0.0" if args.lan else "127.0.0.1", port=args.port)
