# Local development

## Run on this Mac

Install Python and Bun, create a virtual environment, and install the dependencies. VS Code also has tasks under **Terminal → Run Task** for the Mac server, Mentra MiniApp, and backend tests.

```sh
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements-dev.txt
cd app && bun install
```

```sh
# Terminal 1, from the repository root. --tunnel lets the glasses upload video over the
# internet (needs `brew install cloudflared`); leave it off to upload over local Wi-Fi only.
.venv/bin/python scripts/dev.py --lan --tunnel

# Terminal 2, from the repository root
cd app
bun run dev
```

Dashboard: http://127.0.0.1:8000/. The MiniApp CLI prints its current QR code and a PNG path.

## Phone

Open the regular Mentra app and connect Mentra Live. Under **Settings → Miniapp Developer Settings**, choose **Scan Miniapp QR Code**. Menu wording can vary by app version. The phone must reach the Mac on TCP port `8000`; the glasses only need Bluetooth to the phone. Venue Wi-Fi often isolates clients, so use a phone hotspot or a small travel router, then rebuild the MiniApp so it picks up the Mac's new address and QR code.

## How a capture reaches the Mac

Everything goes through the phone, which retries until the Mac confirms. The glasses never upload to the Mac directly. The earlier design had the glasses POST their video to the Mac over Wi-Fi on Stop, and no glasses video ever arrived on the demo network.

- **Start** creates the session on the phone and starts recording right away. Mic audio is sent to the Mac in parts of about four seconds. The phone's on-device transcript lines are sent as they finish.
- **Snap** takes a photo immediately. Mentra delivers it over Wi-Fi when possible and falls back to Bluetooth. The phone then uploads it to the Mac.
- **Stop** sends the remaining audio, waits for the last photo, then tells the Mac the capture is finished. The Mac joins the audio, transcribes it with OpenAI, and writes the report and handoff card.

Every upload is idempotent, so a retry never duplicates audio, photos, or transcript lines. If the Mac is unreachable, recording continues and uploads wait in order; the MiniApp shows how many are queued. The dashboard switches to an incoming capture as soon as its first upload arrives, and shows photos and transcript lines live.

**Video (optional, on by default).** The MiniApp also records video on the glasses, keeping a copy in their gallery. On Stop, the glasses upload it directly to the server over their own Wi-Fi. With `scripts/dev.py --tunnel`, that upload goes over the internet through a Cloudflare quick tunnel, so the glasses' Wi-Fi only needs internet. The tunnel is an outgoing connection, so no port opens on the Mac. It passes only video uploads that carry the phone's random per-capture key, which the server stores only as a hash, and answers everything else with 404. It closes when the server stops. Cloudflare limits each upload to about 100 MB. When the glasses share the server's subnet, they upload over local Wi-Fi with no size limit instead. Video records at 720p and 30 fps.

The glasses' Wi-Fi must work for them. Networks with a sign-in page, such as Stanford Visitor, give glasses neither internet nor a route to other devices, and the upload fails. Put the glasses on a phone hotspot; the Mac and phone can stay on the venue Wi-Fi. Before a demo, use **Test video upload** in Inbound's connection settings. It records a 3-second clip, sends it the same way as a capture's video, confirms it reached the server, and reports megabytes per minute. MiniApps can't read the glasses' gallery directly. Only the Mentra app can, by joining the glasses' own hotspot. So a failed upload is recovered by exporting the clip from the Mentra gallery and attaching it on the dashboard. Venue Wi-Fi can put the glasses on a different segment than the laptop even with the same name, and then the upload times out; Inbound's connection settings show the glasses' address to compare. A phone hotspot shared by the glasses, phone, and laptop avoids this. If the upload fails, export the clip from the Mentra gallery and use **Attach glasses video** in the dashboard's Full video tab; the stills and report are updated from it. After a failed upload, Mentra may refuse new recordings until the Mentra app is reopened. The dashboard shows it under **Full video**, with each photo as a jump point. The report never depends on the video. Mentra Live can't take photos while it records video, so with video on, each snap is marked instantly and its still comes from the video at that moment. The report waits up to two minutes for the video; if the upload fails, those stills are lost. With video off, snaps are real photos delivered during the capture. The camera stays warm, and each snap fires immediately without waiting for the previous photo to transfer. Turn video off with **Also record video on the glasses** in Inbound.

## Host it online

For real use, the ambulance and the ER are never on the same Wi-Fi. Run the server on the internet instead: the paramedic's phone reaches it over cellular, and the ER opens the dashboard in any browser.

```
Glasses ──Bluetooth── phone ──HTTPS over cellular── Inbound server (VM) ── ER dashboard (browser)
```

On the internet the server requires credentials. The MiniApp sends a device token, which can only create captures, upload to them, and check their status. People open the dashboard with a shared password; the browser asks once and accepts any username. With neither secret set, the server stays open, which is how the laptop demo works.

### One-time VM setup (Oracle Cloud)

1. From this Mac, run `scripts/deploy.sh ubuntu@<vm-public-ip> [path/to/ssh-key]`. The script copies this checkout to `~/inbound` on the VM and sets up its own Python there with `uv`, leaving the system Python alone. It creates `deploy/.env` with fresh secrets and starts the `inbound` systemd service on `127.0.0.1:8000`.
2. By default the server goes public through a Cloudflare quick tunnel (`inbound-tunnel`). This needs no open ports and no Cloudflare account. The script prints the `https://….trycloudflare.com` address. That address changes whenever the tunnel restarts, for example after a VM reboot. You then need to run `scripts/deploy.sh` again and reinstall the MiniApp, or enter the new address in its connection settings.
3. For a fixed address, open TCP ports 80 and 443 in the Oracle console under **VCN → Security List**. Then set `INBOUND_PUBLIC=caddy` in the VM's `~/inbound/deploy/.env` and run `scripts/deploy.sh` again. Caddy serves HTTPS for `INBOUND_DOMAIN`, which defaults to `<ip-with-dashes>.sslip.io`.
4. The OpenAI key goes in the VM's `~/inbound/deploy/.env`. After changing it, run `sudo systemctl restart inbound`. Logs: `journalctl -u inbound -f`.
5. Run `scripts/release_miniapp.sh`. It builds the MiniApp with the server's address and device token, then shows an install QR. Scan it from each phone on the same network as this Mac. Once installed, the MiniApp needs no laptop.

