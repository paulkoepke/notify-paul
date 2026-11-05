import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { CHANNEL_NAMES, type ChannelName } from './core/types.js';

export const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export interface TelegramConfig {
  botToken: string;
  chatId: string;
}

export interface EmailConfig {
  host: string;
  port: number;
  secure: boolean;
  auth?: { user: string; password: string };
  from: string;
  to: string;
}

export interface DiscordConfig {
  webhookUrl: string;
}

export interface NtfyConfig {
  serverUrl: string;
  topic: string;
  token?: string;
}

export type ConsoleConfig = Record<string, never>;

export interface ChannelConfigs {
  telegram: TelegramConfig;
  email: EmailConfig;
  discord: DiscordConfig;
  ntfy: NtfyConfig;
  console: ConsoleConfig;
}

export interface Config {
  host: string;
  port: number;
  apiToken: string;
  rateLimitPerMinute: number;
  logLevel: LogLevel;
  logFile?: string;
  trayEnabled: boolean;
  /** Where the user's channel selection is stored (absolute unless configured otherwise). */
  settingsFile: string;
  /** Only enabled (= available) channels are present. */
  channels: Partial<ChannelConfigs>;
  enabledChannels: ChannelName[];
}

export interface LoadedConfig {
  config: Config;
  warnings: string[];
}

export class ConfigError extends Error {
  constructor(readonly issues: string[]) {
    super(`Invalid configuration:\n${issues.map((i) => `  - ${i}`).join('\n')}`);
    this.name = 'ConfigError';
  }
}

type Env = Record<string, string | undefined>;

const TOKEN_PLACEHOLDER = 'replace_with_a_long_random_secret';

/** Routing variables from before the tray selection; still accepted but ignored with a warning. */
const REMOVED_VARS = ['DEFAULT_CHANNELS', 'URGENT_CHANNELS', 'LOW_PRIORITY_CHANNELS'] as const;

// Error messages never echo the input value: it may be a secret.
const required = {
  error: (issue: { input?: unknown }) => (issue.input === undefined ? 'is required' : undefined),
};

const flag = z.stringbool({ error: 'must be true or false' }).default(false);
const port = z.coerce
  .number({ error: 'must be a number' })
  .int()
  .min(1)
  .max(65535, 'must be between 1 and 65535');

const baseSchema = z.object({
  HOST: z.string().default('127.0.0.1'),
  PORT: port.default(3847),
  HTTP_API_TOKEN: z
    .string(required)
    .min(32, 'must be at least 32 characters long')
    .refine((v) => v !== TOKEN_PLACEHOLDER, 'is still the placeholder from .env.example'),
  RATE_LIMIT_PER_MINUTE: z.coerce
    .number({ error: 'must be a number' })
    .int()
    .min(1, 'must be at least 1')
    .default(10),
  LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
  LOG_FILE: z.string().optional(),
  TRAY_ENABLED: z.stringbool({ error: 'must be true or false' }).default(true),
  SETTINGS_FILE: z.string().optional(),
  TELEGRAM_ENABLED: flag,
  EMAIL_ENABLED: flag,
  DISCORD_ENABLED: flag,
  NTFY_ENABLED: flag,
  CONSOLE_ENABLED: flag,
});

const telegramSchema = z
  .object({
    TELEGRAM_BOT_TOKEN: z
      .string(required)
      .regex(/^\d+:[A-Za-z0-9_-]+$/, 'does not look like a bot token ("<id>:<secret>")'),
    TELEGRAM_CHAT_ID: z
      .string(required)
      .regex(/^(-?\d+|@[A-Za-z0-9_]{5,})$/, 'must be a numeric chat ID or @channelname'),
  })
  .transform((e): TelegramConfig => ({
    botToken: e.TELEGRAM_BOT_TOKEN,
    chatId: e.TELEGRAM_CHAT_ID,
  }));

const emailSchema = z
  .object({
    SMTP_HOST: z.string(required),
    SMTP_PORT: port.default(587),
    SMTP_SECURE: flag,
    SMTP_USER: z.string().optional(),
    SMTP_PASSWORD: z.string().optional(),
    EMAIL_FROM: z.email(required),
    EMAIL_TO: z.email(required),
  })
  .superRefine((e, ctx) => {
    if ((e.SMTP_USER === undefined) !== (e.SMTP_PASSWORD === undefined)) {
      ctx.addIssue({
        code: 'custom',
        path: [e.SMTP_USER === undefined ? 'SMTP_USER' : 'SMTP_PASSWORD'],
        message: 'SMTP_USER and SMTP_PASSWORD must be set together',
      });
    }
  })
  .transform((e): EmailConfig => ({
    host: e.SMTP_HOST,
    port: e.SMTP_PORT,
    secure: e.SMTP_SECURE,
    ...(e.SMTP_USER !== undefined && e.SMTP_PASSWORD !== undefined
      ? { auth: { user: e.SMTP_USER, password: e.SMTP_PASSWORD } }
      : {}),
    from: e.EMAIL_FROM,
    to: e.EMAIL_TO,
  }));

const DISCORD_HOSTS = /^(discord\.com|discordapp\.com|ptb\.discord\.com|canary\.discord\.com)$/;

const discordSchema = z
  .object({
    DISCORD_WEBHOOK_URL: z
      .url({
        protocol: /^https$/,
        hostname: DISCORD_HOSTS,
        error: (issue) =>
          issue.input === undefined ? 'is required' : 'must be an https://discord.com webhook URL',
      })
      .refine(
        (v) => new URL(v).pathname.startsWith('/api/webhooks/'),
        'must be a Discord webhook URL (…/api/webhooks/…)',
      ),
  })
  .transform((e): DiscordConfig => ({ webhookUrl: e.DISCORD_WEBHOOK_URL }));

