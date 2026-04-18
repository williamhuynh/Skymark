import { app, Notification } from 'electron';
import { autoUpdater } from 'electron-updater';
import { EventEmitter } from 'node:events';
import log from 'electron-log/main';
import type { UpdateState } from '../shared/types';

const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 hours

class UpdateController extends EventEmitter {
  private state: UpdateState = { phase: 'idle' };

  getState(): UpdateState {
    return this.state;
  }

  private setState(next: UpdateState): void {
    this.state = next;
    this.emit('state', next);
  }

  init(): void {
    if (!app.isPackaged) {
      log.info('[auto-update] dev mode — updater disabled');
      this.setState({ phase: 'idle' });
      return;
    }

    autoUpdater.logger = log;
    (autoUpdater.logger as typeof log).transports.file.level = 'info';
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;

    autoUpdater.on('checking-for-update', () => {
      log.info('[auto-update] checking');
      this.setState({ phase: 'checking' });
    });

    autoUpdater.on('update-available', (info) => {
      log.info('[auto-update] update available', info.version);
      this.setState({ phase: 'downloading', version: info.version, progress: 0 });
    });

    autoUpdater.on('update-not-available', () => {
      log.info('[auto-update] up to date');
      this.setState({ phase: 'up-to-date' });
    });

    autoUpdater.on('error', (err) => {
      log.warn('[auto-update] error:', err);
      this.setState({
        phase: 'error',
        message: err instanceof Error ? err.message : String(err),
      });
    });

    autoUpdater.on('download-progress', (p) => {
      const pct = Math.round(p.percent);
      log.info(`[auto-update] downloading ${pct}% at ${Math.round(p.bytesPerSecond / 1024)}kB/s`);
      if (this.state.phase === 'downloading') {
        this.setState({
          phase: 'downloading',
          version: this.state.version,
          progress: pct,
        });
      }
    });

    autoUpdater.on('update-downloaded', (info) => {
      log.info('[auto-update] downloaded', info.version);
      this.setState({ phase: 'ready', version: info.version });
      const notification = new Notification({
        title: `Skymark ${info.version} is ready`,
        body: 'Click to restart and apply the update.',
        silent: false,
      });
      notification.on('click', () => this.install());
      notification.show();
    });

    setTimeout(() => void this.check('startup'), 10_000);
    setInterval(() => void this.check('interval'), CHECK_INTERVAL_MS);
  }

  async check(reason: 'startup' | 'interval' | 'manual'): Promise<void> {
    if (!app.isPackaged) {
      this.setState({ phase: 'error', message: 'Updates disabled in dev mode' });
      return;
    }
    if (this.state.phase === 'checking' || this.state.phase === 'downloading') {
      log.info(`[auto-update] check (${reason}) skipped — already ${this.state.phase}`);
      return;
    }
    try {
      log.info(`[auto-update] check (${reason}) starting`);
      await autoUpdater.checkForUpdates();
    } catch (err) {
      log.warn('[auto-update] check failed:', err);
      this.setState({
        phase: 'error',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  install(): void {
    if (this.state.phase !== 'ready') return;
    autoUpdater.quitAndInstall(false, true);
  }
}

export const updateController = new UpdateController();