To ship code changes, run `scripts/deploy.sh` again. It keeps the captures in `deploy/data`, the secrets in `deploy/.env`, and a running tunnel's address. `deploy/.env` on this Mac holds the address, device token, and dashboard password, not the OpenAI key. Keep it private.

This is still a prototype. Before real patient data, it needs per-user accounts, audit logs, encryption at rest, data-processing agreements with the hosting and AI providers, and agency IT approval.

## Voice commands

Say **start**, **snap** (also "snapshot" or "screenshot"), or **stop** anywhere in a sentence. For example, "BP 190 over 90, snap the left forearm" takes a photo, and "okay that's everything, stop" ends the capture. Inbound acts on partial transcripts, so it doesn't wait for a pause. A command word that ends a partial transcript waits 350 ms in case it becomes "started" or "stopped". A negated command such as "don't stop" is ignored. Each occurrence fires once, so two snaps in one sentence take two photos. The words stay in the transcript, and the report leaves them out.

## Vitals read-back

During a capture, Inbound listens for blood pressure, heart rate, SpO₂, and respiratory rate, in digits or words ("BP one ninety over sixty", "sats ninety eight percent"). The glasses ask aloud, "Can you repeat the blood pressure?", in two cases:
- The medic gives a vital two different values within 45 seconds ("BP 190 over 60… no, 90 over 60", or "sats 92, no, 98").
- A number said right after a vital's name makes no sense. For example, the recognizer heard "one ninety" as "one nine" ("b p one nine over sixty"). That counts as unclear, and Inbound doesn't guess.

The next clear value said for that vital is logged as confirmed, and the glasses read it back ("Blood pressure 90 over 60, logged."). An answer that is unclear again, or holds two values, gets "Sorry, can you repeat the blood pressure?" With no answer, they ask once more after 20 seconds, then leave the vital unconfirmed. Stopping the capture also leaves an open question unconfirmed. Digit-by-digit numbers ("one nine zero over six zero") are understood. Use **Test glasses speaker** in Inbound's connection settings to check that speech plays on the glasses.

While the glasses speak, and for 2 seconds after, Inbound ignores what the microphone hears, so it doesn't log its own read-back. Confirmed vitals set the handoff card's values and show "✓ confirmed". Unconfirmed vitals show both values and are flagged in the report's uncertainties. The dashboard shows vitals live during a capture, with both values on screen until the medic repeats one. Speech goes to the phone's audio output, which is the glasses' speaker when they are connected.

## Test on Mentra Live

1. Start the Mac server and the MiniApp development server as shown above. Scan the QR from the current terminal and open Inbound inside Mentra. Allow microphone and local-network access. In Mentra's **Speech** settings, select **English**.
2. Wait for **Voice commands ready**. Under **Connection settings**, check the Mac address and tap **Connect to Mac**. Open `http://127.0.0.1:8000/` on the Mac.
3. Say "okay **start** the handoff". The MiniApp should switch to **Recording** before you finish the sentence, and the dashboard should open the new capture within a few seconds.
4. Say "BP 190 over 90, **snap** the left forearm". A photo appears under **Marked moments** on the dashboard. Say a sentence with two snaps and confirm that two photos arrive. Say "don't stop" and confirm that recording continues.
5. Say "that's everything, **stop**". The phone shows the report status. With an OpenAI key in `.env`, the dashboard shows the handoff card and summary. Without one, it shows **API key needed**, with the audio, photos, and phone transcript already saved.
6. To test recovery, turn off the Mac's Wi-Fi mid-capture. The MiniApp keeps recording and shows queued uploads. When Wi-Fi returns, everything arrives in order.
7. If something fails, open **Capture diagnostics → Copy logs** in Inbound. The log records each command, photo, upload retry, and rejection. It omits transcript text and server addresses.

## AI setup

Copy `.env.example` to `.env`, enter `OPENAI_API_KEY` locally, then start or restart the Mac server.

## Checked so far

- Backend tests cover phone capture end to end: idempotent create, audio parts with gap padding, raw and linked photos, transcript lines, finish, report evidence, and rejected uploads. The same flow was run against a live server with real HTTP requests.
- MiniApp tests cover in-sentence commands, partial-result timing, repeated partials, two snaps per sentence, negation, photo upload from both host delivery modes, queued retries while the Mac is offline, dropped refused uploads, report-status follow-up, and recovery after a restart. The MiniApp passes its TypeScript check and production build.

## Not yet checked on the glasses

- Real audio-chunk format and sample rate from Mentra Live. The Mac accepts 16-bit PCM and rejects other formats; the phone's transcript is used if audio is refused.
- Photo latency over Bluetooth, and whether the host returns the photo locally or as a link.
- Report quality with the real OpenAI models.

Use fictional training data. The report is a summary of captured evidence, not a diagnosis or treatment recommendation. The prototype's local server has no production patient-data protections.

The active phone project is `app/`, which runs inside Mentra. Keep keys, install bundles, connection QR codes, logs, and recordings local.
