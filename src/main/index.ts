import {
  app,
  BrowserWindow,
  Tray,
  Menu,
  nativeImage,
  Notification,
  safeStorage,
  shell,
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
import { updateController } from './auto-update';
import type { UpdateState } from '../shared/types';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isDev = !!process.env['ELECTRON_RENDERER_URL'];

function resourcePath(name: string): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, name);
  }
  return path.join(__dirname, '../../build', name);
}

const ICON_PATH = resourcePath('icon.png');

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

function registerDebugShortcuts(win: BrowserWindow): void {
  // We set Menu.setApplicationMenu(null) to hide the default Windows menu,
  // which also strips the default devtools / reload accelerators.
  // Re-wire them here so power users + debugging still work.
  win.webContents.on('before-input-event', (_event, input) => {
    if (input.type !== 'keyDown') return;
    const key = input.key.toLowerCase();
    if (key === 'f12' || (input.control && input.shift && key === 'i')) {
      if (win.webContents.isDevToolsOpened()) {
        win.webContents.closeDevTools();
      } else {
        win.webContents.openDevTools({ mode: 'detach' });
      }
    } else if (input.control && key === 'r' && !input.shift) {
      win.webContents.reload();
    }
  });
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 800,
    height: 720,
    show: false,
    title: 'Skymark',
    icon: ICON_PATH,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
    },
  });

  registerDebugShortcuts(mainWindow);

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      void shell.openExternal(url);
    }
    return { action: 'deny' };
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
    icon: ICON_PATH,
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

  registerDebugShortcuts(sidebarWindow);

  sidebarWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      void shell.openExternal(url);
    }
    return { action: 'deny' };
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
  let icon = nativeImage.createFromPath(ICON_PATH);
  if (icon.isEmpty()) {
    log.warn('[tray] icon.png not found at', ICON_PATH, '— falling back to empty image');
    icon = nativeImage.createEmpty();
  } else {
    // Windows prefers 16x16 / 32x32 tray icons; resize from the 256x256 master.
    icon = icon.resize({ width: 16, height: 16 });
  }
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

  ipcMain.handle('shell:open-external', (_e, url: string) => {
    if (typeof url !== 'string') return;
    if (!url.startsWith('http://') && !url.startsWith('https://')) return;
    void shell.openExternal(url);
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

  ipcMain.handle('updater:get-version', () => app.getVersion());
  ipcMain.handle('updater:get-state', () => updateController.getState());
  ipcMain.handle('updater:check', () => updateController.check('manual'));
  ipcMain.handle('updater:install', () => updateController.install());

  ipcMain.handle(
    'mc:patch-metadata',
    async (_e, meetingId: string, patch: Record<string, unknown>) => {
      const url = store.get('mcUrl') as string | undefined;
      if (!url) return { ok: false, error: 'MC URL not configured' };
      if (!meetingId) return { ok: false, error: 'meetingId required' };
      try {
        const res = await fetch(`${url.replace(/\/$/, '')}/api/meetings/${meetingId}/metadata`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(patch),
          signal: AbortSignal.timeout(5000),
        });
        if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  );

  ipcMain.handle('mc:get-archive', async (_e, meetingId: string) => {
    const url = store.get('mcUrl') as string | undefined;
    if (!url) return { ok: false, error: 'MC URL not configured' };
    if (!meetingId || typeof meetingId !== 'string') {
      return { ok: false, error: 'meetingId required' };
    }
    try {
      const res = await fetch(`${url.replace(/\/$/, '')}/api/meetings/${meetingId}/archive`, {
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
      const markdown = await res.text();
      return { ok: true, markdown };
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

function registerMediaPermissions() {
  // Electron blocks all permissions by default. Without this, getUserMedia({audio})
  // silently fails — no mic, no transcript. Auto-grant media-type permissions;
  // everything else (notifications, geolocation, etc.) stays denied.
  const allowedPermissions = new Set([
    'media',
    'mediaKeySystem',
    'display-capture',
    'audioCapture',
    'videoCapture',
  ]);

  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(allowedPermissions.has(permission));
  });
  session.defaultSession.setPermissionCheckHandler((_wc, permission) =>
    allowedPermissions.has(permission),
  );
}

function wireSessionBroadcast() {
  meeting.on('state', (state: SessionState) => broadcast('session:state', state));
  meeting.on('transcript', (ev: TranscriptEvent) => broadcast('session:transcript', ev));
  meeting.on('nudge', (n: Nudge) => broadcast('session:nudge', n));
  meeting.on('answer', (a: QuestionAnswer) => broadcast('session:answer', a));
}

// Single-instance lock: second launches focus the existing window instead of
// spawning a new process.
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
  process.exit(0);
}

app.on('second-instance', () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
});

app.whenReady().then(() => {
  initLogging();
  Menu.setApplicationMenu(null);
  updateController.init();
  updateController.on('state', (state: UpdateState) => broadcast('updater:state', state));
  if (process.platform === 'win32') {
    app.setAppUserModelId('dev.sky.skymark');
  }
  registerDisplayMediaHandler();
  registerMediaPermissions();
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
