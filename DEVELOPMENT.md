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

Dashboard: http://127.0.0.1:8000/. The MiniApp CLI prints its current QR code and a PNG path.

## Phone

Open the regular Mentra app and connect Mentra Live. Under **Settings → Miniapp Developer Settings**, choose **Scan Miniapp QR Code**. Menu wording can vary by app version. Keep the phone, glasses, and Mac on the same reachable network. With the Mac server running in `--lan` mode, the glasses send video directly to the Mac over Wi-Fi while recording. Allow incoming connections to Python and FFmpeg if macOS prompts. The video receiver uses TCP port `1935` by default.

Inbound's connection settings show the Mac address. Its default is detected when the MiniApp builds. Update it if the Mac changes networks. Voice recognition uses the Mentra app's on-device English speech model. Manual Start, Snap, and Stop controls are also available.

## Test voice on Mentra Live

1. Start the Mac server and the MiniApp development server as shown above. Scan the QR from the current terminal and open Inbound inside Mentra. On the iPhone, allow Mentra access to the microphone and local network. Connect the glasses to the same reachable Wi-Fi network as the phone and Mac.
2. In Mentra's **Speech** settings, select **English** for speech recognition. Open Inbound and wait for **Voice commands ready**. In **Connection settings**, check that the address is your Mac's Wi-Fi IP on port `8000` and tap **Connect to Mac**. A successful connection shows **Mac connected**. Open `http://127.0.0.1:8000/` on the Mac.
3. Do a short recording with the phone buttons first. Tap **Start recording**, wait for **Recording**, tap **Snap**, then tap **Stop**. Confirm that the recording light turns off and that a new **Glasses recording** appears in the Mac dashboard with a playable video and one marked moment.
4. Start a fresh capture by saying **“start”** or **“start recording”** as a standalone phrase. Pause until Inbound shows **Voice command accepted: start** and switches to **Recording**. Aim at a recognizable object and say **“snap”**. Once the first mark appears, aim somewhere else and say **“snap”** again. Verify that **Marked moments** shows two entries. Say **“stop to check the equipment”** and confirm that recording continues.
5. Say **“stop”** or **“stop recording”** on its own. Confirm the recording light turns off and the latest Mac session receives a video. Open both marked moments to check their stills and clips, and play the recording to check its audio. **API key needed** is the expected dashboard status if the Mac has no OpenAI key. The video and snaps should already be available, and you can start another capture from the phone.
6. If a command fails, try the matching phone button. Then open **Capture diagnostics → Copy logs** in Inbound and save the output before closing the MiniApp. Include whether the recording light turned on or off and the exact text shown under **Listening** or **Heard**. The log stores the matched command, whether Mentra supplied a silence event or Inbound settled the transcript after a pause, the camera response, and the Mac request status. It omits raw transcripts and full server URLs.
7. If the log shows a Mac connection error, open **Connection settings**, choose **Use this build’s Mac address** if available, and tap **Connect to Mac**. If the recording light turns off but the dashboard still shows **Awaiting recording**, check glasses Wi-Fi and tap **Retry / check upload**. Look for `Inbound upload received` and `Inbound upload saved` in the Mac server terminal. If the video is in Mentra’s gallery, export it and use **Attach recording** on the same Mac session.
8. To test Stop during startup, say **“start”**, then say **“stop”** while Inbound is still starting. If Start confirms, Inbound sends the queued Stop immediately. If the screen changes to **Start unconfirmed** and the recording light is still on, press the glasses' action button once. After the light turns off, tap **I stopped it on the glasses**. Sync and export the saved clip from Mentra's **Camera** and use **Attach recording** on that session in the Mac dashboard. If the light never turned on, choose **Camera is idle · try again**.
9. If a previous session is stuck on **Waiting upload**, confirm that the recording light is off, then tap **Camera is idle · Start a new capture**. The old session remains in the Mac dashboard. For a direct capture, `live.mac_recording` confirms that the first video reached the Mac. `live.mac_finalized` confirms that Stop finished saving the video. If the camera light stays on after the Mac saves, use **Stop glasses** to retry the device stop separately.
10. If Mentra asks for a glasses update to stream, choose **Recording mode → Record on glasses** before trying Start. Inbound also selects that mode when Mentra returns the update error to it. In this mode, the recording stays on the glasses first, and Snap marks become stills after the clip reaches the Mac. If Mentra again fails to confirm Start, the action-button and dashboard attachment steps above apply. After updating the glasses, switch back to **Live to Mac** to test direct recording.

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
