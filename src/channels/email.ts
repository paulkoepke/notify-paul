import nodemailer from 'nodemailer';
import { connect, type Socket } from 'node:net';
import { connect as connectTls } from 'node:tls';
import type { EmailConfig } from '../config.js';
import type { Notification } from '../core/types.js';
import type { NotificationChannel, SendOutcome } from './channel.js';

export class EmailChannel implements NotificationChannel {
  readonly name = 'email' as const;
  constructor(private readonly config: EmailConfig) {}
  async send(n: Notification, signal: AbortSignal): Promise<SendOutcome> {
    if (signal.aborted) return { ok: false, error: 'provider_timeout' };
    // A separate connection per attempt lets cancellation stop exactly this delivery.
    const config = this.config;
    let socket: Socket | undefined;
    const transport = nodemailer.createTransport({
      host: config.host,
      port: config.port,
      secure: config.secure,
      ...(config.auth ? { auth: { user: config.auth.user, pass: config.auth.password } } : {}),
      requireTLS: !config.secure,
      connectionTimeout: 5000,
      greetingTimeout: 5000,
      socketTimeout: 5000,
      dnsTimeout: 5000,
      disableFileAccess: true,
      disableUrlAccess: true,
      logger: false,
      debug: false,
      getSocket(_options, callback) {
        if (signal.aborted) {
          callback(new Error('Cancelled'), false);
          return;
        }
        const options = { host: config.host, port: config.port };
        socket = config.secure
          ? connectTls({ ...options, servername: config.host })
          : connect(options);
        let called = false;
        const done = (error?: Error) => {
          if (called) return;
          called = true;
          callback(error ?? null, error ? false : { connection: socket, secured: config.secure });
        };
        socket.once('error', done);
        socket.once(config.secure ? 'secureConnect' : 'connect', () => done());
        socket.setTimeout(5000, () => socket?.destroy(new Error('Connection timeout')));
      },
    });
    let abort: () => void = () => undefined;
    const cancelled = new Promise<SendOutcome>((resolve) => {
      abort = () => {
        socket?.destroy();
        resolve({ ok: false, error: 'provider_timeout' });
      };
      signal.addEventListener('abort', abort, { once: true });
    });
    const delivery = transport
      .sendMail({
        from: this.config.from,
        to: this.config.to,
        subject: `${n.title}${n.source ? ` [${n.source}]` : ''}`,
        text: n.message,
        priority: n.priority === 'urgent' ? 'high' : n.priority,
      })
      .then((info): SendOutcome =>
        info.accepted.length > 0 ? { ok: true } : { ok: false, error: 'provider_rejected' },
      )
      .catch((error: unknown): SendOutcome => {
        const e = error as { code?: string; responseCode?: number };
        return {
          ok: false,
          error:
            e.code === 'EAUTH'
              ? 'provider_auth_failed'
              : e.code === 'ETIMEDOUT'
                ? 'provider_timeout'
                : e.responseCode && e.responseCode >= 400 && e.responseCode < 500
                  ? 'provider_error'
                  : e.responseCode
                    ? 'provider_rejected'
                    : 'provider_unreachable',
        };
      });
    try {
      return await Promise.race([delivery, cancelled]);
    } finally {
      signal.removeEventListener('abort', abort);
      socket?.destroy();
      transport.close();
    }
  }
}
