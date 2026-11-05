import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, it, vi } from 'vitest';
import { RotatingLog } from '../src/rotating-log.js';
import { isNotifyPaulRunning } from '../src/single-instance.js';
import { sendTest } from '../src/send-test.js';
import { parseConfig } from '../src/config.js';

it('rotates logs with bounded backups and preserves complete records', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'notify-logs-'));
  const file = join(dir, 'test.log');
  const log = new RotatingLog(file, 10, 2);
  try {
    for (const record of ['11111111\n', '22222222\n', '33333333\n', '44444444\n'])
      log.write(record);
    log.close();
    expect((await readdir(dir)).sort()).toEqual(['test.log', 'test.log.1', 'test.log.2']);
    expect(await readFile(file, 'utf8')).toBe('44444444\n');
    expect(await readFile(`${file}.2`, 'utf8')).toBe('22222222\n');
  } finally {
    log.close();
    await rm(dir, { recursive: true, force: true });
  }
});
it('distinguishes NotifyPaul from a foreign listener', async () => {
  let body = { status: 'ok', service: 'notify-paul' };
  const server = createServer((_req, res) => res.end(JSON.stringify(body)));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    expect(await isNotifyPaulRunning('127.0.0.1', port)).toBe(true);
    body = { status: 'ok', service: 'other' };
    expect(await isNotifyPaulRunning('127.0.0.1', port)).toBe(false);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
it('validates the test CLI and reports a disabled requested channel', async () => {
  const config = parseConfig({ HTTP_API_TOKEN: 'a'.repeat(32) }).config;
  const print = vi.fn();
  expect(await sendTest(['--channel', 'telegram'], config, print)).toBe(1);
  await expect(sendTest(['--priority', 'wrong'], config, print)).rejects.toThrow();
  await expect(sendTest(['--channel', 'unknown'], config, print)).rejects.toThrow();
});

it('sends CLI tests directly to enabled adapters with mocked providers', async () => {
  const config = parseConfig({
    HTTP_API_TOKEN: 'a'.repeat(32),
    NTFY_ENABLED: 'true',
    NTFY_TOPIC: 'test',
  }).config;
  const fetchMock = vi.fn().mockResolvedValue(new Response('{}'));
  vi.stubGlobal('fetch', fetchMock);
  try {
    const print = vi.fn();
    expect(await sendTest(['--priority', 'low'], config, print)).toBe(0);
    expect(print).toHaveBeenCalledWith('ntfy: sent');
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body).priority).toBe(1);
  } finally {
    vi.unstubAllGlobals();
  }
});
