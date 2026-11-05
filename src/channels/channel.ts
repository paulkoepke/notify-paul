import type { ChannelErrorCode, ChannelName, Notification } from '../core/types.js';

export type SendOutcome =
  | { ok: true }
  | {
      ok: false;
      error: ChannelErrorCode;
      /** Provider-requested wait before a retry (e.g. Telegram/Discord 429). */
      retryAfterMs?: number;
    };

/**
 * One delivery channel. Adapters know their provider; routing and retries live in the notifier.
 *
 * `send` should resolve with an outcome instead of rejecting, must abort promptly when `signal`
 * fires, and must never put secrets (tokens, webhook URLs, credentials) into the outcome or logs.
 */
export interface NotificationChannel {
  readonly name: ChannelName;
  send(notification: Notification, signal: AbortSignal): Promise<SendOutcome>;
}
