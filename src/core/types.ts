/** All channel names known to the service. Only the user selects among them (tray). */
export const CHANNEL_NAMES = ['telegram', 'email', 'discord', 'ntfy', 'console'] as const;
export type ChannelName = (typeof CHANNEL_NAMES)[number];

export const PRIORITIES = ['low', 'normal', 'urgent'] as const;
export type Priority = (typeof PRIORITIES)[number];

/** A validated notification as handed to channel adapters. */
export interface Notification {
  title: string;
  message: string;
  priority: Priority;
  source?: string;
}

/** Why a single channel failed. Codes only – never provider responses or secrets. */
export type ChannelErrorCode =
  | 'provider_timeout' // request did not complete within the channel timeout
  | 'provider_unreachable' // network, DNS or TLS failure
  | 'provider_auth_failed' // credentials rejected (401/403, SMTP auth)
  | 'provider_rejected' // other 4xx: provider refused the request
  | 'provider_error' // 5xx or unexpected provider response
  | 'rate_limited' // provider throttled us (429)
  | 'deadline_exceeded' // overall delivery deadline reached
  | 'internal_error'; // unexpected exception inside the adapter

export type ChannelStatus = 'sent' | 'failed';

/** Outcome for one channel. Internal only: written to the log, never returned to callers. */
export type ChannelResult =
  | { channel: ChannelName; status: 'sent'; attempts: number }
  | { channel: ChannelName; status: 'failed'; attempts: number; error: ChannelErrorCode };

/**
 * `sent` means every selected channel was accepted by its provider, not that it was read.
 * `muted` means the user has no available channel selected; it is not an error.
 */
export type NotifyStatus = 'sent' | 'partial' | 'failed' | 'muted';

/** What callers (MCP, HTTP) receive. Deliberately without channel names. */
export interface NotifyResult {
  id: string;
  status: NotifyStatus;
}

/** Internal delivery report including per-channel results; only for logging. */
export interface DeliveryReport extends NotifyResult {
  results: ChannelResult[];
}

/** Errors that reject a whole request before any channel is attempted. */
export type RequestErrorCode = 'invalid_input' | 'rate_limited';
