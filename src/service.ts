import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { NotificationChannel } from './channels/channel.js';
import { createMcpHandler } from './server/mcp.js';
import { TelegramChannel } from './channels/telegram.js';
import { ConsoleChannel } from './channels/console.js';
import { DiscordChannel } from './channels/discord.js';
import { NtfyChannel } from './channels/ntfy.js';
import { EmailChannel } from './channels/email.js';
import { nativeExecutable } from './paths.js';
import { RegistryAutostart } from './tray/autostart.js';
import { TrayController, type TrayView } from './tray/controller.js';
import { startTrayProcess } from './tray/process.js';
import type { Config } from './config.js';
import { Notifier } from './core/notifier.js';
import { SettingsStore } from './core/settings.js';
import type { Logger } from './logger.js';
import { createHttpServer } from './server/http.js';

/** Open connections get this long to finish before they are closed forcibly. */
const SHUTDOWN_GRACE_MS = 5_000;

export interface RunningService {
  /** Actual port (differs from the config when it was 0). */
  port: number;
  settings: SettingsStore;
  /** Stops accepting requests and closes the server. Safe to call more than once. */
  stop(): Promise<void>;
}

/** Thrown when the configured port is taken; the message is meant for the user. */
export class PortInUseError extends Error {
  constructor(
    readonly host: string,
    readonly port: number,
  ) {
    super(
      `Port ${port} on ${host} is already in use. Is NotifyPaul already running, ` +
        'or does another program use this port? Change PORT in .env if needed.',
    );
    this.name = 'PortInUseError';
  }
}

/** Builds adapters for all available channels. */
export function createChannels(config: Config, logger: Logger): NotificationChannel[] {
  const channels: NotificationChannel[] = [];
  for (const name of config.enabledChannels) {
    switch (name) {
      case 'discord':
        if (config.channels.discord) channels.push(new DiscordChannel(config.channels.discord));
        break;
      case 'ntfy':
        if (config.channels.ntfy) channels.push(new NtfyChannel(config.channels.ntfy));
        break;
      case 'email':
        if (config.channels.email) channels.push(new EmailChannel(config.channels.email));
        break;
      case 'telegram':
        if (config.channels.telegram) channels.push(new TelegramChannel(config.channels.telegram));
        break;
      case 'console':
        channels.push(new ConsoleChannel());
        break;
      default:
        logger.warn({ channel: name }, 'Channel is enabled but not implemented yet; ignored.');
    }
  }
  return channels;
}

export async function startService(config: Config, logger: Logger): Promise<RunningService> {
  const channels = createChannels(config, logger);
  const settings = await SettingsStore.load(
    config.settingsFile,
    channels.map((c) => c.name),
    logger,
  );
  const notifier = new Notifier({
    channels,
    selection: settings,
    logger,
    rateLimitPerMinute: config.rateLimitPerMinute,
  });

  const server = createHttpServer({
    host: config.host,
    apiToken: config.apiToken,
    mcpHandler: createMcpHandler(notifier),
    notifier,
    logger,
  });
  await listen(server, config.host, config.port);
  const port = (server.address() as AddressInfo).port;
  logger.info(
    {
      host: config.host,
      port,
      available: channels.length,
      selected: settings.getSelected().length,
    },
    'NotifyPaul started.',
  );

  let tray: TrayView | undefined;
  let stopping: Promise<void> | undefined;
  const stop = () => {
    stopping ??= Promise.resolve().then(async () => {
      tray?.close();
      await close(server);
      logger.info('NotifyPaul stopped.');
    });
    return stopping;
  };
  if (config.trayEnabled) {
    tray = startTrayProcess(nativeExecutable, logger, (id) => {
      void controller.dispatch(id);
    });
    const controller = new TrayController(
      settings,
      new RegistryAutostart(nativeExecutable),
      tray,
      stop,
      logger,
    );
    await controller.initialize();
  }
  return { port, settings, stop };
}

function listen(server: Server, host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException) => {
      reject(error.code === 'EADDRINUSE' ? new PortInUseError(host, port) : error);
    };
    server.once('error', onError);
    server.listen(port, host, () => {
      server.off('error', onError);
      resolve();
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => server.closeAllConnections(), SHUTDOWN_GRACE_MS);
    timer.unref();
    server.close(() => {
      clearTimeout(timer);
      resolve();
    });
    server.closeIdleConnections();
  });
}
