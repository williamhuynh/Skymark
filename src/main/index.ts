import { app, BrowserWindow, Tray, Menu, nativeImage, safeStorage, ipcMain } from 'electron';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import Store from 'electron-store';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isDev = !!process.env['ELECTRON_RENDERER_URL'];

type Settings = {
  mcUrl: string;
  defaultSpecialist: 'naa-project' | 'aid-coo' | 'none';
  autoDetect: boolean;
};

const store = new Store<Settings>({
  defaults: {
    mcUrl: 'http://localhost:3002',
    defaultSpecialist: 'none',
    autoDetect: false,
  },
});

let tray: Tray | null = null;
let window: BrowserWindow | null = null;

function createWindow() {
  window = new BrowserWindow({
    width: 420,
    height: 640,
    show: false,
    resizable: false,
    titleBarStyle: 'default',
    title: 'Skymark',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
    },
  });

  window.on('close', (event) => {
    if (!app.isQuitting) {
      event.preventDefault();
      window?.hide();
    }
  });

  if (isDev && process.env['ELECTRON_RENDERER_URL']) {
    window.loadURL(process.env['ELECTRON_RENDERER_URL']);
  } else {
    window.loadFile(path.join(__dirname, '../renderer/index.html'));
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
          app.isQuitting = true;
          app.quit();
        },
      },
    ]),
  );
  tray.on('click', toggleWindow);
}

function registerIpc() {
  ipcMain.handle('settings:get', () => store.store);
  ipcMain.handle('settings:set', (_e, patch: Partial<Settings>) => {
    store.set({ ...store.store, ...patch });
    return store.store;
  });

  ipcMain.handle('deepgram-key:set', (_e, key: string) => {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('OS-level encryption unavailable — cannot store Deepgram key securely');
    }
    const encrypted = safeStorage.encryptString(key);
    store.set('deepgramKeyEncrypted' as keyof Settings, encrypted.toString('base64') as unknown as Settings[keyof Settings]);
    return true;
  });

  ipcMain.handle('deepgram-key:has', () => {
    return Boolean(store.get('deepgramKeyEncrypted' as keyof Settings));
  });

  ipcMain.handle('deepgram-key:clear', () => {
    store.delete('deepgramKeyEncrypted' as keyof Settings);
    return true;
  });
}

app.whenReady().then(() => {
  createWindow();
  createTray();
  registerIpc();
});

app.on('window-all-closed', (event: Electron.Event) => {
  event.preventDefault();
});

declare module 'electron' {
  interface App {
    isQuitting?: boolean;
  }
}
