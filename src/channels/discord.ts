import type { DiscordConfig } from '../config.js';
import type { Notification } from '../core/types.js';
import type { NotificationChannel } from './channel.js';
import { postJson } from './http-provider.js';

export class DiscordChannel implements NotificationChannel {
  readonly name = 'discord' as const;
  constructor(private readonly config: DiscordConfig) {}
  send(n: Notification, signal: AbortSignal) {
    const text = `${n.title}${n.source ? ` [${n.source}]` : ''}\n\n${n.message}`;
    // UTF-16 limit is conservative; avoid cutting a surrogate pair.
    const content = text.slice(0, 2000).replace(/[\uD800-\uDBFF]$/, '');
    const url = new URL(this.config.webhookUrl);
    url.searchParams.set('wait', 'true');
    return postJson(url.href, { content, allowed_mentions: { parse: [] } }, signal);
  }
}
