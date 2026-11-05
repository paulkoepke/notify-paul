import type { NotificationChannel } from '../channels/channel.js';
import type { ChannelName } from './types.js';

/**
 * Target channels = selected by the user ∩ available. Callers have no say in this.
 * An empty result means the notification is muted.
 */
export function resolveTargets(
  available: readonly NotificationChannel[],
  selected: readonly ChannelName[],
): NotificationChannel[] {
  return available.filter((channel) => selected.includes(channel.name));
}
