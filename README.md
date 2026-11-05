<p align="center">
  <img src="sprites/notify-paul-icon.png" alt="NotifyPaul bell icon" width="140">
</p>

<h1 align="center">NotifyPaul</h1>

<p align="center">
  A small local Windows service that lets your AI agents and scripts <strong>ping you</strong> —<br>
  on Telegram, email, Discord or ntfy — without knowing how, or where, you want to be reached.
</p>

---

## What is this?

AI coding agents (Claude Code, Codex, …) and long-running scripts often finish at moments when you are not looking at the screen. NotifyPaul gives them one simple, safe way to tell you:

- **Agents** call a single MCP tool, `notify-paul`.
- **Scripts and programs** send a `POST /notify` request to `localhost`.
- **You** decide in the system tray which channels (Telegram, email, Discord, ntfy) actually reach you right now. Callers never see or choose channels, recipients or URLs.

Everything runs on your own PC. No cloud, no database, no extra running costs.

### Example use case

You start a long refactoring in Claude Code and go make coffee. When the agent is done — or when it gets stuck and needs an answer — it calls `notify-paul`:

```json
{
  "title": "Build finished",
  "message": "All 152 tests passed. Ready for review.",
  "priority": "normal",
  "source": "claude-code"
}
```

A moment later your phone buzzes (Telegram and/or ntfy). Heading out for the day? Untick Telegram in the tray menu and keep only email. Need silence? Untick everything — the agent still gets a normal answer (`muted`), nothing breaks, and nobody is notified.

The same works for a build script, a backup job or a Unity editor tool:

```powershell
Invoke-RestMethod http://127.0.0.1:3847/notify -Method Post `
  -Headers @{ Authorization = "Bearer $env:NOTIFY_PAUL_TOKEN" } `
  -ContentType 'application/json' `
  -Body '{"title":"Backup done","message":"Nightly backup finished."}'
```

## How it works

```text
 Claude Code / Codex / any MCP agent            Scripts, tools, Unity, ...
                  |                                       |
        MCP (Streamable HTTP)                      POST /notify
                  |                                       |
                  +------------------+--------------------+
                                     v
                         NotifyPaul (localhost only)
                  validate -> rate limit -> pick channels
                                     |
          +-------------+------------+------------+-------------+
          v             v            v            v
      Telegram        Email       Discord        ntfy
      (Bot API)       (SMTP)     (Webhook)    (HTTP publish)
                                     ^
                     tray icon: you choose the channels
```

- Both entry points share the same input schema, rate limit and delivery logic.
- Delivery runs in parallel with a 10 s overall deadline. One failing channel never blocks the others.
- Callers only get back `{ "id": "...", "status": "sent | partial | failed | muted" }` — no channel names, no provider details.

## Features

- **Four optional channels:** Telegram, email (SMTP), Discord (webhook), ntfy.
- **MCP + HTTP** with the same schema, token and limits.
- **Tray icon** with per-channel checkboxes (applied instantly, remembered across restarts), *Start with Windows* and *Exit*.
- **Secure by default:** binds to `127.0.0.1`, bearer token, host/origin checks, strict input schema, no secrets in logs, no `@everyone` pings.
- **Runs quietly:** no console window, single instance, rotating log file (5 MiB + 3 backups).
- **Lightweight stack:** TypeScript on Node.js, `node:http`, a tiny C# WinForms tray helper that uses the .NET Framework already shipped with Windows.

> **Status:** v0.1, tested end to end on Windows with real providers. The automated test suite additionally covers all providers and the native tray helper with mocks (see [Development](#development)). After setting up a channel with your own credentials, `npm run send-test` sends a real test message.

## Installation

Requirements: Windows 10/11, Node.js 24 or newer, Windows PowerShell 5.1 (with .NET Framework 4.x, both part of Windows). No admin rights needed. Keep the repository at its final location; the starter uses absolute paths.

```powershell
npm ci
Copy-Item .env.example .env
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Put the generated value into `.env` as `HTTP_API_TOKEN` (at least 32 characters), then enable and configure at least one channel (see below) — or set all `*_ENABLED=false` to start muted. Never commit `.env`. Real environment variables take precedence over `.env`.

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/install.ps1
```

The script builds TypeScript and the Windows helper, creates a **NotifyPaul** desktop shortcut and enables autostart at user logon. It does not start the service yet — open **NotifyPaul** from the desktop. The service starts without a console window and uses the repository as its working directory.

Re-run the install script after moving the repository or changing your Node.js installation.

**Restart behaviour:** only one instance runs at a time. Clicking the desktop shortcut (or autostart) hard-stops a running instance and starts a fresh one, so changed `.env` values take effect with a double-click.

## Configure channels

All channels are optional. Required values are only validated when `*_ENABLED=true`. With no channel the service still starts (with a warning) and answers `muted`.

| Channel | Setup |
| --- | --- |
| Telegram | Create a bot with `@BotFather` and put its token into `TELEGRAM_BOT_TOKEN`. Send `/start` to the bot in your own chat, find your `message.chat.id` via the Bot API `getUpdates` call and set `TELEGRAM_CHAT_ID`. Set `TELEGRAM_ENABLED=true`. The token is part of the API URL — never share such URLs. |
| Email | Set `EMAIL_ENABLED=true`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `EMAIL_FROM`, `EMAIL_TO`. If your server needs authentication, set `SMTP_USER` and `SMTP_PASSWORD` together (use an app password where available). Port 465: `SMTP_SECURE=true`; port 587: `false` (STARTTLS is required). Unencrypted SMTP is refused. |
| Discord | In a private server channel, create a webhook under *Integrations*. Set `DISCORD_ENABLED=true` and `DISCORD_WEBHOOK_URL`. Keep the URL secret. Mentions are suppressed via `allowed_mentions: { parse: [] }`. |
| ntfy | Set `NTFY_ENABLED=true`, `NTFY_SERVER_URL` (default `https://ntfy.sh`), `NTFY_TOPIC`, optionally `NTFY_TOKEN`. Subscribe to the topic in the ntfy app. For confidential messages use a protected or self-hosted server — a random topic name alone is not access control. |

