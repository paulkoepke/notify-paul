import type { Notification } from '../core/types.js';
import type { NotificationChannel, SendOutcome } from './channel.js';

/**
 * Development channel: prints the notification to stdout. It writes directly instead of using the
 * logger so notification content stays out of the log files.
 */
export class ConsoleChannel implements NotificationChannel {
  readonly name = 'console' as const;

  constructor(private readonly write: (text: string) => void = (t) => process.stdout.write(t)) {}

  send(notification: Notification): Promise<SendOutcome> {
    this.write(formatConsole(notification));
    return Promise.resolve({ ok: true });
  }
}

export function formatConsole({ title, message, priority, source }: Notification): string {
  const from = source !== undefined ? ` ${source}:` : '';
  return `\n[NotifyPaul] (${priority})${from} ${title}\n${message}\n\n`;
}
