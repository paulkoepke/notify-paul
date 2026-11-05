import { createHash, timingSafeEqual } from 'node:crypto';
import {
  createServer,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Notifier } from '../core/notifier.js';
import { parseNotificationInput } from '../core/schema.js';
import type { Logger } from '../logger.js';

/** Identifies this service on `/health`; the single-instance check relies on it. */
export const SERVICE_NAME = 'notify-paul';

/** Generous for 4000 characters of message even with JSON `\uXXXX` escapes. */
export const DEFAULT_MAX_BODY_BYTES = 64 * 1024;

export type HttpErrorCode =
  | 'not_found'
  | 'method_not_allowed'
  | 'forbidden_host'
  | 'forbidden_origin'
  | 'unauthorized'
  | 'unsupported_media_type'
  | 'payload_too_large'
  | 'invalid_json'
  | 'invalid_input'
  | 'rate_limited'
  | 'internal_error';

const ERRORS: Record<HttpErrorCode, { status: number; message: string }> = {
  not_found: { status: 404, message: 'Not found.' },
  method_not_allowed: { status: 405, message: 'Method not allowed.' },
  forbidden_host: { status: 403, message: 'Host not allowed.' },
  forbidden_origin: { status: 403, message: 'Origin not allowed.' },
  unauthorized: { status: 401, message: 'Missing or invalid bearer token.' },
  unsupported_media_type: { status: 415, message: 'Content-Type must be application/json.' },
  payload_too_large: { status: 413, message: 'Request body too large.' },
  invalid_json: { status: 400, message: 'Request body is not valid JSON.' },
  invalid_input: { status: 400, message: 'Invalid notification.' },
  rate_limited: { status: 429, message: 'Too many notifications; try again later.' },
  internal_error: { status: 500, message: 'Internal error.' },
};

/**
 * Handles an authenticated `/mcp` request (wired up in step 5). `body` is the parsed JSON for
 * POST requests and `undefined` otherwise.
 */
export type McpHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  body: unknown,
) => Promise<void>;

export interface HttpServerOptions {
  /** Bind address; requests addressed to it by name are accepted in addition to loopback names. */
  host: string;
  apiToken: string;
  notifier: Pick<Notifier, 'notify'>;
  logger: Logger;
  mcpHandler?: McpHandler;
  maxBodyBytes?: number;
}

const ROUTES: Record<string, readonly string[]> = {
  '/health': ['GET'],
  '/notify': ['POST'],
  '/mcp': ['GET', 'POST', 'DELETE'],
};

class HttpError extends Error {
  constructor(
    readonly code: HttpErrorCode,
    readonly details?: string[],
  ) {
    super(code);
  }
}

/**
 * HTTP server for `/health`, `POST /notify` and `/mcp`. Every request must address a local host
 * name (DNS-rebinding protection) and come without or from a local Origin; `/notify` and `/mcp`
 * additionally require the bearer token.
 */