Provider docs: [Telegram Bot API](https://core.telegram.org/bots/api#getupdates), [Discord Webhooks](https://discord.com/developers/docs/resources/webhook#execute-webhook), [ntfy JSON publish](https://docs.ntfy.sh/publish/#publish-as-json), [Nodemailer SMTP](https://nodemailer.com/smtp).

Restart the service after changing the configuration. `CONSOLE_ENABLED=true` is a development channel that prints to stdout (never to the log file).

Optional tool for sending a real test message:

```powershell
npm run send-test -- --channel telegram --priority low
npm run send-test
```

Without `--channel` it sends to all configured channels, independent of the tray selection and without a running service. Exit code 0 means full success, 1 means failure or no available channel.

## Tray and operation

Right-click the bell icon to see your available channels. Each checkbox takes effect immediately; no checkboxes means **muted**. The selection is stored in `%APPDATA%\NotifyPaul\settings.json` (override with `SETTINGS_FILE`). If the file is missing or invalid, all available channels are selected; a saved empty list stays empty.

**Start with Windows** only manages the `NotifyPaul` value in `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`. **Exit** closes the tray and the HTTP server. The icon may be hidden in the Windows overflow menu.

`TRAY_ENABLED=false` runs without a tray. A crashed tray helper does not stop delivery. Nothing runs before you log on, and there is no automatic restart after a crash.

Logging: `LOG_LEVEL` sets the level, `LOG_FILE` the file (e.g. `logs/notify-paul.log`); it rotates at 5 MiB with three backups. Without `LOG_FILE`, logs go to stdout. Startup problems of the invisible starter land in `logs/starter.log` (invalid configuration is reported by variable name only, never by value). Message contents and provider responses are never logged.

Uninstall autostart and the desktop shortcut:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/uninstall.ps1
```

Then exit a running instance from the tray. The repository, `.env`, selection and logs are kept.

## Connect an MCP client

Endpoint: `http://127.0.0.1:3847/mcp` (stateless Streamable HTTP), tool name `notify-paul`. The service must be running independently of the client.

**Claude Code:**

```powershell
$env:NOTIFY_PAUL_TOKEN = '<same value as HTTP_API_TOKEN>'
claude mcp add --transport http notify-paul http://127.0.0.1:3847/mcp --header "Authorization: Bearer $env:NOTIFY_PAUL_TOKEN"
```

The local client configuration then contains the header — keep it out of version control. See the [Claude Code MCP docs](https://code.claude.com/docs/en/mcp).

**Codex** — add to `%USERPROFILE%\.codex\config.toml`:

```toml
[mcp_servers.notify-paul]
url = "http://127.0.0.1:3847/mcp"
bearer_token_env_var = "NOTIFY_PAUL_TOKEN"
```

`NOTIFY_PAUL_TOKEN` must be set in the environment of the Codex process; NotifyPaul's `.env` does not set client variables. See the [Codex MCP docs](https://developers.openai.com/codex/mcp).

### Tool input

```json
{"title":"Build finished","message":"Build succeeded.","priority":"normal","source":"codex"}
```

| Field | Rules |
| --- | --- |
| `title` | required, 1–200 characters, single line |
| `message` | required, 1–4000 characters (line breaks allowed) |
| `priority` | optional: `low`, `normal` (default), `urgent` — passed to the provider (e.g. silent Telegram message for `low`), never changes channel selection |
| `source` | optional, up to 64 characters (letters, digits, spaces and `._:/-`), shown in the message |

Unknown fields — including channels or recipients — are rejected.

### Result

`sent` = accepted by all selected providers, `partial` = some, `failed` = none, `muted` = no channel selected. `isError` is set for rejected or failed calls, not for `muted` or `partial`. `sent` means "accepted by the provider", not "read"; there is no guaranteed delivery.

## HTTP API

```powershell
$headers = @{ Authorization = "Bearer $env:NOTIFY_PAUL_TOKEN" }
$body = @{ title = 'Build finished'; message = 'Everything succeeded.'; source = 'powershell' } | ConvertTo-Json
Invoke-RestMethod http://127.0.0.1:3847/notify -Method Post -Headers $headers -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($body))
Invoke-RestMethod http://127.0.0.1:3847/health
```

`/health` needs no token. `/notify` and `/mcp` check host, origin and bearer token; POST requires JSON and at most 64 KiB. Defaults are `HOST=127.0.0.1` and `PORT=3847`. The global `RATE_LIMIT_PER_MINUTE` (default 10) is shared by both entry points, including urgent and muted requests.

Delivery runs in parallel with a 10 s overall deadline, 5 s per attempt and at most three attempts. Only timeouts, provider 429 and transient server errors are retried. As with most provider APIs, a timeout after acceptance can lead to a duplicate message on retry.

## Security model

- Listens on `127.0.0.1` only; bearer token (constant-time comparison) for `/notify` and `/mcp`; host and origin checks; strict `Content-Type`; body size limit.
- Agents cannot choose channels, recipients, webhook URLs or target URLs; unknown input fields are a validation error.
- Agent input is treated as untrusted: no shell execution, no dynamic URLs. The only processes the service starts are the tray helper and `reg.exe` (autostart), with fixed paths and arguments and without a shell.
- No secrets (tokens, SMTP credentials, webhook URLs) in logs, errors or tool results; logs favour metadata and error codes over message contents.
- Titles and messages are length-limited and escaped per channel; Discord mentions are blocked.

## Development

```powershell
npm run dev            # restart on changes
npm run build
npm run build:native   # tray helper + icon
npm run typecheck
npm test               # vitest, mocked providers
npm run test:native    # menu protocol, icon, GUI subsystem, PowerShell syntax
npm run lint
```

`npm start` runs the built service in the foreground. Set `TRAY_ENABLED=false` for development without the icon. Provider tests use mocks; the native checks do not touch the registry or the desktop.

Adding a channel: implement the small `NotificationChannel` interface in `src/channels/`, add its config and `*_ENABLED` flag, a test with a mock, and entries in `.env.example` and this README.

## Troubleshooting

- **Desktop shortcut does nothing visible:** check `logs/starter.log`. Invalid configuration is listed there by variable name; `logs/notify-paul.log` only exists once the configuration is valid.
- **401:** the client token is missing or differs from `HTTP_API_TOKEN`.
- **403:** host or origin does not match the local address and configured port.
- **429:** global rate limit reached; try again later.
- **`muted`:** no available channel selected — check the tray and `*_ENABLED`.
- **`provider_auth_failed`:** check the credentials at the provider.
- **`provider_rejected`:** check recipient, permissions and provider configuration.
- **`provider_timeout` / `provider_unreachable`:** check network, DNS, TLS and reachability.
- **No tray icon:** check `TRAY_ENABLED`, the Windows overflow menu and run `npm run build:native`.
- **Starter or autostart starts nothing:** the Node.js path is fixed at build time (version-manager links such as fnm are resolved); run `npm run build:native` again after a Node update.
- **Startup fails:** check `.env`, write permission for the log path and that the port is free; `npm start` prints configuration errors without secrets.

## License

[MIT](LICENSE)
