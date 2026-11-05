import { expect, it, vi, afterEach } from 'vitest';
import { TelegramChannel } from '../src/channels/telegram.js';
const channel = new TelegramChannel({ botToken: '123:secret', chatId: '42' });
const notification = { title: 'Test', message: 'Hello', priority: 'low' as const };
afterEach(() => vi.unstubAllGlobals());
it('sends plain text silently at low priority', async () => {
  const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true })));
  vi.stubGlobal('fetch', fetchMock);
  expect(await channel.send(notification, new AbortController().signal)).toEqual({ ok: true });
  const body = JSON.parse(fetchMock.mock.calls[0]![1].body);
  expect(body).toEqual({ chat_id: '42', text: 'Test\n\nHello', disable_notification: true });
});
it.each([
  [401, 'provider_auth_failed'],
  [500, 'provider_error'],
  [400, 'provider_rejected'],
])('maps status %s', async (status, error) => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: Number(status) })));
  expect(await channel.send(notification, new AbortController().signal)).toEqual({
    ok: false,
    error,
  });
});
it('honors retry delay and sanitizes network errors', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(new Response('{"parameters":{"retry_after":3}}', { status: 429 })),
  );
  expect(await channel.send(notification, new AbortController().signal)).toEqual({
    ok: false,
    error: 'rate_limited',
    retryAfterMs: 3000,
  });
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('123:secret')));
  expect(await channel.send(notification, new AbortController().signal)).toEqual({
    ok: false,
    error: 'provider_unreachable',
  });
});