export function createHttpServer(options: HttpServerOptions): Server {
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const tokenDigest = digest(options.apiToken);

  const server = createServer((req, res) => {
    void handle(req, res).catch((error: unknown) => {
      if (error instanceof HttpError) {
        if (error.code !== 'not_found') {
          options.logger.warn(
            { method: req.method, path: safeLogPath(req), code: error.code },
            'HTTP request rejected.',
          );
        }
        sendError(res, error);
        return;
      }
      // The error may carry request data; only its type is logged.
      options.logger.error(
        { method: req.method, path: safeLogPath(req), code: 'internal_error' },
        'HTTP request failed.',
      );
      sendError(res, new HttpError('internal_error'));
    });
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 30_000;

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const port = (server.address() as AddressInfo).port;
    const allowedHosts = localHosts(options.host, port);
    if (!allowedHosts.has((req.headers.host ?? '').toLowerCase())) {
      throw new HttpError('forbidden_host');
    }

    const path = pathOf(req);
    const methods = ROUTES[path];
    if (methods === undefined) throw new HttpError('not_found');
    if (!methods.includes(req.method ?? '')) {
      res.setHeader('Allow', methods.join(', '));
      throw new HttpError('method_not_allowed');
    }

    if (!isAllowedOrigin(req.headers.origin, allowedHosts)) throw new HttpError('forbidden_origin');

    if (path === '/health') {
      sendJson(res, 200, { status: 'ok', service: SERVICE_NAME });
      return;
    }

    if (!isAuthorized(req.headers.authorization, tokenDigest)) {
      res.setHeader('WWW-Authenticate', 'Bearer');
      throw new HttpError('unauthorized');
    }

    if (path === '/notify') {
      await handleNotify(req, res);
      return;
    }

    if (options.mcpHandler === undefined) throw new HttpError('not_found');
    const body = req.method === 'POST' ? await readJson(req, maxBodyBytes) : undefined;
    await options.mcpHandler(req, res, body);
  }

  async function handleNotify(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const parsed = parseNotificationInput(await readJson(req, maxBodyBytes));
    if (!parsed.ok) throw new HttpError('invalid_input', parsed.issues);

    const outcome = await options.notifier.notify(parsed.value);
    if (!outcome.ok) throw new HttpError(outcome.error);
    sendJson(res, 200, outcome.result);
  }

  return server;
}

/** Host header values that address this service: loopback names plus the bind address. */
function localHosts(bindHost: string, port: number): Set<string> {
  const names = ['127.0.0.1', 'localhost', '[::1]'];
  const host = bindHost.toLowerCase();
  if (host !== '0.0.0.0' && host !== '::') names.push(host.includes(':') ? `[${host}]` : host);
  return new Set(names.map((name) => `${name}:${port}`));
}

/** Requests without Origin (CLI tools, agents) are fine; browsers must come from a local page. */
function isAllowedOrigin(origin: string | undefined, allowedHosts: Set<string>): boolean {
  if (origin === undefined) return true;
  try {
    const url = new URL(origin);
    return url.protocol === 'http:' && allowedHosts.has(url.host);
  } catch {
    return false;
  }
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

/** Compares digests so neither content nor length of the token leaks through timing. */
function isAuthorized(header: string | undefined, tokenDigest: Buffer): boolean {
  const match = /^Bearer[ \t]+(\S+)[ \t]*$/i.exec(header ?? '');
  if (!match) return false;
  return timingSafeEqual(digest(match[1]!), tokenDigest);
}

function isJsonContentType(header: string | undefined): boolean {
  if (header === undefined) return false;
  const [type, ...params] = header.split(';').map((part) => part.trim().toLowerCase());
  if (type !== 'application/json') return false;
  return params.every((p) => !p.startsWith('charset=') || /^charset="?utf-8"?$/.test(p));
}

async function readJson(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  if (!isJsonContentType(req.headers['content-type']))
    throw new HttpError('unsupported_media_type');

  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > maxBytes) throw new HttpError('payload_too_large');

  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > maxBytes) throw new HttpError('payload_too_large');
    chunks.push(chunk);
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new HttpError('invalid_json');
  }
}

const BASE_HEADERS: OutgoingHttpHeaders = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
};

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, BASE_HEADERS).end(JSON.stringify(body));
}

/** Uniform error body `{ error: { code, message, details? } }`; never stack traces or secrets. */
function sendError(res: ServerResponse, error: HttpError): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  const { status, message } = ERRORS[error.code];
  // Unread request bodies (rejected early) would otherwise keep the connection busy.
  if (!res.req.complete) res.setHeader('Connection', 'close');
  sendJson(res, status, {
    error: {
      code: error.code,
      message,
      ...(error.details !== undefined ? { details: error.details } : {}),
    },
  });
}

function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://localhost').pathname;
  } catch {
    return '/';
  }
}

function safeLogPath(req: IncomingMessage): string {
  const path = pathOf(req);
  return Object.hasOwn(ROUTES, path) ? path : 'unknown';
}
