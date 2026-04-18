import {
  app,
  BrowserWindow,
  Tray,
  Menu,
  nativeImage,
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
  Nudge,
  QuestionAnswer,
  Settings,
  SessionState,
  StartSessionArgs,
  TranscriptEvent,
} from '../shared/types';
import { MeetingSession } from './meeting/session';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isDev = !!process.env['ELECTRON_RENDERER_URL'];

type StoreSchema = Settings & { deepgramKeyEncrypted?: string };

const store = new Store<StoreSchema>({
  defaults: {
    mcUrl: 'http://localhost:3002',
    defaultSpecialist: 'none',
    autoDetect: false,
  },
});

const meeting = new MeetingSession(store);

let tray: Tray | null = null;
let mainWindow: BrowserWindow | null = null;
let sidebarWindow: BrowserWindow | null = null;
let isQuitting = false;

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
      preload: path.join(__dirname, '../preload/index.mjs'),
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
      preload: path.join(__dirname, '../preload/index.mjs'),
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
    return publicSettings();
  });

  ipcMain.handle('deepgram-key:set', (_e, key: string) => {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('OS-level encryption unavailable — cannot store Deepgram key securely');
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
  registerDisplayMediaHandler();
  createMainWindow();
  createTray();
  registerIpc();
  wireSessionBroadcast();
});

app.on('before-quit', async () => {
  isQuitting = true;
  await meeting.stop();
});

app.on('window-all-closed', () => {
  // Stay alive in the tray.
});
