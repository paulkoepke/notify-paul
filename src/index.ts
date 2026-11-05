import { ConfigError, loadConfig } from './config.js';
import { createLogger, type Logger } from './logger.js';
import { PortInUseError, startService } from './service.js';
import { RotatingLog } from './rotating-log.js';
import { isNotifyPaulRunning } from './single-instance.js';

async function main(): Promise<void> {
  let loaded;
  try {
    loaded = loadConfig();
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    // ConfigError messages never contain values, only variable names and rules.
    // The "[config] " prefix lets the native starter copy exactly these lines into starter.log.
    process.stderr.write(
      `${error.message
        .split('\n')
        .map((line) => `[config] ${line}`)
        .join('\n')}\n`,
    );
    process.exitCode = 1;
    return;
  }

  const { config, warnings } = loaded;
  const destination = config.logFile ? new RotatingLog(config.logFile) : undefined;
  const logger = createLogger(config.logLevel, destination);
  process.once('exit', () => destination?.close());
  for (const warning of warnings) logger.warn(warning);

  let service;
  try {
    service = await startService(config, logger);
  } catch (error) {
    if (!(error instanceof PortInUseError)) throw error;
    if (await isNotifyPaulRunning(config.host, config.port)) return;
    logger.error({ host: error.host, port: error.port }, error.message);
    process.exitCode = 1;
    return;
  }

  // Also used by the tray's "Exit" entry (step 10).
  const shutdown = (signal: string) => {
    logger.info({ signal }, 'Shutting down.');
    void service.stop().then(() => process.exit(0));
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGBREAK', () => shutdown('SIGBREAK'));
  registerCrashHandlers(logger);
}

function registerCrashHandlers(logger: Logger): void {
  process.on('uncaughtException', () => {
    // Only the type: messages and stacks may contain request data.
    logger.fatal({ code: 'uncaught_exception' }, 'Uncaught exception; exiting.');
    process.exit(1);
  });
  process.on('unhandledRejection', () => {
    logger.error({ code: 'unhandled_rejection' }, 'Unhandled promise rejection.');
  });
}

await main().catch(() => {
  process.stderr.write('NotifyPaul could not start. Check configuration, log path and build.\n');
  process.exitCode = 1;
});
