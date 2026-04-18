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

## Build (Windows installer)

**Build on Windows**, not Linux. electron-builder needs wine to produce an NSIS installer on non-Windows hosts; it's simpler to just build on the target platform.

On your Windows machine:

```powershell
git clone git@github.com:williamhuynh/Skymark.git
cd Skymark
npm install
npm run build:win
```

Output: `release\<version>\Skymark-<version>-Setup.exe`.

The installer is unsigned — Windows SmartScreen will flag it on first run. Click *More info → Run anyway*. This is a personal / internal app so code signing is explicitly out of scope.

## Install & first run

1. Run `Skymark-<version>-Setup.exe`. Installs per-user (no admin required), creates Start Menu + desktop shortcuts.
2. Launch Skymark. Main window opens; the app also lives in the system tray.
3. *Settings* → paste your Deepgram API key → Save. (Stored encrypted via Windows Credential Manager, never on disk in plaintext.)
4. *Settings* → confirm the Mission Control URL. Default `http://localhost:3002` works if MC runs on the same machine; use the host's Tailscale IP for cross-machine access.
5. *Settings* → flip "Start on login" if you want Skymark to auto-launch (minimised to tray).
6. *Meeting* tab → pick a specialist → *Start*. Grant audio + screen permissions when Chromium asks.

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
