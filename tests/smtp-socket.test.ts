import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { expect, it } from 'vitest';
import { EmailChannel } from '../src/channels/email.js';

it('destroys a stalled SMTP socket on cancellation without waiting for a provider', async () => {
  let accepted!: () => void;
  let disconnected!: () => void;
  const connected = new Promise<void>((resolve) => {
    accepted = resolve;
  });
  const closed = new Promise<void>((resolve) => {
    disconnected = resolve;
  });
  const server = createServer((socket) => {
    accepted();
    socket.on('close', disconnected);
    socket.resume();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const controller = new AbortController();
  try {
    const channel = new EmailChannel({
      host: '127.0.0.1',
      port: (server.address() as AddressInfo).port,
      secure: false,
      from: 'a@example.com',
      to: 'b@example.com',
    });
    const sending = channel.send(
      { title: 'Test', message: 'Test', priority: 'normal' },
      controller.signal,
    );
    await connected;
    controller.abort();
    expect(await sending).toEqual({ ok: false, error: 'provider_timeout' });
    await closed;
  } finally {
    controller.abort();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
