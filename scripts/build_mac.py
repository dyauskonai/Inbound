"""Build the local macOS app shell; no publishing or developer account required."""
import plistlib
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BUNDLE = ROOT / "runtime" / "Inbound.app"
CONTENTS = BUNDLE / "Contents"
(CONTENTS / "MacOS").mkdir(parents=True, exist_ok=True)
(CONTENTS / "Resources").mkdir(exist_ok=True)
cache = ROOT / "runtime" / "swift-cache"
cache.mkdir(exist_ok=True)
subprocess.run([
    "xcrun", "swiftc", str(ROOT / "macos/Inbound.swift"), "-o", str(CONTENTS / "MacOS/Inbound"),
    "-module-cache-path", str(cache), "-framework", "AppKit", "-framework", "WebKit",
], check=True)
with (CONTENTS / "Info.plist").open("wb") as output:
    plistlib.dump({
        "CFBundleName": "Inbound", "CFBundleDisplayName": "Inbound",
        "CFBundleIdentifier": "com.inbound.desktop", "CFBundleExecutable": "Inbound",
        "CFBundlePackageType": "APPL", "CFBundleShortVersionString": "0.1.0",
        "CFBundleVersion": "1", "NSHighResolutionCapable": True,
        "NSCameraUsageDescription": "Record a training scenario for your Inbound handoff report.",
        "NSMicrophoneUsageDescription": "Record narration and recognize start, snap, and stop commands.",
        "NSLocalNetworkUsageDescription": "Receive recordings from your Mentra glasses on the local network.",
        "NSAppTransportSecurity": {"NSAllowsLocalNetworking": True},
        "InboundProjectRoot": str(ROOT),
    }, output)
subprocess.run(["codesign", "--force", "--deep", "--sign", "-", str(BUNDLE)], check=True, capture_output=True)
print(BUNDLE)
