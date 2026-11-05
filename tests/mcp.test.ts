import { expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createHttpServer } from '../src/server/http.js';
import { createMcpHandler } from '../src/server/mcp.js';
import { createLogger } from '../src/logger.js';
import type { AddressInfo } from 'node:net';
import { vi } from 'vitest';
import { Notifier } from '../src/core/notifier.js';
it('lists and calls notify-paul through authenticated stateless HTTP', async () => {
  const notifier = {
    notify: async () => ({ ok: true as const, result: { id: 'test', status: 'muted' as const } }),
  };
  const server = createHttpServer({
    host: '127.0.0.1',
    apiToken: 'secret',
    logger: createLogger('silent'),
    notifier,
    mcpHandler: createMcpHandler(notifier),
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`);
  const client = new Client({ name: 'test', version: '1' });
  try {
    expect((await fetch(url, { method: 'POST' })).status).toBe(401);
    await client.connect(
      new StreamableHTTPClientTransport(url, {
        requestInit: { headers: { Authorization: 'Bearer secret' } },
      }),
    );
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(['notify-paul']);
    const result = await client.callTool({
      name: 'notify-paul',
      arguments: { title: 'Hi', message: 'Test' },
    });
    expect(result.structuredContent).toEqual({ id: 'test', status: 'muted' });
    expect(result.isError).toBe(false);
    expect(
      (
        await client.callTool({
          name: 'notify-paul',
          arguments: { title: 'Hi', message: 'Test', channels: ['telegram'] },
        })
      ).isError,
    ).toBe(true);
  } finally {
    await client.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

it('shares the HTTP rate limit and sanitizes internal tool errors', async () => {
  const logger = createLogger('silent');
  const notifier = new Notifier({
    channels: [],
    selection: { getSelected: () => [] },
    logger,
    rateLimitPerMinute: 1,
  });
  const server = createHttpServer({
    host: '127.0.0.1',
    apiToken: 'secret',
    logger,
    notifier,
    mcpHandler: createMcpHandler(notifier),
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const client = new Client({ name: 'test', version: '1' });
  try {
    const response = await fetch(`${base}/notify`, {
      method: 'POST',
      headers: { Authorization: 'Bearer secret', 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 't', message: 'm' }),
    });
    expect(response.status).toBe(200);
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
        requestInit: { headers: { Authorization: 'Bearer secret' } },
      }),
    );
    const result = await client.callTool({
      name: 'notify-paul',
      arguments: { title: 't', message: 'm' },
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({ error: 'rate_limited' });
    vi.spyOn(notifier, 'notify').mockRejectedValueOnce(new Error('private-provider-token'));
    const failure = await client.callTool({
      name: 'notify-paul',
      arguments: { title: 't', message: 'm' },
    });
    expect(failure.isError).toBe(true);
    expect(JSON.stringify(failure)).not.toContain('private-provider-token');
    expect(JSON.stringify(failure)).toContain('internal_error');
    for (const status of ['sent', 'partial', 'failed', 'muted'] as const) {
      vi.spyOn(notifier, 'notify').mockResolvedValueOnce({
        ok: true,
        result: { id: 'id', status },
      });
      const outcome = await client.callTool({
        name: 'notify-paul',
        arguments: { title: 't', message: 'm' },
      });
      expect(outcome.isError).toBe(status === 'failed');
      expect(outcome.structuredContent).toEqual({ id: 'id', status });
    }
  } finally {
    await client.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    vi.restoreAllMocks();
  }
});
