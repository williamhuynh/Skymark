import log from 'electron-log/main';
import { app } from 'electron';
import path from 'node:path';

let initialised = false;

export function initLogging(): void {
  if (initialised) return;
  initialised = true;

  // Write to %APPDATA%/Skymark/logs/main.log on Windows,
  // ~/Library/Logs/Skymark/main.log on macOS,
  // ~/.config/Skymark/logs/main.log on Linux.
  log.transports.file.resolvePathFn = () =>
    path.join(app.getPath('userData'), 'logs', 'main.log');
  log.transports.file.level = 'info';
  log.transports.console.level = 'debug';
  log.transports.file.maxSize = 5 * 1024 * 1024;
  log.transports.file.format =
    '[{y}-{m}-{d} {h}:{i}:{s}.{ms}] [{level}] {text}';

  // Catch unhandled exceptions and rejections → file + console.
  log.errorHandler.startCatching({
    showDialog: false,
    onError: ({ error }) => {
      log.error('uncaught:', error);
    },
  });

  log.info('Skymark starting', {
    version: app.getVersion(),
    platform: process.platform,
    electron: process.versions.electron,
    node: process.versions.node,
  });
}

export { log };
export default log;
