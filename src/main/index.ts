import {
  app,
  BrowserWindow,
  Tray,
  Menu,
  nativeImage,
  Notification,
  safeStorage,
  ipcMain,
  session,
  desktopCapturer,
  screen,
} from 'electron';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import Store from 'electron-store';
import type {
  DetectedMeeting,
  Nudge,
  QuestionAnswer,
  Settings,
  SessionState,
  StartSessionArgs,
  TranscriptEvent,
} from '../shared/types';
import { MeetingSession } from './meeting/session';
import { MeetingDetector } from './detect/meeting-detector';
import { initLogging, log } from './log';
import { initAutoUpdate } from './auto-update';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isDev = !!process.env['ELECTRON_RENDERER_URL'];

type StoreSchema = Settings & { deepgramKeyEncrypted?: string };

const store = new Store<StoreSchema>({
  defaults: {
    mcUrl: 'http://localhost:3002',
    defaultSpecialist: 'none',
    autoDetect: false,
    autostart: false,
  },
});

const meeting = new MeetingSession(store);
const detector = new MeetingDetector();

let tray: Tray | null = null;
let mainWindow: BrowserWindow | null = null;
let sidebarWindow: BrowserWindow | null = null;
let isQuitting = false;

function applyAutostart(enabled: boolean): void {
  if (process.platform !== 'win32' && process.platform !== 'darwin') return;
  try {
    app.setLoginItemSettings({
      openAtLogin: enabled,
      openAsHidden: true,
    });
  } catch (err) {
    log.warn('[autostart] setLoginItemSettings failed:', err);
  }
}

function applyAutoDetect(enabled: boolean): void {
  if (enabled) {
    detector.start();
  } else {
    detector.stop();
  }
}

async function handleDetectedMeeting(detected: DetectedMeeting): Promise<void> {
  const settings = publicSettings();
  const specialist = settings.defaultSpecialist;
  const platformName = detected.platform === 'teams' ? 'Teams' : 'Google Meet';

  const notification = new Notification({
    title: `${platformName} meeting detected`,
    body:
      specialist === 'none'
        ? 'Click to open Skymark and start listening.'
        : `Click to start Skymark with ${specialist}.`,
    silent: false,
  });

  notification.on('click', async () => {
    if (meeting.getState().phase !== 'idle') {
      toggleMainWindow();
      return;
    }
    if (specialist === 'none') {
      mainWindow?.show();
      mainWindow?.focus();
      return;
    }
    await meeting.start({ specialist, platform: detected.platform });
  });

  notification.show();
}

function rendererEntry(view: 'main' | 'sidebar'): { kind: 'url'; value: string } | { kind: 'file'; value: string; hash: string } {
  if (isDev && process.env['ELECTRON_RENDERER_URL']) {
    return { kind: 'url', value: `${process.env['ELECTRON_RENDERER_URL']}#${view}` };
  }
  return {
    kind: 'file',
    value: path.join(__dirname, '../renderer/index.html'),
    hash: view,
  };
}

function loadView(win: BrowserWindow, view: 'main' | 'sidebar'): void {
  const entry = rendererEntry(view);
  if (entry.kind === 'url') {
    void win.loadURL(entry.value);
  } else {
    void win.loadFile(entry.value, { hash: entry.hash });
  }
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 800,
    height: 720,
    show: false,
    title: 'Skymark',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
    },
  });

  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow?.hide();
    }
  });

  loadView(mainWindow, 'main');
}

function createSidebarWindow() {
  if (sidebarWindow && !sidebarWindow.isDestroyed()) {
    sidebarWindow.show();
    sidebarWindow.focus();
    return;
  }

  const display = screen.getPrimaryDisplay();
  const width = 380;
  const height = Math.min(780, display.workArea.height - 40);
  const x = display.workArea.x + display.workArea.width - width - 20;
  const y = display.workArea.y + 20;

  sidebarWindow = new BrowserWindow({
    width,
    height,
    x,
    y,
    title: 'Skymark',
    alwaysOnTop: true,
    skipTaskbar: false,
    resizable: true,
    minimizable: true,
    maximizable: false,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
    },
  });

  sidebarWindow.on('closed', () => {
    sidebarWindow = null;
  });

  loadView(sidebarWindow, 'sidebar');
}

function toggleMainWindow() {
  if (!mainWindow) return;
  if (mainWindow.isVisible()) {
    mainWindow.hide();
  } else {
    mainWindow.show();
    mainWindow.focus();
  }
}

function toggleSidebar() {
  if (sidebarWindow && !sidebarWindow.isDestroyed()) {
    if (sidebarWindow.isVisible()) {
      sidebarWindow.hide();
    } else {
      sidebarWindow.show();
      sidebarWindow.focus();
    }
    return;
  }
  createSidebarWindow();
}

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(channel, payload);
    }
  }
}

function createTray() {
  const icon = nativeImage.createEmpty();
  tray = new Tray(icon);
  tray.setToolTip('Skymark');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open Skymark', click: toggleMainWindow },
      { label: 'Toggle sidebar', click: toggleSidebar },
      { type: 'separator' },
      {
        label: 'Quit',
        click: () => {
          isQuitting = true;
          app.quit();
        },
      },
    ]),
  );
  tray.on('click', toggleMainWindow);
}

function publicSettings(): Settings {
  const { deepgramKeyEncrypted: _ignored, ...rest } = store.store;
  return rest;
}

