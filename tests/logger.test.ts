import { describe, expect, it } from 'vitest';
import { createLogger, REDACTED } from '../src/logger.js';

function capture() {
  const lines: Record<string, unknown>[] = [];
  const stream = { write: (line: string) => void lines.push(JSON.parse(line)) };
  return { lines, logger: createLogger('info', stream) };
}

describe('createLogger', () => {
  it('redacts secrets at the top level and in nested objects', () => {
    const { lines, logger } = capture();
    logger.info(
      {
        token: 's1',
        config: {
          apiToken: 's2',
          channels: { telegram: { botToken: 's3' }, email: { auth: { password: 's4' } } },
        },
        req: { headers: { authorization: 'Bearer s5', host: '127.0.0.1:3847' } },
        DISCORD_WEBHOOK_URL: 's6',
      },
      'startup',
    );

    const raw = JSON.stringify(lines[0]);
    for (const secret of ['s1', 's2', 's3', 's4', 's5', 's6']) {
      expect(raw).not.toContain(`"${secret}"`);
    }
    expect(raw).not.toContain('Bearer');
    expect(lines[0]).toMatchObject({
      msg: 'startup',
      token: REDACTED,
      req: { headers: { authorization: REDACTED, host: '127.0.0.1:3847' } },
    });
  });

  it('redacts notification content but keeps metadata and error messages', () => {
    const { lines, logger } = capture();
    logger.info({
      notification: { title: 'secret title', message: 'secret body', priority: 'urgent' },
      channel: 'telegram',
      status: 'failed',
      err: new Error('provider_timeout'),
    });

    expect(lines[0]).toMatchObject({
      notification: { title: REDACTED, message: REDACTED, priority: 'urgent' },
      channel: 'telegram',
      status: 'failed',
      err: { message: 'provider_timeout' },
    });
  });

  it('respects the configured level', () => {
    const lines: string[] = [];
    const logger = createLogger('warn', { write: (line: string) => void lines.push(line) });
    logger.info('hidden');
    logger.warn('shown');
    expect(lines).toHaveLength(1);
  });
});
