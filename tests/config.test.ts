import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, parseConfig } from '../src/config.js';

const TOKEN = 'a'.repeat(40);
const TELEGRAM_TOKEN = '123456:ABC-def_ghi';
const WEBHOOK = 'https://discord.com/api/webhooks/123/secret-part';

function expectConfigError(env: Record<string, string>): string[] {
  try {
    parseConfig(env);
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    return (error as ConfigError).issues;
  }
  throw new Error('expected parseConfig to throw');
}

describe('parseConfig', () => {
  it('applies defaults for a minimal configuration', () => {
    const { config } = parseConfig({ HTTP_API_TOKEN: TOKEN });

    expect(config).toMatchObject({
      host: '127.0.0.1',
      port: 3847,
      apiToken: TOKEN,
      rateLimitPerMinute: 10,
      logLevel: 'info',
      trayEnabled: true,
      channels: {},
      enabledChannels: [],
    });
    expect(config.logFile).toBeUndefined();
    expect(config.settingsFile).toMatch(/[\\/]NotifyPaul[\\/]settings\.json$/);
  });

  it('defaults the settings file to %APPDATA%\\NotifyPaul\\settings.json', () => {
    const appData = 'C:\\Users\\me\\AppData\\Roaming';
    const { config } = parseConfig({ HTTP_API_TOKEN: TOKEN, APPDATA: appData });
    expect(config.settingsFile).toBe(join(appData, 'NotifyPaul', 'settings.json'));
  });

  it('parses a full valid configuration', () => {
    const { config, warnings } = parseConfig({
      HOST: '127.0.0.1',
      PORT: '4000',
      HTTP_API_TOKEN: TOKEN,
      RATE_LIMIT_PER_MINUTE: '5',
      LOG_LEVEL: 'debug',
      LOG_FILE: 'logs/notify-paul.log',
      TRAY_ENABLED: 'false',
      SETTINGS_FILE: 'D:\\data\\settings.json',
      TELEGRAM_ENABLED: 'true',
      TELEGRAM_BOT_TOKEN: TELEGRAM_TOKEN,
      TELEGRAM_CHAT_ID: '-100123',
      EMAIL_ENABLED: 'true',
      SMTP_HOST: 'smtp.example.com',
      SMTP_PORT: '465',
      SMTP_SECURE: 'true',
      SMTP_USER: 'user',
      SMTP_PASSWORD: 'pw',
      EMAIL_FROM: 'bot@example.com',
      EMAIL_TO: 'me@example.com',
      DISCORD_ENABLED: 'true',
      DISCORD_WEBHOOK_URL: WEBHOOK,
      NTFY_ENABLED: 'true',
      NTFY_SERVER_URL: 'https://ntfy.example.com/',
      NTFY_TOPIC: 'my-topic',
      NTFY_TOKEN: 'tk_x',
    });

    expect(warnings).toEqual([]);
    expect(config.port).toBe(4000);
    expect(config.rateLimitPerMinute).toBe(5);
    expect(config.logLevel).toBe('debug');
    expect(config.logFile).toBe('logs/notify-paul.log');
    expect(config.trayEnabled).toBe(false);
    expect(config.settingsFile).toBe('D:\\data\\settings.json');
    expect(config.enabledChannels).toEqual(['telegram', 'email', 'discord', 'ntfy']);
    expect(config.channels).toEqual({
      telegram: { botToken: TELEGRAM_TOKEN, chatId: '-100123' },
      email: {
        host: 'smtp.example.com',
        port: 465,
        secure: true,
        auth: { user: 'user', password: 'pw' },
        from: 'bot@example.com',
        to: 'me@example.com',
      },
      discord: { webhookUrl: WEBHOOK },
      ntfy: { serverUrl: 'https://ntfy.example.com', topic: 'my-topic', token: 'tk_x' },
    });
  });

  it('treats empty values as unset', () => {
    const { config } = parseConfig({
      HTTP_API_TOKEN: TOKEN,
      PORT: '',
      TRAY_ENABLED: '',
      SETTINGS_FILE: '',
      EMAIL_ENABLED: '',
      SMTP_HOST: '',
    });
    expect(config.port).toBe(3847);
    expect(config.trayEnabled).toBe(true);
    expect(config.settingsFile).toMatch(/settings\.json$/);
    expect(config.enabledChannels).toEqual([]);
  });

  it('does not validate settings of disabled channels', () => {
    const { config } = parseConfig({
      HTTP_API_TOKEN: TOKEN,
      TELEGRAM_ENABLED: 'false',
      TELEGRAM_BOT_TOKEN: 'garbage',
      EMAIL_ENABLED: 'false',
      SMTP_PORT: 'not-a-number',
      DISCORD_ENABLED: 'false',
      DISCORD_WEBHOOK_URL: 'http://evil.example.com',
      NTFY_ENABLED: 'false',
      NTFY_TOPIC: 'bad topic!',
      CONSOLE_ENABLED: 'true',
    });
    expect(config.enabledChannels).toEqual(['console']);
    expect(config.channels).toEqual({ console: {} });
  });

  it('warns when no channel is enabled', () => {
    const { warnings } = parseConfig({ HTTP_API_TOKEN: TOKEN });
    expect(warnings).toContain('No channel is enabled; notifications cannot be delivered.');
  });

  it('ignores the removed routing variables with a warning', () => {
    const { config, warnings } = parseConfig({
      HTTP_API_TOKEN: TOKEN,
      CONSOLE_ENABLED: 'true',
      DEFAULT_CHANNELS: 'console',
      URGENT_CHANNELS: 'sms',
    });
    expect(config).not.toHaveProperty('routing');
    expect(warnings).toEqual([
      'DEFAULT_CHANNELS is no longer supported and is ignored; channels are selected in the tray.',
      'URGENT_CHANNELS is no longer supported and is ignored; channels are selected in the tray.',
    ]);
  });

  it('warns about a non-loopback HOST and SMTP port/TLS mismatches', () => {
    const { warnings } = parseConfig({
      HOST: '0.0.0.0',
      HTTP_API_TOKEN: TOKEN,
      EMAIL_ENABLED: 'true',
      SMTP_HOST: 'smtp.example.com',
      SMTP_PORT: '465',
      EMAIL_FROM: 'bot@example.com',
      EMAIL_TO: 'me@example.com',
    });
    expect(warnings).toEqual([
      'HOST=0.0.0.0 is not a loopback address; the service is reachable from the network.',
      'SMTP_PORT=465 usually requires SMTP_SECURE=true (implicit TLS).',
    ]);
  });

  it('requires HTTP_API_TOKEN and rejects weak or placeholder tokens', () => {
    expect(expectConfigError({})).toEqual(['HTTP_API_TOKEN: is required']);
    expect(expectConfigError({ HTTP_API_TOKEN: 'short' })).toEqual([
      'HTTP_API_TOKEN: must be at least 32 characters long',
    ]);
    expect(expectConfigError({ HTTP_API_TOKEN: 'replace_with_a_long_random_secret' })).toEqual([
      'HTTP_API_TOKEN: is still the placeholder from .env.example',
    ]);
  });

  it('rejects invalid base values', () => {
    const issues = expectConfigError({
      HTTP_API_TOKEN: TOKEN,
      PORT: '70000',
      RATE_LIMIT_PER_MINUTE: '0',
      LOG_LEVEL: 'verbose',
      TELEGRAM_ENABLED: 'maybe',
      TRAY_ENABLED: 'yes please',
    });
    expect(issues).toHaveLength(5);
    expect(issues).toContain('PORT: must be between 1 and 65535');
    expect(issues).toContain('RATE_LIMIT_PER_MINUTE: must be at least 1');
    expect(issues).toContain('TELEGRAM_ENABLED: must be true or false');
    expect(issues.some((i) => i.startsWith('LOG_LEVEL:'))).toBe(true);
    expect(issues).toContain('TRAY_ENABLED: must be true or false');
  });

  it('reports missing values of enabled channels with the enabling flag', () => {
    const issues = expectConfigError({
      HTTP_API_TOKEN: TOKEN,
      TELEGRAM_ENABLED: 'true',
      EMAIL_ENABLED: 'true',
      DISCORD_ENABLED: 'true',
      NTFY_ENABLED: 'true',
    });
    expect(issues).toEqual([
      'TELEGRAM_BOT_TOKEN: is required (TELEGRAM_ENABLED=true)',
      'TELEGRAM_CHAT_ID: is required (TELEGRAM_ENABLED=true)',
      'SMTP_HOST: is required (EMAIL_ENABLED=true)',
      'EMAIL_FROM: is required (EMAIL_ENABLED=true)',
      'EMAIL_TO: is required (EMAIL_ENABLED=true)',
      'DISCORD_WEBHOOK_URL: is required (DISCORD_ENABLED=true)',
      'NTFY_TOPIC: is required (NTFY_ENABLED=true)',
    ]);
  });

  it('collects channel issues even when base values are invalid', () => {
    const issues = expectConfigError({ TELEGRAM_ENABLED: 'true' });
    expect(issues).toContain('HTTP_API_TOKEN: is required');
    expect(issues).toContain('TELEGRAM_BOT_TOKEN: is required (TELEGRAM_ENABLED=true)');
  });

  it('rejects malformed channel values', () => {
    const issues = expectConfigError({
      HTTP_API_TOKEN: TOKEN,
      TELEGRAM_ENABLED: 'true',
      TELEGRAM_BOT_TOKEN: 'not-a-token',
      TELEGRAM_CHAT_ID: 'abc',
      EMAIL_ENABLED: 'true',
      SMTP_HOST: 'smtp.example.com',
      SMTP_USER: 'user',
      EMAIL_FROM: 'nope',
      EMAIL_TO: 'me@example.com',
      DISCORD_ENABLED: 'true',
      DISCORD_WEBHOOK_URL: 'https://evil.example.com/api/webhooks/1/x',
      NTFY_ENABLED: 'true',
      NTFY_SERVER_URL: 'ftp://ntfy.example.com',
      NTFY_TOPIC: 'bad topic',
    });
    const keys = issues.map((i) => i.split(':')[0]);
    expect(keys).toEqual([
      'TELEGRAM_BOT_TOKEN',
      'TELEGRAM_CHAT_ID',
      'EMAIL_FROM',
      'SMTP_PASSWORD',
      'DISCORD_WEBHOOK_URL',
      'NTFY_SERVER_URL',
      'NTFY_TOPIC',
    ]);
  });

  it('rejects Discord URLs that are not webhook URLs', () => {
    const issues = expectConfigError({
      HTTP_API_TOKEN: TOKEN,
      DISCORD_ENABLED: 'true',
      DISCORD_WEBHOOK_URL: 'https://discord.com/channels/1/2',
    });
    expect(issues).toEqual([
      'DISCORD_WEBHOOK_URL: must be a Discord webhook URL (…/api/webhooks/…) (DISCORD_ENABLED=true)',
    ]);
  });

  it('never echoes secret values in error messages', () => {
    const secrets = {
      HTTP_API_TOKEN: 'tooshort-secret',
      TELEGRAM_ENABLED: 'true',
      TELEGRAM_BOT_TOKEN: 'leaky-bot-secret',
      TELEGRAM_CHAT_ID: '1',
      DISCORD_ENABLED: 'true',
      DISCORD_WEBHOOK_URL: 'https://evil.example.com/leaky-webhook-secret',
    };
    let message = '';
    try {
      parseConfig(secrets);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('Invalid configuration');
    expect(message).not.toContain('tooshort-secret');
    expect(message).not.toContain('leaky-bot-secret');
    expect(message).not.toContain('leaky-webhook-secret');
  });
});
