import { afterEach, describe, expect, it, vi } from 'vitest';
import nodemailer from 'nodemailer';
import { DiscordChannel } from '../src/channels/discord.js';
import { NtfyChannel } from '../src/channels/ntfy.js';
import { EmailChannel } from '../src/channels/email.js';
import { TelegramChannel } from '../src/channels/telegram.js';
import { createChannels } from '../src/service.js';
import { parseConfig } from '../src/config.js';
import { createLogger } from '../src/logger.js';

const mail = vi.hoisted(() => ({ sendMail: vi.fn(), close: vi.fn() }));
vi.mock('nodemailer', () => ({ default: { createTransport: vi.fn(() => mail) } }));
const n = {
  title: 'Äpfel 🍏',
  message: '@everyone Nachricht',
  priority: 'urgent' as const,
  source: 'agent',
};
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});
describe('HTTP providers', () => {
  it('suppresses all Discord mentions, waits for acceptance and truncates safely', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}'));
    vi.stubGlobal('fetch', fetchMock);
    await new DiscordChannel({ webhookUrl: 'https://discord.com/api/webhooks/1/secret' }).send(
      { ...n, message: '😀'.repeat(2000) },
      new AbortController().signal,
    );
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toContain('wait=true');
    const body = JSON.parse(init.body);
    expect(body.allowed_mentions).toEqual({ parse: [] });
    expect(body.content.length).toBeLessThanOrEqual(2000);
    expect(body.content).not.toMatch(/[\uD800-\uDBFF]$/);
    expect(init.redirect).toBe('error');
  });
  it('publishes Unicode ntfy JSON to the root with fixed topic and token', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}'));
    vi.stubGlobal('fetch', fetchMock);
    await new NtfyChannel({
      serverUrl: 'https://ntfy.example',
      topic: 'private',
      token: 'secret',
    }).send(n, new AbortController().signal);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://ntfy.example/');
    expect(JSON.parse(init.body)).toEqual({
      topic: 'private',
      title: n.title,
      message: '[agent]\n@everyone Nachricht',
      priority: 5,
    });
    expect(init.headers.Authorization).toBe('Bearer secret');
  });
  it.each([
    [401, 'provider_auth_failed'],
    [403, 'provider_auth_failed'],
    [400, 'provider_rejected'],
    [503, 'provider_error'],
  ])('maps HTTP %s', async (status, error) => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('secret', { status: Number(status) })),
    );
    expect(
      await new NtfyChannel({ serverUrl: 'https://ntfy.example', topic: 'x' }).send(
        n,
        new AbortController().signal,
      ),
    ).toEqual({ ok: false, error });
  });
  it('maps retry hints and strips network exceptions', async () => {
    const channel = new DiscordChannel({ webhookUrl: 'https://discord.com/api/webhooks/1/secret' });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('{"retry_after":1.5}', { status: 429 })),
    );
    expect(await channel.send(n, new AbortController().signal)).toEqual({
      ok: false,
      error: 'rate_limited',
      retryAfterMs: 1500,
    });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('secret webhook')));
    expect(await channel.send(n, AbortSignal.abort())).toEqual({
      ok: false,
      error: 'provider_timeout',
    });
  });
  it('caps Telegram content at 4096 Unicode characters', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{"ok":true}'));
    vi.stubGlobal('fetch', fetchMock);
    await new TelegramChannel({ botToken: '1:secret', chatId: '1' }).send(
      { ...n, message: 'a'.repeat(5000) },
      new AbortController().signal,
    );
    expect(Array.from(JSON.parse(fetchMock.mock.calls[0]![1].body).text).length).toBe(4096);
  });
});
describe('SMTP', () => {
  const config = {
    host: 'smtp.example',
    port: 587,
    secure: false,
    from: 'a@example.com',
    to: 'b@example.com',
    auth: { user: 'user', password: 'secret' },
  };
  it('uses STARTTLS, fixed recipient, priority and text only', async () => {
    mail.sendMail.mockResolvedValue({ accepted: ['b@example.com'] });
    expect(await new EmailChannel(config).send(n, new AbortController().signal)).toEqual({
      ok: true,
    });
    expect(nodemailer.createTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        requireTLS: true,
        secure: false,
        auth: { user: 'user', pass: 'secret' },
        disableFileAccess: true,
        disableUrlAccess: true,
      }),
    );
    expect(mail.sendMail).toHaveBeenCalledWith({
      from: config.from,
      to: config.to,
      subject: `${n.title} [agent]`,
      text: n.message,
      priority: 'high',
    });
    expect(mail.close).toHaveBeenCalled();
  });
  it.each([
    ['EAUTH', undefined, 'provider_auth_failed'],
    ['ETIMEDOUT', undefined, 'provider_timeout'],
    ['', 450, 'provider_error'],
    ['', 550, 'provider_rejected'],
    ['ECONNECTION', undefined, 'provider_unreachable'],
  ])('sanitizes %s/%s', async (code, responseCode, error) => {
    mail.sendMail.mockRejectedValue({ code, responseCode, message: 'secret' });
    expect(await new EmailChannel(config).send(n, new AbortController().signal)).toEqual({
      ok: false,
      error,
    });
  });
  it('returns promptly on cancellation and closes its transport', async () => {
    mail.sendMail.mockReturnValue(new Promise(() => undefined));
    const controller = new AbortController();
    const result = new EmailChannel(config).send(n, controller.signal);
    controller.abort();
    expect(await result).toEqual({ ok: false, error: 'provider_timeout' });
    expect(mail.close).toHaveBeenCalled();
  });
});
it('constructs all enabled adapters', () => {
  const { config } = parseConfig({
    HTTP_API_TOKEN: 'a'.repeat(32),
    TELEGRAM_ENABLED: 'true',
    TELEGRAM_BOT_TOKEN: '1:secret',
    TELEGRAM_CHAT_ID: '1',
    DISCORD_ENABLED: 'true',
    DISCORD_WEBHOOK_URL: 'https://discord.com/api/webhooks/1/secret',
    NTFY_ENABLED: 'true',
    NTFY_TOPIC: 'x',
    EMAIL_ENABLED: 'true',
    SMTP_HOST: 'smtp.example',
    EMAIL_FROM: 'a@example.com',
    EMAIL_TO: 'b@example.com',
  });
  expect(createChannels(config, createLogger('silent')).map((c) => c.name)).toEqual([
    'telegram',
    'email',
    'discord',
    'ntfy',
  ]);
});
