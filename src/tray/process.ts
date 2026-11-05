import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { Logger } from '../logger.js';
import type { TrayView } from './controller.js';

export function startTrayProcess(
  executable: string,
  logger: Logger,
  onEvent: (id: string) => void,
): TrayView {
  const child = spawn(executable, ['--tray'], {
    shell: false,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  let stopped = false;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  child.once('error', () =>
    logger.warn('Tray helper could not be started. Run npm run build:native.'),
  );
  child.stdin.on('error', () => {
    /* The close event reports helper termination. */
  });
  const lines = createInterface({ input: child.stdout });
  lines.on('line', (line) => {
    if (line.length > 256) return;
    try {
      const event = JSON.parse(line) as { id?: unknown };
      if (typeof event.id === 'string') onEvent(event.id);
    } catch {
      logger.warn('Invalid tray event ignored.');
    }
  });
  child.once('close', () => {
    clearTimeout(killTimer);
    lines.close();
    if (!stopped) logger.warn('Tray helper stopped; notification service remains available.');
  });
  return {
    update(menu) {
      if (!child.stdin.destroyed) child.stdin.write(`${JSON.stringify(menu)}\n`);
    },
    close() {
      stopped = true;
      lines.close();
      child.stdin.end();
      // EOF lets the helper dispose the icon cleanly. Kill only an unresponsive helper.
      killTimer = setTimeout(() => child.kill(), 2000);
      killTimer.unref();
    },
  };
}
