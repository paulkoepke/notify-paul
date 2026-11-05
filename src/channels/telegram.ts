import type { TelegramConfig } from '../config.js';
import type { Notification } from '../core/types.js';
import type { NotificationChannel, SendOutcome } from './channel.js';

export class TelegramChannel implements NotificationChannel {
  readonly name = 'telegram' as const;
  constructor(private readonly config: TelegramConfig) {}
  async send(notification: Notification, signal: AbortSignal): Promise<SendOutcome> {
    const text = `${notification.title}${notification.source ? ` [${notification.source}]` : ''}\n\n${notification.message}`;
    try {
      const response = await fetch(
        `https://api.telegram.org/bot${this.config.botToken}/sendMessage`,
        {
          method: 'POST',
          signal,
          redirect: 'error',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: this.config.chatId,
            text: Array.from(text).slice(0, 4096).join(''),
            disable_notification: notification.priority === 'low',
          }),
        },
      );
      if (response.status === 401 || response.status === 403)
        return { ok: false, error: 'provider_auth_failed' };
      if (response.status === 429) {
        const data = (await response.json().catch(() => null)) as {
          parameters?: { retry_after?: unknown };
        } | null;
        const delay = data?.parameters?.retry_after;
        return {
          ok: false,
          error: 'rate_limited',
          ...(typeof delay === 'number' && Number.isFinite(delay) && delay >= 0
            ? { retryAfterMs: delay * 1000 }
            : {}),
        };
      }
      if (!response.ok)
        return {
          ok: false,
          error: response.status >= 500 ? 'provider_error' : 'provider_rejected',
        };
      const data = (await response.json()) as { ok?: boolean };
      return data.ok === true ? { ok: true } : { ok: false, error: 'provider_error' };
    } catch {
      return { ok: false, error: signal.aborted ? 'provider_timeout' : 'provider_unreachable' };
    }
  }
}
