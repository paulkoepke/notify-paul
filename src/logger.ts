import { pino, type DestinationStream, type Logger } from 'pino';
import type { LogLevel } from './config.js';

export type { Logger };

export const REDACTED = '[redacted]';

/** Keys that may hold secrets, redacted wherever they appear (up to three levels deep). */
const SECRET_KEYS = [
  'apiToken',
  'botToken',
  'password',
  'webhookUrl',
  'token',
  'authorization',
  'auth',
  'HTTP_API_TOKEN',
  'TELEGRAM_BOT_TOKEN',
  'SMTP_PASSWORD',
  'DISCORD_WEBHOOK_URL',
  'NTFY_TOKEN',
];

/** Notification content stays out of logs; log ids, channels and status codes instead. */
const CONTENT_PATHS = [
  'title',
  'message',
  'notification.title',
  'notification.message',
  'input.title',
  'input.message',
];

const REDACT_PATHS = [
  ...SECRET_KEYS.flatMap((key) => [key, `*.${key}`, `*.*.${key}`, `*.*.*.${key}`]),
  ...CONTENT_PATHS,
];

export function createLogger(level: LogLevel, destination?: DestinationStream): Logger {
  const options = {
    level,
    redact: { paths: REDACT_PATHS, censor: REDACTED },
  };
  return destination ? pino(options, destination) : pino(options);
}
