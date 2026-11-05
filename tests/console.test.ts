import { describe, expect, it } from 'vitest';
import type { NotificationChannel } from '../src/channels/channel.js';
import { ConsoleChannel } from '../src/channels/console.js';

describe('ConsoleChannel', () => {
  it('prints the notification and reports success', async () => {
    const out: string[] = [];
    const channel: NotificationChannel = new ConsoleChannel((text) => out.push(text));

    const outcome = await channel.send(
      { title: 'Build done', message: 'Line 1\nLine 2', priority: 'urgent', source: 'claude-code' },
      new AbortController().signal,
    );

    expect(outcome).toEqual({ ok: true });
    expect(out.join('')).toContain('[NotifyPaul] (urgent) claude-code: Build done\nLine 1\nLine 2');
  });
});
