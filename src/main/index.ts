import { app, BrowserWindow, Tray, Menu, nativeImage, safeStorage, ipcMain } from 'electron';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import Store from 'electron-store';
import type { Settings } from '../shared/types';

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

let tray: Tray | null = null;
let window: BrowserWindow | null = null;
let isQuitting = false;

function createWindow() {
  window = new BrowserWindow({
    width: 420,
    height: 640,
    show: false,
    resizable: false,
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

function publicSettings(): Omit<Settings, 'deepgramKeyEncrypted'> {
  const { deepgramKeyEncrypted: _ignored, ...rest } = store.store;
  return rest;
}

function registerIpc() {
  ipcMain.handle('settings:get', () => publicSettings());
  ipcMain.handle('settings:set', (_e, patch: Partial<Omit<Settings, 'deepgramKeyEncrypted'>>) => {
    const current = store.store;
    store.store = { ...current, ...patch };
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
}

app.whenReady().then(() => {
  createWindow();
  createTray();
  registerIpc();
});

app.on('before-quit', () => {
  isQuitting = true;
});

app.on('window-all-closed', () => {
  // Keep running in the tray on Windows/Linux; only macOS traditionally quits.
});
