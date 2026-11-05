import { randomUUID } from 'node:crypto';
import type { NotificationChannel, SendOutcome } from '../channels/channel.js';
import type { Logger } from '../logger.js';
import { RateLimiter } from './rate-limiter.js';
import { resolveTargets } from './router.js';
import type { ChannelSelection } from './settings.js';
import type {
  ChannelErrorCode,
  ChannelResult,
  DeliveryReport,
  Notification,
  NotifyResult,
  NotifyStatus,
} from './types.js';

export const DELIVERY_DEFAULTS = {
  /** Overall deadline for one notification across all channels and retries. */
  deadlineMs: 10_000,
  /** Per-attempt limit; an attempt exceeding it counts as `provider_timeout`. */
  attemptTimeoutMs: 5_000,
  maxAttempts: 3,
  /** Exponential backoff base when the provider gives no `retryAfterMs`. */
  retryBaseDelayMs: 500,
} as const;

/** Only transient provider failures are retried. */
const RETRYABLE: ReadonlySet<ChannelErrorCode> = new Set([
  'provider_timeout',
  'rate_limited',
  'provider_error',
]);

export interface NotifierOptions {
  /** Available (= enabled and constructed) channels. */
  channels: readonly NotificationChannel[];
  selection: ChannelSelection;
  logger: Logger;
  rateLimitPerMinute: number;
  deadlineMs?: number;
  attemptTimeoutMs?: number;
  maxAttempts?: number;
  retryBaseDelayMs?: number;
}

export type NotifyOutcome =
  { ok: true; result: NotifyResult } | { ok: false; error: 'rate_limited' };

/** Routing service shared by MCP and `POST /notify`. Input must already be validated. */
export class Notifier {
  private readonly rateLimiter: RateLimiter;
  private readonly deadlineMs: number;
  private readonly attemptTimeoutMs: number;
  private readonly maxAttempts: number;
  private readonly retryBaseDelayMs: number;

  constructor(private readonly options: NotifierOptions) {
    this.rateLimiter = new RateLimiter(options.rateLimitPerMinute);
    this.deadlineMs = options.deadlineMs ?? DELIVERY_DEFAULTS.deadlineMs;
    this.attemptTimeoutMs = options.attemptTimeoutMs ?? DELIVERY_DEFAULTS.attemptTimeoutMs;
    this.maxAttempts = options.maxAttempts ?? DELIVERY_DEFAULTS.maxAttempts;
    this.retryBaseDelayMs = options.retryBaseDelayMs ?? DELIVERY_DEFAULTS.retryBaseDelayMs;
  }

  async notify(notification: Notification): Promise<NotifyOutcome> {
    if (!this.rateLimiter.tryAcquire()) {
      this.options.logger.warn({ priority: notification.priority }, 'Notification rate-limited.');
      return { ok: false, error: 'rate_limited' };
    }

    const report = await this.deliver(notification);
    return { ok: true, result: { id: report.id, status: report.status } };
  }

  private async deliver(notification: Notification): Promise<DeliveryReport> {
    const id = `notif_${randomUUID()}`;
    const startedAt = Date.now();
    const targets = resolveTargets(this.options.channels, this.options.selection.getSelected());

    const deadline = new AbortController();
    const deadlineAt = startedAt + this.deadlineMs;
    const timer = setTimeout(() => deadline.abort(), this.deadlineMs);
    let results: ChannelResult[];
    try {
      // deliverTo never rejects, so allSettled is not needed to keep channels independent.
      results = await Promise.all(
        targets.map((channel) =>
          this.deliverTo(channel, notification, deadline.signal, deadlineAt),
        ),
      );
    } finally {
      clearTimeout(timer);
    }

    const report: DeliveryReport = { id, status: overallStatus(results), results };
    const level = report.status === 'partial' || report.status === 'failed' ? 'warn' : 'info';
    this.options.logger[level](
      {
        id,
        priority: notification.priority,
        ...(notification.source !== undefined ? { source: notification.source } : {}),
        status: report.status,
        results,
        durationMs: Date.now() - startedAt,
      },
      'Notification processed.',
    );
    return report;
  }

  /** Sends to one channel with bounded retries inside the overall deadline. */
  private async deliverTo(
    channel: NotificationChannel,
    notification: Notification,
    deadline: AbortSignal,
    deadlineAt: number,
  ): Promise<ChannelResult> {
    for (let attempt = 1; ; attempt++) {
      const outcome = await this.attempt(channel, notification, deadline);
      if (outcome.ok) return { channel: channel.name, status: 'sent', attempts: attempt };

      const failed: ChannelResult = {
        channel: channel.name,
        status: 'failed',
        attempts: attempt,
        error: outcome.error,
      };
      if (attempt >= this.maxAttempts || !RETRYABLE.has(outcome.error)) return failed;

      const delay = outcome.retryAfterMs ?? this.retryBaseDelayMs * 2 ** (attempt - 1);
      if (Date.now() + delay >= deadlineAt) return failed;
      if (!(await sleep(delay, deadline))) return { ...failed, error: 'deadline_exceeded' };
    }
  }

  /**
   * One send attempt, bounded by the attempt timeout and the overall deadline even if the adapter
   * ignores its signal. Exceptions become `internal_error`.
   */
  private async attempt(
    channel: NotificationChannel,
    notification: Notification,
    deadline: AbortSignal,
  ): Promise<SendOutcome> {
    if (deadline.aborted) return { ok: false, error: 'deadline_exceeded' };

    const attemptTimeout = new AbortController();
    const timer = setTimeout(() => attemptTimeout.abort(), this.attemptTimeoutMs);
    const signal = AbortSignal.any([deadline, attemptTimeout.signal]);
    try {
      const outcome = await raceAbort(safeSend(channel, notification, signal), signal);
      if (deadline.aborted && (outcome === ABORTED || !outcome.ok)) {
        return { ok: false, error: 'deadline_exceeded' };
      }
      if (outcome === ABORTED) return { ok: false, error: 'provider_timeout' };
      return outcome;
    } finally {
      clearTimeout(timer);
    }
  }
}

function overallStatus(results: readonly ChannelResult[]): NotifyStatus {
  if (results.length === 0) return 'muted';
  const sent = results.filter((r) => r.status === 'sent').length;
  if (sent === results.length) return 'sent';
  return sent === 0 ? 'failed' : 'partial';
}

async function safeSend(
  channel: NotificationChannel,
  notification: Notification,
  signal: AbortSignal,
): Promise<SendOutcome> {
  try {
    return await channel.send(notification, signal);
  } catch {
    // The error itself may carry provider details or secrets; only the code is kept.
    return { ok: false, error: 'internal_error' };
  }
}

const ABORTED = Symbol('aborted');

function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T | typeof ABORTED> {
  if (signal.aborted) return Promise.resolve(ABORTED);
  return new Promise((resolve) => {
    const onAbort = () => resolve(ABORTED);
    signal.addEventListener('abort', onAbort, { once: true });
    void promise.then((value) => {
      signal.removeEventListener('abort', onAbort);
      resolve(value);
    });
  });
}

/** Resolves true after `ms`, or false as soon as `signal` aborts. */
function sleep(ms: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve(true);
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
