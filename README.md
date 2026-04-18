# Skymark

Windows meeting sidecar for the Sky assistant. Captures system audio + mic during Teams / Google Meet calls, streams transcripts to Mission Control via Deepgram Nova-3, and lets Sky specialist agents whisper context during live meetings.

Pairs with:
- **Mission Control** (`~/apps/mission-control`) — meeting lifecycle, wake-trigger watcher, specialist delegate plumbing
- **NanoClaw specialists** (e.g. `naa-project`, `aid-coo`) — answer questions and produce post-meeting summaries

## Stack

- Electron + TypeScript + React (built with [electron-vite](https://electron-vite.org/))
- Deepgram Nova-3 streaming (diarisation + keyterms + interim results)
- WASAPI audio capture (system loopback + mic, mixed to 16 kHz mono PCM)
- Windows Credential Manager (via Electron `safeStorage`) for API key storage
- electron-builder / NSIS installer for distribution

## Current state

**v0.0.1 — scaffold.** Shell boots with tray icon, settings window, API key storage, MC URL + specialist + auto-detect toggles. No audio capture, no Deepgram streaming, no MC integration yet — those land in the next phases.

## Dev

Works on any OS for iteration on the JS/React side. Audio loopback capture only actually works on Windows, but the UI + MC integration run fine in dev on Linux / macOS against a localhost MC instance.

```bash
npm install
npm run dev
```

`electron-vite dev` runs main + preload + renderer with hot reload.

## Install (end user)

Grab the latest signed-for-you-only Windows installer from the [Releases page](https://github.com/williamhuynh/Skymark/releases):

1. Download `Skymark-<version>-Setup.exe`
2. Run it (Windows SmartScreen may flag unsigned — *More info → Run anyway*)
3. Installs per-user, no admin required

No Node / Git / toolchain needed. The installer bundles everything.

## First run

1. Launch Skymark. The Onboarding panel prompts for your Deepgram API key — paste it (validated against Deepgram before it's stored encrypted via Windows Credential Manager).
2. Settings → *Mission Control URL* → enter your host's Tailscale IP, e.g. `http://100.x.y.z:3002`, and hit *Test*.
3. Optionally enable *Start on login* and *Auto-detect meetings*.
4. Meeting tab → pick a specialist → *Start*. Grant screen-share + mic permissions when prompted.

## Build from source (maintainer)

Only needed if you want to iterate on the code. Otherwise grab the prebuilt installer from Releases.

```powershell
git clone git@github.com:williamhuynh/Skymark.git
cd Skymark
npm install
npm run dev         # hot reload, no installer
npm run build:win   # produces release\<version>\Skymark-<version>-Setup.exe
```

Releases are auto-built by `.github/workflows/release.yml` on every `v*` tag push — see [Release process](#release-process).

## Release process

1. Bump `version` in `package.json`
2. Commit + tag: `git tag v0.0.2 && git push origin v0.0.2`
3. GitHub Actions spins up `windows-latest`, runs typecheck + `npm run publish:win`
4. electron-builder uploads the installer as a draft release
5. Go to the [Releases page](https://github.com/williamhuynh/Skymark/releases), review, publish
6. End users download the new `.exe` and re-install (settings + encrypted key are preserved by `electron-store`)

## Architecture

```
[Skymark — Windows]
  ├── Main process (Electron)
  │   ├── Tray icon + hidden window
  │   ├── Settings store (electron-store)
  │   ├── Deepgram key (safeStorage / Windows Credential Manager)
  │   ├── WASAPI audio capture (future)
  │   ├── Deepgram streaming client (future)
  │   └── MC WebSocket client (future)
  ├── Preload — contextBridge API (settings, Deepgram key, future transcript stream)
  └── Renderer (React) — settings UI, sidebar UI (future)
        ↓ WebSocket
[Mission Control — Linux host, reachable via Tailscale]
  /ws/meetings/:id/stream   ← transcript frames
  /ws/meetings/:id/subscribe ← nudges + Q&A answers
  /api/meetings/:id/ask     ← user questions
  /api/meetings/:id/end     ← post-meeting hook
```

## Transcript event shape

Matches Mission Control's contract (`apps/mission-control/src/server/routes/meetings.ts`):

```ts
{
  type: 'transcript',
  speaker: string,       // diarisation label from Nova-3
  text: string,
  startMs: number,
  endMs: number,
  isFinal: boolean,
}
```

## Roadmap

- [x] **Scaffold** — Electron shell, tray, settings, API key storage
- [x] **Audio capture** — system loopback via Electron desktopCapturer + mic via getUserMedia, Web Audio mixer → 16 kHz mono PCM
- [x] **Deepgram streaming** — Nova-3 WebSocket in main, diarise, punctuate, interim results
- [x] **Live transcript UI** — speaker-coloured bubbles, auto-scroll with pause-on-scroll-up
- [x] **MC integration** — createMeeting on start, stream WS, subscribe WS for nudges + answers, end hook on stop
- [x] **Ask-a-question** — composer → `/api/meetings/:id/ask`, matches answers to pending questions
- [x] **Always-on-top sidebar** — compact second window for live use during calls
- [x] **Installer** — NSIS via electron-builder (build on Windows)
- [x] **Autostart on login** — settings toggle writes Windows login-item registry
- [ ] **Meeting auto-detect** — poll `ms-teams.exe` + Chrome tabs on `meet.google.com`, tray toast to start
- [ ] **aid-coo integration** — apply in-meeting pattern to aid-coo (copy-paste per pattern doc)

Explicitly not v1: code signing, auto-update, global hotkey.