function registerIpc() {
  ipcMain.handle('settings:get', () => publicSettings());
  ipcMain.handle('settings:set', (_e, patch: Partial<Settings>) => {
    store.store = { ...store.store, ...patch };
    if (Object.prototype.hasOwnProperty.call(patch, 'autostart')) {
      applyAutostart(Boolean(patch.autostart));
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'autoDetect')) {
      applyAutoDetect(Boolean(patch.autoDetect));
    }
    return publicSettings();
  });

  ipcMain.handle('deepgram-key:set', async (_e, key: string) => {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('OS-level encryption unavailable — cannot store Deepgram key securely');
    }
    // Validate against Deepgram before storing. 401 is a hard fail.
    // Other errors (network, 5xx) surface a warning but we still save —
    // the user might be offline and we don't want to block them.
    try {
      const res = await fetch('https://api.deepgram.com/v1/projects', {
        headers: { Authorization: `Token ${key}` },
        signal: AbortSignal.timeout(6000),
      });
      if (res.status === 401) {
        throw new Error('Deepgram rejected this key (401). Check it and try again.');
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('Deepgram rejected')) {
        throw err;
      }
      log.warn('[deepgram-key] validation skipped:', err);
    }
    const encrypted = safeStorage.encryptString(key);
    store.set('deepgramKeyEncrypted', encrypted.toString('base64'));
    return true;
  });

  ipcMain.handle('deepgram-key:has', () => Boolean(store.get('deepgramKeyEncrypted')));

  ipcMain.handle('deepgram-key:clear', () => {
    store.delete('deepgramKeyEncrypted');
    return true;
  });

  ipcMain.handle('session:start', async (_e, args: StartSessionArgs) => {
    return meeting.start(args);
  });

  ipcMain.handle('session:stop', async () => {
    await meeting.stop();
  });

  ipcMain.handle('session:get-state', () => meeting.getState());

  ipcMain.handle('session:ask', async (_e, question: string) => {
    return meeting.ask(question);
  });

  ipcMain.on('session:audio', (_e, chunk: ArrayBuffer) => {
    meeting.sendAudio(chunk);
  });

  ipcMain.handle('window:toggle-sidebar', () => {
    toggleSidebar();
  });

  ipcMain.handle('window:show-main', () => {
    if (!mainWindow) return;
    mainWindow.show();
    mainWindow.focus();
  });

  ipcMain.handle('mc:test-connection', async (_e, url: string) => {
    if (!url || typeof url !== 'string') {
      return { ok: false, error: 'No URL configured' };
    }
    const trimmed = url.replace(/\/$/, '');
    try {
      const res = await fetch(`${trimmed}/api/meetings?limit=1`, {
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) return { ok: true };
      return { ok: false, error: `HTTP ${res.status} ${res.statusText}` };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('mc:list-meetings', async (_e, limit: number = 30) => {
    const url = store.get('mcUrl') as string | undefined;
    if (!url) return { ok: false, error: 'MC URL not configured' };
    try {
      const res = await fetch(`${url.replace(/\/$/, '')}/api/meetings?limit=${limit}`, {
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rows = (await res.json()) as any[];
      const meetings = (Array.isArray(rows) ? rows : []).map((r) => ({
        id: String(r.id),
        title: r.title ?? null,
        platform: r.platform ?? null,
        specialist: r.specialist ?? null,
        startedAt: r.started_at ?? r.startedAt ?? null,
        endedAt: r.ended_at ?? r.endedAt ?? null,
        status: r.status ?? null,
        summary: r.summary ?? null,
      }));
      return { ok: true, meetings };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
}

function registerDisplayMediaHandler() {
  session.defaultSession.setDisplayMediaRequestHandler((_request, callback) => {
    void desktopCapturer.getSources({ types: ['screen'] }).then((sources) => {
      callback({ video: sources[0], audio: 'loopback' });
    });
  });
}

function wireSessionBroadcast() {
  meeting.on('state', (state: SessionState) => broadcast('session:state', state));
  meeting.on('transcript', (ev: TranscriptEvent) => broadcast('session:transcript', ev));
  meeting.on('nudge', (n: Nudge) => broadcast('session:nudge', n));
  meeting.on('answer', (a: QuestionAnswer) => broadcast('session:answer', a));
}

app.whenReady().then(() => {
  initLogging();
  initAutoUpdate();
  if (process.platform === 'win32') {
    app.setAppUserModelId('dev.sky.skymark');
  }
  registerDisplayMediaHandler();
  createMainWindow();
  createTray();
  registerIpc();
  wireSessionBroadcast();
  // Reconcile OS autostart + detector state with the stored preferences on each launch.
  applyAutostart(Boolean(store.get('autostart')));
  applyAutoDetect(Boolean(store.get('autoDetect')));

  detector.on('detected', (d: DetectedMeeting) => {
    void handleDetectedMeeting(d);
  });
  detector.on('ended', () => {
    // No UI hook yet — the detector's own state clears, next detection can trigger again.
  });
});

let shuttingDown = false;

app.on('before-quit', (event) => {
  if (shuttingDown) return;
  // Electron doesn't await async before-quit handlers, so we block the quit,
  // run cleanup, then app.exit() when it actually finishes.
  event.preventDefault();
  shuttingDown = true;
  isQuitting = true;
  detector.stop();
  meeting
    .stop()
    .catch((err) => log.warn('[shutdown] meeting.stop failed:', err))
    .finally(() => app.exit(0));
});

app.on('window-all-closed', () => {
  // Stay alive in the tray.
});
