import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { loadConfig, type Config } from './config.js';
import { CHANNEL_NAMES, PRIORITIES } from './core/types.js';
import { createChannels } from './service.js';
import { Notifier } from './core/notifier.js';
import { createLogger } from './logger.js';

export async function sendTest(
  args: string[],
  config: Config,
  print: (text: string) => void = console.log,
): Promise<number> {
  const { values } = parseArgs({
    args,
    options: { channel: { type: 'string' }, priority: { type: 'string', default: 'normal' } },
    strict: true,
  });
  const priority = PRIORITIES.find((p) => p === values.priority);
  if (!priority || (values.channel && !CHANNEL_NAMES.some((c) => c === values.channel)))
    throw new Error('Invalid arguments');
  const logger = createLogger('silent');
  const channels = createChannels(config, logger).filter(
    (c) => !values.channel || c.name === values.channel,
  );
  if (channels.length === 0) {
    print('No matching channel is enabled.');
    return 1;
  }
  const results = await Promise.all(
    channels.map(async (channel) => {
      const notifier = new Notifier({
        channels: [channel],
        selection: { getSelected: () => [channel.name] },
        logger,
        rateLimitPerMinute: 1,
      });
      const result = await notifier.notify({
        title: 'NotifyPaul Test',
        message: 'The notification service is reachable.',
        priority,
        source: 'send-test',
      });
      print(`${channel.name}: ${result.ok ? result.result.status : result.error}`);
      return result.ok && result.result.status === 'sent';
    }),
  );
  return results.every(Boolean) ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = await sendTest(process.argv.slice(2), loadConfig().config);
  } catch {
    console.error(
      'Test failed. Check configuration and arguments: --channel <name> --priority low|normal|urgent',
    );
    process.exitCode = 1;
  }
}
