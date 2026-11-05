import type { NtfyConfig } from '../config.js';
import type { Notification } from '../core/types.js';
import type { NotificationChannel } from './channel.js';
import { postJson } from './http-provider.js';

export class NtfyChannel implements NotificationChannel {
  readonly name = 'ntfy' as const;
  constructor(private readonly config: NtfyConfig) {}
  send(n: Notification, signal: AbortSignal) {
    return postJson(
      `${this.config.serverUrl}/`,
      {
        topic: this.config.topic,
        title: n.title,
        message: `${n.source ? `[${n.source}]\n` : ''}${n.message}`,
        priority: { low: 1, normal: 3, urgent: 5 }[n.priority],
      },
      signal,
      this.config.token ? { Authorization: `Bearer ${this.config.token}` } : {},
    );
  }
}