const ntfySchema = z
  .object({
    NTFY_SERVER_URL: z
      .url({ protocol: /^https?$/, error: 'must be an http(s) URL' })
      .default('https://ntfy.sh'),
    NTFY_TOPIC: z
      .string(required)
      .regex(/^[A-Za-z0-9_-]{1,64}$/, 'may only contain letters, digits, _ and - (max. 64)'),
    NTFY_TOKEN: z.string().optional(),
  })
  .transform((e): NtfyConfig => ({
    serverUrl: e.NTFY_SERVER_URL.replace(/\/+$/, ''),
    topic: e.NTFY_TOPIC,
    ...(e.NTFY_TOKEN !== undefined ? { token: e.NTFY_TOKEN } : {}),
  }));

const consoleSchema = z.object({}).transform((): ConsoleConfig => ({}));

const channelSchemas: { [K in ChannelName]: z.ZodType<ChannelConfigs[K]> } = {
  telegram: telegramSchema,
  email: emailSchema,
  discord: discordSchema,
  ntfy: ntfySchema,
  console: consoleSchema,
};

const ENABLED_FLAGS = {
  telegram: 'TELEGRAM_ENABLED',
  email: 'EMAIL_ENABLED',
  discord: 'DISCORD_ENABLED',
  ntfy: 'NTFY_ENABLED',
  console: 'CONSOLE_ENABLED',
} as const satisfies Record<ChannelName, keyof z.output<typeof baseSchema>>;

/**
 * Validates environment variables into a typed config. Channel settings are only checked for
 * enabled channels. Collects all problems and throws a single {@link ConfigError}.
 */
export function parseConfig(rawEnv: Env): LoadedConfig {
  // `KEY=` in .env yields an empty string; treat it as unset so defaults apply.
  const env: Env = Object.fromEntries(
    Object.entries(rawEnv).filter(([, v]) => v !== undefined && v.trim() !== ''),
  );

  const issues: string[] = [];
  const base = baseSchema.safeParse(env);
  if (!base.success) issues.push(...base.error.issues.map((i) => formatIssue(i)));

  const channels: Partial<ChannelConfigs> = {};
  const enabledChannels: ChannelName[] = [];
  for (const name of CHANNEL_NAMES) {
    const flagName = ENABLED_FLAGS[name];
    // Fall back to the raw value so channel checks still run when unrelated base vars are invalid.
    const enabled = base.success
      ? base.data[flagName]
      : z.stringbool().safeParse(env[flagName]).data === true;
    if (!enabled) continue;

    const parsed = channelSchemas[name].safeParse(env);
    if (parsed.success) {
      (channels as Record<ChannelName, unknown>)[name] = parsed.data;
      enabledChannels.push(name);
    } else {
      issues.push(...parsed.error.issues.map((i) => formatIssue(i, `${flagName}=true`)));
    }
  }

  if (!base.success || issues.length > 0) throw new ConfigError(issues);
  const b = base.data;

  const config: Config = {
    host: b.HOST,
    port: b.PORT,
    apiToken: b.HTTP_API_TOKEN,
    rateLimitPerMinute: b.RATE_LIMIT_PER_MINUTE,
    logLevel: b.LOG_LEVEL,
    ...(b.LOG_FILE !== undefined ? { logFile: b.LOG_FILE } : {}),
    trayEnabled: b.TRAY_ENABLED,
    settingsFile: b.SETTINGS_FILE ?? defaultSettingsFile(env),
    channels,
    enabledChannels,
  };

  const warnings = REMOVED_VARS.filter((name) => env[name] !== undefined).map(
    (name) => `${name} is no longer supported and is ignored; channels are selected in the tray.`,
  );
  return { config, warnings: [...warnings, ...collectWarnings(config)] };
}

/** `%APPDATA%\NotifyPaul\settings.json`, falling back to the roaming profile path. */
function defaultSettingsFile(env: Env): string {
  const appData = env.APPDATA ?? join(homedir(), 'AppData', 'Roaming');
  return join(appData, 'NotifyPaul', 'settings.json');
}

function collectWarnings(config: Config): string[] {
  const warnings: string[] = [];

  if (config.enabledChannels.length === 0) {
    warnings.push('No channel is enabled; notifications cannot be delivered.');
  }

  if (!isLoopback(config.host)) {
    warnings.push(
      `HOST=${config.host} is not a loopback address; the service is reachable from the network.`,
    );
  }

  const email = config.channels.email;
  if (email && email.port === 465 && !email.secure) {
    warnings.push('SMTP_PORT=465 usually requires SMTP_SECURE=true (implicit TLS).');
  }
  if (email && email.port === 587 && email.secure) {
    warnings.push('SMTP_PORT=587 usually requires SMTP_SECURE=false (STARTTLS).');
  }

  return warnings;
}

function isLoopback(host: string): boolean {
  return host === 'localhost' || host === '::1' || /^127\.\d+\.\d+\.\d+$/.test(host);
}

function formatIssue(issue: z.core.$ZodIssue, context?: string): string {
  const key = issue.path.length > 0 ? issue.path.join('.') : 'environment';
  return context ? `${key}: ${issue.message} (${context})` : `${key}: ${issue.message}`;
}

/** Loads `.env` into `process.env` if present. Existing variables are not overridden. */
export function loadEnvFile(path = '.env'): boolean {
  try {
    process.loadEnvFile(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

/** Reads `.env` (optional) and validates `process.env`. */
export function loadConfig(envFile = '.env'): LoadedConfig {
  loadEnvFile(envFile);
  return parseConfig(process.env);
}
