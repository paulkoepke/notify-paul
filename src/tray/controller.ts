import type { SettingsStore } from '../core/settings.js';
import type { Logger } from '../logger.js';
import type { Autostart } from './autostart.js';

export interface TrayMenu {
  tooltip: string;
  items: { id: string; text: string; checked?: boolean; enabled?: boolean }[];
}
export interface TrayView {
  update(menu: TrayMenu): void;
  close(): void;
}

export class TrayController {
  private autostartEnabled = false;
  private autostartAvailable = false;
  private queue = Promise.resolve();
  constructor(
    private readonly settings: SettingsStore,
    private readonly autostart: Autostart,
    private readonly view: TrayView,
    private readonly stop: () => Promise<void>,
    private readonly logger: Logger,
  ) {}
  async initialize(): Promise<void> {
    try {
      this.autostartEnabled = await this.autostart.isEnabled();
      this.autostartAvailable = true;
    } catch {
      this.autostartAvailable = false;
      this.logger.warn('Autostart state could not be read.');
    }
    this.render();
  }
  dispatch(id: string): Promise<void> {
    const work = this.queue.then(async () => {
      if (id === 'exit') {
        await this.stop();
        return;
      }
      if (id === 'refresh') {
        await this.initialize();
        return;
      }
      try {
        if (id === 'autostart' && this.autostartAvailable) {
          await this.autostart.setEnabled(!this.autostartEnabled);
          this.autostartEnabled = !this.autostartEnabled;
        } else {
          const channel = this.settings.getAvailable().find((name) => id === `channel:${name}`);
          if (channel)
            await this.settings.setChannelSelected(channel, !this.settings.isSelected(channel));
        }
      } catch {
        this.logger.warn('Tray setting could not be saved.');
      }
      this.render();
    });
    this.queue = work.catch(() => {
      this.logger.warn('Tray action failed.');
    });
    return this.queue;
  }
  private render(): void {
    const count = this.settings.getSelected().length;
    this.view.update({
      tooltip: count
        ? `NotifyPaul – ${count} ${count === 1 ? 'channel' : 'channels'}`
        : 'NotifyPaul – muted',
      items: [
        ...this.settings.getAvailable().map((name) => ({
          id: `channel:${name}`,
          text: name === 'email' ? 'E-Mail' : name[0]!.toUpperCase() + name.slice(1),
          checked: this.settings.isSelected(name),
        })),
        { id: 'separator', text: '' },
        {
          id: 'autostart',
          text: 'Start with Windows',
          checked: this.autostartEnabled,
          enabled: this.autostartAvailable,
        },
        { id: 'separator', text: '' },
        { id: 'exit', text: 'Exit' },
      ],
    });
  }
}
