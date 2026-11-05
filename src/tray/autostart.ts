import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';

const KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
export interface Autostart {
  isEnabled(): Promise<boolean>;
  setEnabled(enabled: boolean): Promise<void>;
}
export type RegistryRunner = (args: string[]) => Promise<{ code: number; stdout: string }>;
export const runRegistry: RegistryRunner = (args) =>
  new Promise((resolveResult, reject) => {
    const child = spawn(
      join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'reg.exe'),
      args,
      { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    let stdout = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (data: string) => {
      if (stdout.length < 65536) stdout += data;
    });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('Registry timeout'));
    }, 5000);
    child.once('error', () => {
      clearTimeout(timer);
      reject(new Error('Registry unavailable'));
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      resolveResult({ code: code ?? 1, stdout });
    });
  });

export class RegistryAutostart implements Autostart {
  constructor(
    private readonly starter: string,
    private readonly run: RegistryRunner = runRegistry,
  ) {}
  async isEnabled(): Promise<boolean> {
    const result = await this.run(['query', KEY, '/v', 'NotifyPaul']);
    if (result.code === 0) return /\bNotifyPaul\s+REG_SZ\s+/.test(result.stdout);
    // Distinguish an absent value from a registry access failure.
    if ((await this.run(['query', KEY])).code !== 0) throw new Error('Registry read failed');
    return false;
  }
  async setEnabled(enabled: boolean): Promise<void> {
    if (!enabled && !(await this.isEnabled())) return;
    const args = enabled
      ? [
          'add',
          KEY,
          '/v',
          'NotifyPaul',
          '/t',
          'REG_SZ',
          '/d',
          `"${resolve(this.starter)}" --start`,
          '/f',
        ]
      : ['delete', KEY, '/v', 'NotifyPaul', '/f'];
    if ((await this.run(args)).code !== 0) throw new Error('Registry update failed');
  }
}
