import { request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NotifyOutcome } from '../src/core/notifier.js';
import type { Notification } from '../src/core/types.js';
import { createLogger } from '../src/logger.js';
import { createHttpServer, type HttpServerOptions } from '../src/server/http.js';

const TOKEN = 'test-token-0123456789abcdefghijklmnop';
const VALID = { title: 'Build finished', message: 'All good.', source: 'claude-code' };

interface Reply {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Record<string, unknown>;
}

let server: Server;
let port: number;
let notify: ReturnType<typeof vi.fn<(n: Notification) => Promise<NotifyOutcome>>>;
let logs: string[];

async function start(options: Partial<HttpServerOptions> = {}) {
  logs = [];
  notify = vi.fn(() =>
    Promise.resolve<NotifyOutcome>({ ok: true, result: { id: 'notif_1', status: 'sent' } }),
  );
  server = createHttpServer({
    host: '127.0.0.1',
    apiToken: TOKEN,
    notifier: { notify },
    logger: createLogger('info', { write: (l: string) => void logs.push(l) }),
    ...options,
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
}

function send(
  method: string,
  path: string,
  { headers = {}, body }: { headers?: Record<string, string>; body?: string | Buffer } = {},
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port, method, path, headers: { Host: `127.0.0.1:${port}`, ...headers } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: text ? (JSON.parse(text) as Record<string, unknown>) : {},
          });
        });
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

function postNotify(
  payload: unknown = VALID,
  headers: Record<string, string> = {},
): Promise<Reply> {
  return send('POST', '/notify', {
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
      ...headers,
    },
    body: typeof payload === 'string' ? payload : JSON.stringify(payload),
  });
}

const errorCode = (reply: Reply) => (reply.body.error as { code: string }).code;

beforeEach(async () => {
  await start();
});

async function stop() {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}

async function restart(options: Partial<HttpServerOptions>) {
  await stop();
  await start(options);
}

afterEach(stop);

describe('GET /health', () => {
  it('answers without token and without channel names', async () => {
    const reply = await send('GET', '/health');
    expect(reply.status).toBe(200);
    expect(reply.body).toEqual({ status: 'ok', service: 'notify-paul' });
    expect(reply.headers['cache-control']).toBe('no-store');
  });

  it('still checks the Host header', async () => {
    const reply = await send('GET', '/health', { headers: { Host: `evil.example:${port}` } });
    expect(reply.status).toBe(403);
    expect(errorCode(reply)).toBe('forbidden_host');
  });

  it('rejects other methods with 405 and Allow', async () => {
    const reply = await send('POST', '/health');
    expect(reply.status).toBe(405);
    expect(reply.headers.allow).toBe('GET');
  });
});

