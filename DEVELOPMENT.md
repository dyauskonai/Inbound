# Local development checkpoint

The working project is local. Nothing from this implementation has been pushed to GitHub. The existing README is unchanged.

## Run on this Mac

The Python environment, Bun executable, and app dependencies are already installed locally. VS Code has tasks under **Terminal → Run Task** for the Mac server, Mentra MiniApp, and backend tests. Stop an existing service before starting another copy on the same port.

```sh
# Terminal 1, from the repository root
.venv/bin/python scripts/dev.py --lan

# Terminal 2, from the repository root
export PATH="$PWD/runtime/bin:$PATH"
cd app
bun run dev
```

Dashboard: http://127.0.0.1:8000/. The MiniApp CLI prints its current QR code and a PNG path. A copy of the current QR is at `runtime/mentra-qr.png`.

## Phone

Open the regular Mentra app and connect Mentra Live. Under **Settings → Miniapp Developer Settings**, choose **Scan Miniapp QR Code**. Menu wording can vary by app version. Keep the phone, glasses, and Mac on the same reachable network. The glasses upload video directly to the Mac over Wi-Fi; Bluetooth pairing alone is insufficient.

Inbound's connection settings show the Mac address. Its default is detected when the MiniApp builds. Update it if the Mac changes networks. Voice recognition uses the Mentra app's on-device English speech model. Manual Start, Snap, and Stop controls are also available.

## AI setup

Copy `.env.example` to `.env`, enter `OPENAI_API_KEY` locally, restart the Mac server, then retry processing. API keys stay on the Mac. Live AI output has not been tested because no key is configured.

## Implemented and checked

- Mac camera recording and exact start/snap/stop commands, using a local Vosk model.
- Uploads, durable session storage, FFmpeg still/clip extraction, report generation adapter, evidence links, dashboard, JSON export, and print view.
- Mentra MiniApp using `@mentra/miniapp` 3.4.0, with video capture/upload, voice commands, phone controls, and a saved session journal.
- Backend tests: 8 passing. MiniApp TypeScript check and production build pass.
- Synthetic browser capture exercised voice start → snap → stop → upload → still/clip extraction. This did not use the actual glasses.

## Remaining device checks

- Load the QR on the physical iPhone and verify this Mentra app version supports the MiniApp APIs.
- Verify glasses video includes audio and can upload to the Mac on venue Wi-Fi.
- Test commands on the glasses, including noisy surroundings and stop/retry behavior.
- Add an OpenAI key and validate the actual transcript and report quality.
- Snap timing is approximate: the MiniApp SDK provides no word timestamps or recording clock. Stills are extracted after upload; this is not an immediate camera photo.

Use fictional training data. The report is a summary of captured evidence, not a diagnosis or treatment recommendation. The prototype's local server has no production patient-data protections.

The earlier native Bluetooth prototype is retained only in ignored `runtime/native-prototype/`. The active phone project is `app/`, which runs inside Mentra. Do not upload the repo or replace its README without Dyaus's approval.
