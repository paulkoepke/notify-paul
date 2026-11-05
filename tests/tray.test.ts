import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { SettingsStore } from '../src/core/settings.js';
import { createLogger } from '../src/logger.js';
import { TrayController, type TrayMenu } from '../src/tray/controller.js';
import { RegistryAutostart } from '../src/tray/autostart.js';
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
it('toggles all/none, persists selection, handles autostart errors and exits', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'notify-tray-'));
  dirs.push(dir);
  const logger = createLogger('silent');
  const file = join(dir, 'settings.json');
  const settings = await SettingsStore.load(file, ['telegram', 'ntfy'], logger);
  let menu: TrayMenu;
  const view = {
    update: (value: TrayMenu) => {
      menu = value;
    },
    close: vi.fn(),
  };
  const autostart = {
    isEnabled: vi.fn().mockResolvedValue(false),
    setEnabled: vi.fn().mockResolvedValue(undefined),
  };
  const stop = vi.fn().mockResolvedValue(undefined);
  const controller = new TrayController(settings, autostart, view, stop, logger);
  await controller.initialize();
  expect(menu!.items.filter((i) => i.checked)).toHaveLength(2);
  expect(menu!.tooltip).toBe('NotifyPaul – 2 channels');
  await Promise.all([controller.dispatch('channel:telegram'), controller.dispatch('channel:ntfy')]);
  expect(menu!.tooltip).toContain('muted');
  expect((await SettingsStore.load(file, ['telegram', 'ntfy'], logger)).getSelected()).toEqual([]);
  await controller.dispatch('channel:telegram');
  expect(settings.getSelected()).toEqual(['telegram']);
  expect(menu!.tooltip).toBe('NotifyPaul – 1 channel');
  await controller.dispatch('autostart');
  expect(menu!.items.find((i) => i.id === 'autostart')?.checked).toBe(true);
  autostart.setEnabled.mockRejectedValue(new Error('private data'));
  await controller.dispatch('autostart');
  expect(menu!.items.find((i) => i.id === 'autostart')?.checked).toBe(true);
  await controller.dispatch('channel:unavailable');
  expect(settings.getSelected()).toEqual(['telegram']);
  await controller.dispatch('exit');
  expect(stop).toHaveBeenCalledOnce();
});
it('uses fixed registry arguments and quotes the starter path', async () => {
  const run = vi.fn().mockResolvedValue({
    code: 0,
    stdout: '    NotifyPaul    REG_SZ    "C:\\Notify Paul\\NotifyPaul.exe" --start',
  });
  const autostart = new RegistryAutostart('C:\\Notify Paul\\NotifyPaul.exe', run);
  expect(await autostart.isEnabled()).toBe(true);
  await autostart.setEnabled(true);
  expect(run).toHaveBeenLastCalledWith([
    'add',
    'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run',
    '/v',
    'NotifyPaul',
    '/t',
    'REG_SZ',
    '/d',
    '"C:\\Notify Paul\\NotifyPaul.exe" --start',
    '/f',
  ]);
  await autostart.setEnabled(false);
  expect(run.mock.calls.at(-1)![0][0]).toBe('delete');
  run.mockResolvedValue({ code: 1, stdout: '' });
  await expect(autostart.setEnabled(true)).rejects.toThrow('Registry update failed');
  await expect(autostart.isEnabled()).rejects.toThrow('Registry read failed');
});