describe('POST /notify', () => {
  it('delivers a valid notification and returns only id and status', async () => {
    const reply = await postNotify();
    expect(reply.status).toBe(200);
    expect(reply.body).toEqual({ id: 'notif_1', status: 'sent' });
    expect(notify).toHaveBeenCalledWith({ ...VALID, priority: 'normal' });
  });

  it.each(['muted', 'partial', 'failed'] as const)(
    'passes status %s through with 200',
    async (s) => {
      notify.mockResolvedValueOnce({ ok: true, result: { id: 'notif_2', status: s } });
      const reply = await postNotify();
      expect(reply.status).toBe(200);
      expect(reply.body).toEqual({ id: 'notif_2', status: s });
    },
  );

  it('accepts a charset parameter and a lower-case bearer scheme', async () => {
    const reply = await postNotify(VALID, {
      'Content-Type': 'application/json; charset=utf-8',
      Authorization: `bearer ${TOKEN}`,
    });
    expect(reply.status).toBe(200);
  });

  describe('token', () => {
    it('rejects a missing token', async () => {
      const reply = await send('POST', '/notify', {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(VALID),
      });
      expect(reply.status).toBe(401);
      expect(errorCode(reply)).toBe('unauthorized');
      expect(reply.headers['www-authenticate']).toBe('Bearer');
      expect(notify).not.toHaveBeenCalled();
    });

    it.each([
      ['wrong token', `Bearer ${TOKEN}x`],
      ['token prefix', `Bearer ${TOKEN.slice(0, -1)}`],
      ['wrong scheme', `Basic ${TOKEN}`],
      ['empty bearer', 'Bearer '],
    ])('rejects %s', async (_, authorization) => {
      const reply = await postNotify(VALID, { Authorization: authorization });
      expect(reply.status).toBe(401);
      expect(notify).not.toHaveBeenCalled();
    });

    it('never echoes or logs the token', async () => {
      const reply = await postNotify(VALID, { Authorization: `Bearer ${TOKEN}x` });
      expect(JSON.stringify(reply)).not.toContain(TOKEN);
      expect(logs.join('\n')).not.toContain(TOKEN);
    });
  });

  describe('host and origin', () => {
    it.each(['localhost', '[::1]'])('accepts Host %s', async (name) => {
      const reply = await postNotify(VALID, { Host: `${name}:${port}` });
      expect(reply.status).toBe(200);
    });

    it.each([
      ['foreign host', () => `evil.example:${port}`],
      ['rebinding name', () => `attacker.localhost.example:${port}`],
      ['wrong port', () => `127.0.0.1:${port + 1}`],
      ['missing port', () => '127.0.0.1'],
    ])('rejects %s', async (_, host) => {
      const reply = await postNotify(VALID, { Host: host() });
      expect(reply.status).toBe(403);
      expect(errorCode(reply)).toBe('forbidden_host');
      expect(notify).not.toHaveBeenCalled();
    });

    it('accepts a local Origin', async () => {
      const reply = await postNotify(VALID, { Origin: `http://localhost:${port}` });
      expect(reply.status).toBe(200);
    });

    it.each([
      ['foreign origin', () => 'https://evil.example'],
      ['null origin', () => 'null'],
      ['local name on other port', () => `http://localhost:${port + 1}`],
      ['https scheme', () => `https://127.0.0.1:${port}`],
    ])('rejects %s', async (_, origin) => {
      const reply = await postNotify(VALID, { Origin: origin() });
      expect(reply.status).toBe(403);
      expect(errorCode(reply)).toBe('forbidden_origin');
      expect(notify).not.toHaveBeenCalled();
    });

    it('accepts the bind address as host name', async () => {
      await restart({ host: '127.0.0.2' });
      const reply = await postNotify(VALID, { Host: `127.0.0.2:${port}` });
      expect(reply.status).toBe(200);
    });
  });

  describe('content type', () => {
    it.each([
      ['missing', undefined],
      ['text/plain', 'text/plain'],
      ['form', 'application/x-www-form-urlencoded'],
      ['json-like', 'application/jsonx'],
      ['other charset', 'application/json; charset=latin1'],
    ])('rejects %s', async (_, contentType) => {
      const headers: Record<string, string> = { Authorization: `Bearer ${TOKEN}` };
      if (contentType !== undefined) headers['Content-Type'] = contentType;
      const reply = await send('POST', '/notify', { headers, body: JSON.stringify(VALID) });
      expect(reply.status).toBe(415);
      expect(errorCode(reply)).toBe('unsupported_media_type');
      expect(notify).not.toHaveBeenCalled();
    });
  });

  describe('body', () => {
    it('rejects a body above the limit by Content-Length', async () => {
      const reply = await postNotify({ ...VALID, message: 'x'.repeat(70 * 1024) });
      expect(reply.status).toBe(413);
      expect(errorCode(reply)).toBe('payload_too_large');
      expect(notify).not.toHaveBeenCalled();
    });

    it('rejects a chunked body above the limit', async () => {
      await restart({ maxBodyBytes: 1024 });
      const reply = await send('POST', '/notify', {
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          'Content-Type': 'application/json',
          'Transfer-Encoding': 'chunked',
        },
        body: JSON.stringify({ ...VALID, message: 'x'.repeat(2048) }),
      });
      expect(reply.status).toBe(413);
    });

    it.each([
      ['malformed JSON', '{"title":'],
      ['empty body', ''],
    ])('rejects %s', async (_, body) => {
      const reply = await postNotify(body);
      expect(reply.status).toBe(400);
      expect(errorCode(reply)).toBe('invalid_json');
    });

    it('rejects invalid input with details', async () => {
      const reply = await postNotify({ ...VALID, title: '' });
      expect(reply.status).toBe(400);
      expect(errorCode(reply)).toBe('invalid_input');
      expect((reply.body.error as { details: string[] }).details[0]).toMatch(/^title:/);
      expect(notify).not.toHaveBeenCalled();
    });

    it('rejects caller-chosen channels and recipients', async () => {
      const reply = await postNotify({ ...VALID, channels: ['telegram'], chat_id: '1' });
      expect(reply.status).toBe(400);
      expect(errorCode(reply)).toBe('invalid_input');
    });

    it('rejects a JSON array', async () => {
      const reply = await postNotify([VALID]);
      expect(errorCode(reply)).toBe('invalid_input');
    });
  });

  it('maps rate limiting to 429', async () => {
    notify.mockResolvedValueOnce({ ok: false, error: 'rate_limited' });
    const reply = await postNotify();
    expect(reply.status).toBe(429);
    expect(errorCode(reply)).toBe('rate_limited');
  });

  it('returns 500 without details when the notifier throws', async () => {
    notify.mockRejectedValueOnce(new Error(`boom ${TOKEN}`));
    const reply = await postNotify();
    expect(reply.status).toBe(500);
    expect(reply.body).toEqual({ error: { code: 'internal_error', message: 'Internal error.' } });
    expect(logs.join('\n')).not.toContain('boom');
  });

  it('keeps notification content out of the log', async () => {
    await postNotify({ ...VALID, title: 'secret-title' }, { Authorization: 'Bearer wrong' });
    await postNotify({ ...VALID, title: '' });
    expect(logs.join('\n')).not.toContain('secret-title');
    expect(logs.join('\n')).not.toContain('All good.');
  });
});

describe('/mcp', () => {
  it('requires the token', async () => {
    const reply = await send('POST', '/mcp', {
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(reply.status).toBe(401);
  });

  it('checks Host before anything else', async () => {
    const reply = await send('POST', '/mcp', { headers: { Host: `evil.example:${port}` } });
    expect(reply.status).toBe(403);
  });

  it('is not found while no handler is attached', async () => {
    const reply = await send('POST', '/mcp', {
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(reply.status).toBe(404);
  });

  it('hands authenticated requests with parsed body to the handler', async () => {
    const mcpHandler = vi.fn<NonNullable<HttpServerOptions['mcpHandler']>>((_req, res) => {
      res.writeHead(202).end();
      return Promise.resolve();
    });
    await restart({ mcpHandler });
    const reply = await send('POST', '/mcp', {
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: '{"jsonrpc":"2.0"}',
    });
    expect(reply.status).toBe(202);
    expect(mcpHandler.mock.calls[0]![2]).toEqual({ jsonrpc: '2.0' });
  });
});

it('answers unknown paths with 404', async () => {
  const reply = await send('GET', '/nope');
  expect(reply.status).toBe(404);
  expect(errorCode(reply)).toBe('not_found');
});
