import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { dirname } from 'node:path';
import type { DestinationStream } from 'pino';

/** Small synchronous destination: records are written before shutdown, bounded disk usage. */
export class RotatingLog implements DestinationStream {
  private fd: number | undefined;
  private size = 0;
  constructor(
    private readonly file: string,
    private readonly maxBytes = 5 * 1024 * 1024,
    private readonly backups = 3,
  ) {
    mkdirSync(dirname(file), { recursive: true });
    this.open();
  }
  private open(): void {
    this.fd = openSync(this.file, 'a');
    this.size = statSync(this.file).size;
  }
  write(message: string): void {
    const bytes = Buffer.from(message);
    if (this.size > 0 && this.size + bytes.length > this.maxBytes) {
      this.close();
      const oldest = `${this.file}.${this.backups}`;
      if (existsSync(oldest)) unlinkSync(oldest);
      for (let i = this.backups - 1; i >= 1; i--) {
        if (existsSync(`${this.file}.${i}`))
          renameSync(`${this.file}.${i}`, `${this.file}.${i + 1}`);
      }
      renameSync(this.file, `${this.file}.1`);
      this.open();
    }
    if (this.fd === undefined) return;
    let offset = 0;
    while (offset < bytes.length) offset += writeSync(this.fd, bytes, offset);
    this.size += bytes.length;
  }
  close(): void {
    if (this.fd !== undefined) {
      closeSync(this.fd);
      this.fd = undefined;
    }
  }
}
