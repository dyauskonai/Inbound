"""Start the local Inbound dashboard. Use --lan for a phone on the same network."""
import argparse
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
os.chdir(ROOT)

if __name__ == "__main__":
    import uvicorn
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--lan", action="store_true", help="Listen on the local network for Mentra uploads")
    parser.add_argument("--port", default=8000, type=int)
    args = parser.parse_args()
    uvicorn.run("server.main:app", host="0.0.0.0" if args.lan else "127.0.0.1", port=args.port)
