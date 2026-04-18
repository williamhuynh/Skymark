# Skymark

Windows Electron meeting sidecar for the Sky assistant. Streams live transcripts (Deepgram Nova-3) to Mission Control; pairs with specialist agents (naa-project, aid-coo) that whisper context during meetings.

## Stack

- Electron + TypeScript + React, built with **electron-vite**
- State: `electron-store` for settings, `safeStorage` for the Deepgram key
- Packaging: `electron-builder` → NSIS (Windows)

## Layout

```
src/
├── main/      ← Electron main process (tray, IPC handlers, future audio + Deepgram + MC client)
├── preload/   ← contextBridge API exposed as window.skymark
└── renderer/  ← React UI (settings now, sidebar later)
```

- `electron.vite.config.ts` — main + preload + renderer build config
- `electron-builder.yml` — Windows NSIS target
- `tsconfig.node.json` (main/preload) + `tsconfig.web.json` (renderer)

## Dev + build

```bash
npm install
npm run dev         # electron-vite dev with hot reload
npm run build       # out/ — unpacked main+preload+renderer
npm run build:win   # release/<version>/Skymark-<version>-Setup.exe  (needs wine on Linux, native on Windows)
npm run typecheck
```

## Architecture intent

- **Main owns IPC boundaries.** Anything that touches the filesystem, credentials, audio hardware, or network lives in main. Renderer only asks via `window.skymark.*`.
- **Preload exports a typed API** (`SkymarkApi`) that the renderer imports types from. Don't add `nodeIntegration` to the renderer — sandbox + contextIsolation stay on.
- **Deepgram key never hits the renderer.** Renderer sends the plaintext to main once via IPC; main encrypts with `safeStorage` and stores the ciphertext in `electron-store`. Future streaming logic reads and decrypts in main, sends audio frames to Deepgram directly, emits transcript events over IPC.
- **MC is reached via Tailscale.** The `mcUrl` setting defaults to `http://localhost:3002` for dev; production will be the host's tailnet IP.

## Pairs with

- `~/apps/mission-control` — `/ws/meetings/:id/stream` (send transcript frames), `/ws/meetings/:id/subscribe` (receive nudges + Q&A answers), `/api/meetings/:id/ask`, `/api/meetings/:id/end`
- `~/nanoclaw` groups: `naa-project`, `aid-coo` (specialist agents woken via MC's delegate → nanoclaw `/api/delegate`)
- Pattern contract: `~/nanoclaw/groups/global/wiki/patterns/in-meeting-pattern.md` — the prompt/response shape the specialists honour

## Current milestone

**v0.0.1 scaffold only.** No audio, no Deepgram, no MC integration. Next: `naudiodon` WASAPI capture + Deepgram streaming client, wired through main-process IPC to the renderer sidebar.
