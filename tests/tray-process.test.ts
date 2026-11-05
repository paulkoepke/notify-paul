import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { startTrayProcess } from '../src/tray/process.js';
import { createLogger } from '../src/logger.js';
vi.mock('node:child_process', () => ({ spawn: vi.fn() }));
afterEach(() => vi.clearAllMocks());
it('exchanges menus and events without a shell and tolerates helper failure', () => {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    kill: vi.fn(),
  });
  vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);
  const events = vi.fn();
  const records: string[] = [];
  const view = startTrayProcess(
    'C:\\fixed\\NotifyPaul.exe',
    createLogger('info', {
      write: (line) => {
        records.push(line);
      },
    }),
    events,
  );
  expect(spawn).toHaveBeenCalledWith(
    'C:\\fixed\\NotifyPaul.exe',
    ['--tray'],
    expect.objectContaining({ shell: false, windowsHide: true }),
  );
  view.update({ tooltip: 'NotifyPaul', items: [] });
  expect(child.stdin.read().toString()).toContain('NotifyPaul');
  child.stdout.write('{"id":"exit"}\n');
  expect(events).toHaveBeenCalledWith('exit');
  child.emit('error', new Error('private path'));
  child.emit('close', 1);
  expect(records.join('')).toContain('service remains available');
  expect(records.join('')).not.toContain('private path');
  view.close();
  expect(child.stdin.writableEnded).toBe(true);
  child.emit('close', 0);
  expect(child.kill).not.toHaveBeenCalled();
});
