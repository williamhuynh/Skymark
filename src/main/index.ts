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
} from 'electron';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import Store from 'electron-store';
import type { Settings, SessionState, StartSessionArgs, TranscriptEvent } from '../shared/types';
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
let window: BrowserWindow | null = null;
let isQuitting = false;

function createWindow() {
  window = new BrowserWindow({
    width: 720,
    height: 720,
    show: false,
    title: 'Skymark',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.mjs'),
      sandbox: true,
      contextIsolation: true,
    },
  });

  window.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      window?.hide();
    }
  });

  if (isDev && process.env['ELECTRON_RENDERER_URL']) {
    void window.loadURL(process.env['ELECTRON_RENDERER_URL']);
  } else {
    void window.loadFile(path.join(__dirname, '../renderer/index.html'));
  }

  meeting.on('state', (state: SessionState) => {
    window?.webContents.send('session:state', state);
  });
  meeting.on('transcript', (ev: TranscriptEvent) => {
    window?.webContents.send('session:transcript', ev);
  });
}

function toggleWindow() {
  if (!window) return;
  if (window.isVisible()) {
    window.hide();
  } else {
    window.show();
    window.focus();
  }
}

function createTray() {
  const icon = nativeImage.createEmpty();
  tray = new Tray(icon);
  tray.setToolTip('Skymark');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open Skymark', click: toggleWindow },
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
  tray.on('click', toggleWindow);
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

  ipcMain.on('session:audio', (_e, chunk: ArrayBuffer) => {
    meeting.sendAudio(chunk);
  });
}

function registerDisplayMediaHandler() {
  session.defaultSession.setDisplayMediaRequestHandler((_request, callback) => {
    // Audio-only system capture: return the primary screen, ask Chromium to mix audio.
    void desktopCapturer.getSources({ types: ['screen'] }).then((sources) => {
      callback({ video: sources[0], audio: 'loopback' });
    });
  });
}

app.whenReady().then(() => {
  registerDisplayMediaHandler();
  createWindow();
  createTray();
  registerIpc();
});

app.on('before-quit', async () => {
  isQuitting = true;
  await meeting.stop();
});

app.on('window-all-closed', () => {
  // Keep running in the tray. macOS would traditionally quit, but we hide anyway.
});
