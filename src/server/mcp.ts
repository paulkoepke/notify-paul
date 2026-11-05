import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { notificationInputSchema } from '../core/schema.js';
import type { Notifier } from '../core/notifier.js';
import type { McpHandler } from './http.js';

export function createMcpHandler(notifier: Pick<Notifier, 'notify'>): McpHandler {
  return async (req, res, body) => {
    if (req.method !== 'POST') {
      res.writeHead(405, { Allow: 'POST' }).end();
      return;
    }
    const server = new McpServer({ name: 'notify-paul', version: '0.1.0' });
    server.registerTool(
      'notify-paul',
      {
        description:
          'NotifyPaul: notify the user only when attention is useful: a completed task, an error, or a question. The user chooses delivery channels. Never supply channels, recipients or destination URLs.',
        inputSchema: notificationInputSchema,
      },
      async (input) => {
        try {
          const outcome = await notifier.notify(input);
          const result = outcome.ok ? { ...outcome.result } : { error: outcome.error };
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(result) }],
            structuredContent: result,
            isError: !outcome.ok || outcome.result.status === 'failed',
          };
        } catch {
          return {
            content: [{ type: 'text' as const, text: '{"error":"internal_error"}' }],
            isError: true,
          };
        }
      },
    );
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.once('close', () => {
      void server.close().catch(() => undefined);
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch {
      await server.close();
      throw new Error('MCP request failed');
    }
  };
}
