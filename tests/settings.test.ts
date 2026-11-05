import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsStore } from '../src/core/settings.js';
import type { ChannelName } from '../src/core/types.js';

const AVAILABLE: ChannelName[] = ['telegram', 'discord', 'console'];

let dir: string;
let file: string;
const logger = { warn: vi.fn() };

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'notify-paul-settings-'));
  file = join(dir, 'NotifyPaul', 'settings.json');
  logger.warn.mockReset();
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function writeSettings(content: string): Promise<void> {
  await writeFile(join(dir, 'settings.json'), content, 'utf8');
  file = join(dir, 'settings.json');
}

describe('SettingsStore', () => {
  it('selects all available channels when the file is missing, without a warning', async () => {
    const store = await SettingsStore.load(file, AVAILABLE, logger);
    expect(store.getSelected()).toEqual(AVAILABLE);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it.each([
    ['malformed JSON', '{ not json'],
    ['wrong shape', '{"selectedChannels": "telegram"}'],
    ['missing field', '{}'],
    ['not an object', '[]'],
  ])('selects all available channels with a warning for %s', async (_, content) => {
    await writeSettings(content);
    const store = await SettingsStore.load(file, AVAILABLE, logger);
    expect(store.getSelected()).toEqual(AVAILABLE);
    expect(logger.warn).toHaveBeenCalledOnce();
  });

  it('loads a stored selection and ignores unavailable or unknown channels', async () => {
    await writeSettings('{"selectedChannels": ["console", "email", "sms", "telegram"]}');
    const store = await SettingsStore.load(file, AVAILABLE, logger);
    expect(store.getSelected()).toEqual(['telegram', 'console']);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('keeps an empty selection (muted) instead of falling back to all', async () => {
    await writeSettings('{"selectedChannels": []}');
    const store = await SettingsStore.load(file, AVAILABLE, logger);
    expect(store.getSelected()).toEqual([]);
  });

  it('applies changes immediately and persists them across loads', async () => {
    const store = await SettingsStore.load(file, AVAILABLE, logger);

    const saving = store.setSelected(['console', 'telegram', 'telegram', 'email']);
    expect(store.getSelected()).toEqual(['telegram', 'console']);
    await saving;

    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({
      selectedChannels: ['telegram', 'console'],
    });
    const reloaded = await SettingsStore.load(file, AVAILABLE, logger);
    expect(reloaded.getSelected()).toEqual(['telegram', 'console']);
  });

  it('toggles single channels, including none and all', async () => {
    const store = await SettingsStore.load(file, AVAILABLE, logger);

    await store.setChannelSelected('discord', false);
    expect(store.getSelected()).toEqual(['telegram', 'console']);
    expect(store.isSelected('discord')).toBe(false);

    await store.setChannelSelected('telegram', false);
    await store.setChannelSelected('console', false);
    expect(store.getSelected()).toEqual([]);
    expect((await SettingsStore.load(file, AVAILABLE, logger)).getSelected()).toEqual([]);

    for (const channel of AVAILABLE) await store.setChannelSelected(channel, true);
    expect(store.getSelected()).toEqual(AVAILABLE);
  });

  it('writes atomically without leaving temporary files and keeps the last change', async () => {
    const store = await SettingsStore.load(file, AVAILABLE, logger);
    await Promise.all([
      store.setSelected(['telegram']),
      store.setSelected(['discord']),
      store.setSelected(['console']),
    ]);

    expect(await readdir(join(dir, 'NotifyPaul'))).toEqual(['settings.json']);
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ selectedChannels: ['console'] });
  });

  it('rejects when saving fails but keeps the in-memory selection', async () => {
    // A file where the settings directory should be makes saving fail.
    await writeFile(join(dir, 'blocker'), 'x');
    const store = await SettingsStore.load(
      join(dir, 'blocker', 'settings.json'),
      AVAILABLE,
      logger,
    );

    await expect(store.setSelected(['telegram'])).rejects.toThrow();
    expect(store.getSelected()).toEqual(['telegram']);
  });
});
