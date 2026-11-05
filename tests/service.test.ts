import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseConfig, type Config } from '../src/config.js';
import { createLogger } from '../src/logger.js';
import { PortInUseError, startService, type RunningService } from '../src/service.js';

const TOKEN = 'test-token-0123456789abcdefghijklmnop';

let dir: string;
let running: RunningService[];
const logger = createLogger('silent');

function config(overrides: Record<string, string> = {}): Config {
  return parseConfig({
    HTTP_API_TOKEN: TOKEN,
    PORT: '1',
    CONSOLE_ENABLED: 'true',
    TRAY_ENABLED: 'false',
    SETTINGS_FILE: join(dir, 'settings.json'),
    ...overrides,
  }).config;
}

async function start(cfg: Config): Promise<RunningService> {
  const service = await startService({ ...cfg, port: cfg.port === 1 ? 0 : cfg.port }, logger);
  running.push(service);
  return service;
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'notify-paul-service-'));
  running = [];
});

afterEach(async () => {
  await Promise.all(running.map((s) => s.stop()));
  await rm(dir, { recursive: true, force: true });
});

describe('startService', () => {
  it('serves /health and /notify end to end with the console channel', async () => {
    const service = await start(config());
    const base = `http://127.0.0.1:${service.port}`;

    const health = await fetch(`${base}/health`);
    expect(await health.json()).toEqual({ status: 'ok', service: 'notify-paul' });

    const res = await fetch(`${base}/notify`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Hi', message: 'there' }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'sent' });
    expect(service.settings.getSelected()).toEqual(['console']);
  });

  it('reports muted when no channel is available', async () => {
    const service = await start(config({ CONSOLE_ENABLED: 'false' }));
    const res = await fetch(`http://127.0.0.1:${service.port}/notify`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Hi', message: 'there' }),
    });
    expect(await res.json()).toMatchObject({ status: 'muted' });
  });

  it('fails with PortInUseError when the port is taken', async () => {
    const first = await start(config());
    await expect(start(config({ PORT: String(first.port) }))).rejects.toBeInstanceOf(
      PortInUseError,
    );
  });

  it('stops idempotently and frees the port', async () => {
    const service = await start(config());
    await Promise.all([service.stop(), service.stop()]);
    await expect(fetch(`http://127.0.0.1:${service.port}/health`)).rejects.toThrow();
  });
});
