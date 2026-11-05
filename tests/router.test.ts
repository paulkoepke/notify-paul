import { describe, expect, it } from 'vitest';
import type { NotificationChannel } from '../src/channels/channel.js';
import { resolveTargets } from '../src/core/router.js';
import type { ChannelName } from '../src/core/types.js';

function channel(name: ChannelName): NotificationChannel {
  return { name, send: () => Promise.resolve({ ok: true }) };
}

const available = [channel('telegram'), channel('discord'), channel('console')];
const names = (targets: NotificationChannel[]) => targets.map((c) => c.name);

describe('resolveTargets', () => {
  it('returns nothing when no channel is selected', () => {
    expect(resolveTargets(available, [])).toEqual([]);
  });

  it('returns a single selected channel', () => {
    expect(names(resolveTargets(available, ['discord']))).toEqual(['discord']);
  });

  it('returns several selected channels in the order of the available channels', () => {
    expect(names(resolveTargets(available, ['console', 'telegram']))).toEqual([
      'telegram',
      'console',
    ]);
  });

  it('ignores selected channels that are not available', () => {
    expect(names(resolveTargets(available, ['email', 'ntfy', 'telegram']))).toEqual(['telegram']);
    expect(resolveTargets([], ['telegram'])).toEqual([]);
  });
});
