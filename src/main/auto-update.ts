import { app, Notification } from 'electron';
import { autoUpdater } from 'electron-updater';
import log from 'electron-log/main';

const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 hours

export function initAutoUpdate(): void {
  if (!app.isPackaged) {
    log.info('[auto-update] skipping in dev mode');
    return;
  }

  // Route electron-updater logs into our log pipeline.
  autoUpdater.logger = log;
  (autoUpdater.logger as typeof log).transports.file.level = 'info';

  // Download automatically; prompt the user to restart once ready.
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('checking-for-update', () => {
    log.info('[auto-update] checking for update');
  });

  autoUpdater.on('update-available', (info) => {
    log.info('[auto-update] update available', info.version);
  });

  autoUpdater.on('update-not-available', () => {
    log.info('[auto-update] no update available');
  });

  autoUpdater.on('error', (err) => {
    log.warn('[auto-update] error:', err);
  });

  autoUpdater.on('download-progress', (p) => {
    log.info(`[auto-update] downloading ${Math.round(p.percent)}% at ${Math.round(p.bytesPerSecond / 1024)}kB/s`);
  });

  autoUpdater.on('update-downloaded', (info) => {
    log.info('[auto-update] downloaded', info.version);
    const notification = new Notification({
      title: `Skymark ${info.version} is ready`,
      body: 'Restart to apply the update. Your settings will be preserved.',
      silent: false,
    });
    notification.on('click', () => {
      autoUpdater.quitAndInstall(false, true);
    });
    notification.show();
  });

  // First check shortly after launch (gives the app time to settle).
  setTimeout(() => {
    void autoUpdater.checkForUpdates().catch((err) => {
      log.warn('[auto-update] initial check failed:', err);
    });
  }, 10_000);

  // Then every 4 hours.
  setInterval(() => {
    void autoUpdater.checkForUpdates().catch((err) => {
      log.warn('[auto-update] periodic check failed:', err);
    });
  }, CHECK_INTERVAL_MS);
}
