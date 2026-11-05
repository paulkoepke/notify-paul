import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import type { Logger } from '../logger.js';
import type { ChannelName } from './types.js';

/** Read-only view used by the notifier. */
export interface ChannelSelection {
  getSelected(): readonly ChannelName[];
}

/** Unknown or no longer available channel names are tolerated here and dropped on load. */
const settingsFileSchema = z.object({
  selectedChannels: z.array(z.string()),
});

type WarnLogger = Pick<Logger, 'warn'>;

/**
 * The user's channel selection (tray), kept in memory and persisted to a JSON file.
 * Changes take effect immediately; saving happens atomically (temp file + rename).
 */
export class SettingsStore implements ChannelSelection {
  private selected: ChannelName[];
  private saveQueue: Promise<void> = Promise.resolve();

  private constructor(
    private readonly file: string,
    private readonly available: readonly ChannelName[],
    selected: readonly string[],
  ) {
    this.selected = this.normalize(selected);
  }

  /**
   * Loads the selection. A missing file selects all available channels; an unreadable or invalid
   * file does the same with a warning. Channels that are not available are ignored.
   */
  static async load(
    file: string,
    available: readonly ChannelName[],
    logger: WarnLogger,
  ): Promise<SettingsStore> {
    const selected = await readSelection(file, logger);
    return new SettingsStore(file, available, selected ?? available);
  }

  getSelected(): readonly ChannelName[] {
    return this.selected;
  }

  getAvailable(): readonly ChannelName[] {
    return this.available;
  }

  isSelected(channel: ChannelName): boolean {
    return this.selected.includes(channel);
  }

  /** Replaces the selection (effective immediately) and persists it. Rejects if saving fails. */
  setSelected(channels: readonly ChannelName[]): Promise<void> {
    this.selected = this.normalize(channels);
    return this.save([...this.selected]);
  }

  setChannelSelected(channel: ChannelName, selected: boolean): Promise<void> {
    const next = selected
      ? [...this.selected, channel]
      : this.selected.filter((c) => c !== channel);
    return this.setSelected(next);
  }

  /** Keeps only available channels, without duplicates, in the order of `available`. */
  private normalize(channels: readonly string[]): ChannelName[] {
    return this.available.filter((c) => channels.includes(c));
  }

  /** Writes are serialized so an older snapshot never overwrites a newer one. */
  private save(selectedChannels: ChannelName[]): Promise<void> {
    const run = this.saveQueue.then(() => writeAtomic(this.file, { selectedChannels }));
    this.saveQueue = run.catch(() => undefined);
    return run;
  }
}

async function readSelection(file: string, logger: WarnLogger): Promise<string[] | undefined> {
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      logger.warn({ file, code }, 'Settings file is unreadable; all available channels selected.');
    }
    return undefined;
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    json = undefined;
  }
  const parsed = settingsFileSchema.safeParse(json);
  if (!parsed.success) {
    logger.warn({ file }, 'Settings file is invalid; all available channels selected.');
    return undefined;
  }
  return parsed.data.selectedChannels;
}

async function writeAtomic(file: string, data: unknown): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
    await rename(tmp, file);
  } catch (error) {
    await rm(tmp, { force: true });
    throw error;
  }
}
