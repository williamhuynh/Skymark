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

```bash
npm install
npm run dev
```

`electron-vite dev` runs main + preload + renderer with hot reload.

## Build (Windows installer)

```bash
npm run build:win
```

Output: `release/<version>/Skymark-<version>-Setup.exe`. Unsigned — run it past Windows SmartScreen warnings (personal install).

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
- [ ] **Audio capture** — WASAPI loopback + mic via `naudiodon`, mixed 16 kHz mono PCM
- [ ] **Deepgram streaming** — Nova-3 WebSocket, diarise, punctuate, per-specialist keyterms
- [ ] **Live transcript UI** — sidebar window, speaker-coloured bubbles, auto-scroll
- [ ] **MC integration** — create meeting on detect, stream transcript, subscribe to nudges/answers
- [ ] **Meeting auto-detect** — poll for `ms-teams.exe` + Chrome/Edge tabs on `meet.google.com`
- [ ] **Ask-a-question** — Ctrl+K composer → `/api/meetings/:id/ask`
- [ ] **Installer** — `electron-builder --win` NSIS, autostart on login
- [ ] **Global hotkey** — toggle sidebar
- [ ] **aid-coo integration** — once naa-project proves out (copy/paste per the pattern doc)

Explicitly not v1: code signing, auto-update.
