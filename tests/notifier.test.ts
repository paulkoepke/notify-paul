import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NotificationChannel, SendOutcome } from '../src/channels/channel.js';
import { Notifier, type NotifierOptions } from '../src/core/notifier.js';
import type { ChannelName, Notification } from '../src/core/types.js';
import { createLogger } from '../src/logger.js';

const NOTIFICATION: Notification = {
  title: 'secret title',
  message: 'secret body',
  priority: 'normal',
  source: 'claude-code',
};

type SendImpl = (signal: AbortSignal, call: number) => Promise<SendOutcome>;

function mockChannel(name: ChannelName, impl: SendImpl = () => Promise.resolve({ ok: true })) {
  let calls = 0;
  const send = vi.fn((_n: Notification, signal: AbortSignal) => impl(signal, ++calls));
  return { name, send } satisfies NotificationChannel;
}

const fail =
  (error: SendOutcome & { ok: false }): SendImpl =>
  () =>
    Promise.resolve(error);

/** Resolves when the signal aborts, like a well-behaved adapter whose request hangs. */
const hangUntilAborted: SendImpl = (signal) =>
  new Promise((resolve) =>
    signal.addEventListener('abort', () => resolve({ ok: false, error: 'provider_timeout' })),
  );

function setup(
  channels: NotificationChannel[],
  selected: ChannelName[] = channels.map((c) => c.name),
  options: Partial<NotifierOptions> = {},
) {
  const logs: Record<string, unknown>[] = [];
  const logger = createLogger('info', { write: (l: string) => void logs.push(JSON.parse(l)) });
  const notifier = new Notifier({
    channels,
    selection: { getSelected: () => selected },
    logger,
    rateLimitPerMinute: 100,
    ...options,
  });
  const lastReport = () => logs.findLast((l) => l.msg === 'Notification processed.');
  return { notifier, logs, lastReport };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('Notifier', () => {
  describe('selection and overall status', () => {
    it('is muted without contacting any channel when nothing is selected', async () => {
      const telegram = mockChannel('telegram');
      const { notifier } = setup([telegram], []);

      const outcome = await notifier.notify(NOTIFICATION);

      expect(outcome).toEqual({ ok: true, result: { id: expect.any(String), status: 'muted' } });
      expect(telegram.send).not.toHaveBeenCalled();
    });

    it('is muted when only unavailable channels are selected', async () => {
      const telegram = mockChannel('telegram');
      const { notifier } = setup([telegram], ['email', 'discord']);
      expect(await notifier.notify(NOTIFICATION)).toMatchObject({ result: { status: 'muted' } });
      expect(telegram.send).not.toHaveBeenCalled();
    });

    it('sends to one selected channel only', async () => {
      const telegram = mockChannel('telegram');
      const discord = mockChannel('discord');
      const { notifier } = setup([telegram, discord], ['discord']);

      expect(await notifier.notify(NOTIFICATION)).toMatchObject({ result: { status: 'sent' } });
      expect(telegram.send).not.toHaveBeenCalled();
      expect(discord.send).toHaveBeenCalledOnce();
      expect(discord.send.mock.calls[0]![0]).toEqual(NOTIFICATION);
    });

    it('is sent when all of several selected channels succeed', async () => {
      const channels = [mockChannel('telegram'), mockChannel('ntfy'), mockChannel('console')];
      const { notifier } = setup(channels);
      expect(await notifier.notify(NOTIFICATION)).toMatchObject({ result: { status: 'sent' } });
      for (const c of channels) expect(c.send).toHaveBeenCalledOnce();
    });

    it('is partial when some channels fail', async () => {
      const { notifier } = setup([
        mockChannel('telegram'),
        mockChannel('discord', fail({ ok: false, error: 'provider_auth_failed' })),
      ]);
      expect(await notifier.notify(NOTIFICATION)).toMatchObject({ result: { status: 'partial' } });
    });

    it('is failed when every channel fails', async () => {
      const { notifier } = setup([
        mockChannel('telegram', fail({ ok: false, error: 'provider_rejected' })),
        mockChannel('discord', () => Promise.reject(new Error('boom https://secret'))),
      ]);
      expect(await notifier.notify(NOTIFICATION)).toMatchObject({ result: { status: 'failed' } });
    });

    it('returns only id and status to callers', async () => {
      const { notifier } = setup([mockChannel('telegram')]);
      const outcome = await notifier.notify(NOTIFICATION);
      if (!outcome.ok) throw new Error('expected ok');
      expect(Object.keys(outcome.result).sort()).toEqual(['id', 'status']);
      expect(outcome.result.id).toMatch(/^notif_[0-9a-f-]{36}$/);
      expect(JSON.stringify(outcome)).not.toContain('telegram');
    });

    it('uses the current selection for every notification', async () => {
      const selected: ChannelName[] = [];
      const { notifier } = setup([mockChannel('telegram')], selected);

      expect(await notifier.notify(NOTIFICATION)).toMatchObject({ result: { status: 'muted' } });
      selected.push('telegram');
      expect(await notifier.notify(NOTIFICATION)).toMatchObject({ result: { status: 'sent' } });
    });
  });

  describe('logging', () => {
    it('logs per-channel results and metadata without content', async () => {
      const { notifier, lastReport, logs } = setup([
        mockChannel('telegram'),
        mockChannel('discord', () => Promise.reject(new Error('leaky-secret'))),
      ]);

      const outcome = await notifier.notify(NOTIFICATION);

      expect(lastReport()).toMatchObject({
        level: 40,
        id: outcome.ok ? outcome.result.id : undefined,
        priority: 'normal',
        source: 'claude-code',
        status: 'partial',
        results: [
          { channel: 'telegram', status: 'sent', attempts: 1 },
          { channel: 'discord', status: 'failed', attempts: 1, error: 'internal_error' },
        ],
      });
      const raw = JSON.stringify(logs);
      expect(raw).not.toContain('secret title');
      expect(raw).not.toContain('secret body');
      expect(raw).not.toContain('leaky-secret');
    });
  });

  describe('independence and deadlines', () => {
    it('does not let a hanging channel block the others', async () => {
      const telegram = mockChannel('telegram');
      const discord = mockChannel('discord', () => new Promise<never>(() => {}));
      const { notifier, lastReport } = setup([telegram, discord], undefined, {
        attemptTimeoutMs: 60_000,
      });

      const pending = notifier.notify(NOTIFICATION);
      await vi.advanceTimersByTimeAsync(10_000);

      expect(await pending).toMatchObject({ result: { status: 'partial' } });
      expect(lastReport()).toMatchObject({
        results: [
          { channel: 'telegram', status: 'sent' },
          { channel: 'discord', status: 'failed', error: 'deadline_exceeded', attempts: 1 },
        ],
      });
    });

    it('aborts the signal passed to the adapter at the overall deadline', async () => {
      const ntfy = mockChannel('ntfy', hangUntilAborted);
      const { notifier, lastReport } = setup([ntfy], undefined, {
        deadlineMs: 2_000,
        attemptTimeoutMs: 60_000,
      });

      const pending = notifier.notify(NOTIFICATION);
      await vi.advanceTimersByTimeAsync(1_999);
      expect(ntfy.send.mock.calls[0]![1].aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);

      expect(await pending).toMatchObject({ result: { status: 'failed' } });
      expect(ntfy.send.mock.calls[0]![1].aborted).toBe(true);
      expect(lastReport()).toMatchObject({
        results: [{ channel: 'ntfy', error: 'deadline_exceeded' }],
      });
    });

    it('times out a single attempt and retries it within the deadline', async () => {
      const telegram = mockChannel('telegram', (signal, call) =>
        call === 1 ? hangUntilAborted(signal, call) : Promise.resolve({ ok: true }),
      );
      const { notifier, lastReport } = setup([telegram], undefined, {
        attemptTimeoutMs: 3_000,
        retryBaseDelayMs: 500,
      });

      const pending = notifier.notify(NOTIFICATION);
      await vi.advanceTimersByTimeAsync(3_500);

      expect(await pending).toMatchObject({ result: { status: 'sent' } });
      expect(lastReport()).toMatchObject({
        results: [{ channel: 'telegram', status: 'sent', attempts: 2 }],
      });
    });
  });

  describe('retries', () => {
    it.each(['provider_timeout', 'provider_error', 'rate_limited'] as const)(
      'retries %s with exponential backoff up to the attempt limit',
      async (error) => {
        const telegram = mockChannel('telegram', fail({ ok: false, error }));
        const { notifier, lastReport } = setup([telegram], undefined, {
          retryBaseDelayMs: 500,
          maxAttempts: 3,
        });

        const pending = notifier.notify(NOTIFICATION);
        await vi.advanceTimersByTimeAsync(499);
        expect(telegram.send).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(telegram.send).toHaveBeenCalledTimes(2);
        await vi.advanceTimersByTimeAsync(1_000);
        expect(telegram.send).toHaveBeenCalledTimes(3);

        expect(await pending).toMatchObject({ result: { status: 'failed' } });
        expect(lastReport()).toMatchObject({
          results: [{ channel: 'telegram', status: 'failed', attempts: 3, error }],
        });
      },
    );

    it.each([
      'provider_auth_failed',
      'provider_rejected',
      'provider_unreachable',
      'internal_error',
    ] as const)('does not retry %s', async (error) => {
      const telegram = mockChannel('telegram', fail({ ok: false, error }));
      const { notifier } = setup([telegram]);

      await notifier.notify(NOTIFICATION);
      expect(telegram.send).toHaveBeenCalledOnce();
    });

    it('succeeds after a transient failure', async () => {
      const telegram = mockChannel('telegram', (_s, call) =>
        Promise.resolve(call === 1 ? { ok: false, error: 'provider_error' } : { ok: true }),
      );
      const { notifier } = setup([telegram]);

      const pending = notifier.notify(NOTIFICATION);
      await vi.advanceTimersByTimeAsync(500);
      expect(await pending).toMatchObject({ result: { status: 'sent' } });
      expect(telegram.send).toHaveBeenCalledTimes(2);
    });

    it('honours retryAfterMs when it fits within the deadline', async () => {
      const telegram = mockChannel('telegram', (_s, call) =>
        Promise.resolve(
          call === 1 ? { ok: false, error: 'rate_limited', retryAfterMs: 4_000 } : { ok: true },
        ),
      );
      const { notifier } = setup([telegram]);

      const pending = notifier.notify(NOTIFICATION);
      await vi.advanceTimersByTimeAsync(3_999);
      expect(telegram.send).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(await pending).toMatchObject({ result: { status: 'sent' } });
    });

    it('gives up immediately when retryAfterMs exceeds the deadline', async () => {
      const telegram = mockChannel(
        'telegram',
        fail({ ok: false, error: 'rate_limited', retryAfterMs: 30_000 }),
      );
      const { notifier, lastReport } = setup([telegram]);

      expect(await notifier.notify(NOTIFICATION)).toMatchObject({ result: { status: 'failed' } });
      expect(telegram.send).toHaveBeenCalledOnce();
      expect(lastReport()).toMatchObject({
        results: [{ channel: 'telegram', error: 'rate_limited', attempts: 1 }],
      });
    });
  });

  describe('rate limit', () => {
    it('rejects requests above the global limit, regardless of priority', async () => {
      const telegram = mockChannel('telegram');
      const { notifier, logs } = setup([telegram], undefined, { rateLimitPerMinute: 2 });

      await notifier.notify(NOTIFICATION);
      await notifier.notify({ ...NOTIFICATION, priority: 'low' });
      expect(await notifier.notify({ ...NOTIFICATION, priority: 'urgent' })).toEqual({
        ok: false,
        error: 'rate_limited',
      });
      expect(telegram.send).toHaveBeenCalledTimes(2);
      expect(logs.some((l) => l.msg === 'Notification rate-limited.')).toBe(true);

      vi.advanceTimersByTime(60_000);
      expect(await notifier.notify(NOTIFICATION)).toMatchObject({ ok: true });
    });

    it('counts muted notifications too', async () => {
      const { notifier } = setup([mockChannel('telegram')], [], { rateLimitPerMinute: 1 });
      await notifier.notify(NOTIFICATION);
      expect(await notifier.notify(NOTIFICATION)).toEqual({ ok: false, error: 'rate_limited' });
    });
  });
});
