# AGENTS.md

Instructions for AI coding agents working in this repository. See [`README.md`](README.md) for usage and setup.

## Project

NotifyPaul is a local Windows background service that forwards notifications from AI agents and local programs to the user (Telegram, email, Discord, ntfy). It is reachable via MCP (Streamable HTTP, tool `notify-paul`) and `POST /notify`. The user chooses the channels through a tray icon; callers never know how the user is notified.

## Stack

- TypeScript on Node.js (current LTS), ESM
- Official MCP TypeScript SDK (Streamable HTTP)
- `node:http` (no framework), `process.loadEnvFile()` (Node 24 LTS) + `zod`, `nodemailer`, native `fetch`, `pino`
- Tests: `vitest` with mocked channel adapters; native protocol/icon/build checks via PowerShell
- Tray/starter: own C# WinForms WinExe on the Windows .NET Framework, JSON lines over stdin/stdout; icon from `sprites/notify-paul-icon.png`. SMTP transport per attempt with an abortable socket; log rotation at 5 MiB plus three backups.

## Structure

```text
src/
  index.ts, service.ts, config.ts, logger.ts
  server/   mcp.ts, http.ts
  core/     notifier.ts, router.ts, rate-limiter.ts, types.ts, schema.ts, settings.ts
  channels/ channel.ts, console.ts, telegram.ts, email.ts, discord.ts, ntfy.ts
  tray/     tray controller and process, autostart.ts
native/     C# tray helper and starter
scripts/    install.ps1, uninstall.ps1, build/test scripts
tests/
```

## Architecture rules

- Every channel implements the same small `NotificationChannel` interface; routing knows no provider details.
- The MCP tool and `POST /notify` use the same input schema and the same routing service.
- Per-channel results (`sent | failed`) are internal/log only; a failing channel must not block others. Delivery is parallel with an overall deadline (~10 s).
- Callers only receive `{ id, status }` with overall status `sent | partial | failed | muted` – no channel names. `sent` only means "accepted by the provider"; `muted` = no channel selected (not an error).
- Channel selection is up to the user only: target channels = channels selected in the tray ∩ available channels (`*_ENABLED=true`). `priority` only affects provider behaviour.
- All channels are optional; validate required values only when `*_ENABLED=true`.
- The tray icon is optional (`TRAY_ENABLED`); the service also works without it.
- The bearer token protects `/notify` and `/mcp` (timing-safe); `/health` needs no token.
- Short timeouts; bounded retries only for retryable errors.
- No scope creep: apart from the tray icon, no GUI, database, cloud or queue.

## Security rules (binding)

- Default bind is `127.0.0.1` only; protect the HTTP API with a bearer token; guard the MCP endpoint with host/origin checks.
- Agents must not pass channels, recipient IDs, webhook URLs or target URLs; unknown input fields are a validation error.
- No secrets (tokens, SMTP credentials, webhook URLs) in logs, error messages or tool results.
- Limit `title`/`message` length, escape per channel, block Discord mentions (`@everyone` etc.).
- Agent input is untrusted: no shell execution, no dynamic URLs. Processes started by the service: the tray helper and `reg.exe` (autostart); the user-launched native starter additionally starts only the fixed Node path with `dist/index.js` – fixed paths and arguments, `spawn` without a shell. The starter first stops a running instance (only Node running exactly this `dist/index.js` and other copies of the same `NotifyPaul.exe`), so only one instance runs.
- Never commit `.env`; `.env.example` contains placeholders only.
- Prefer logging metadata and error codes over message contents.

## Conventions

- Language: documentation, code identifiers and comments in English.
- Configuration exclusively via environment variables, validated with `zod` in `src/config.ts`.
- New channels: adapter in `src/channels/`, configuration + `*_ENABLED` flag, test with a mock, entry in `.env.example` and README.
- Windows is the only target platform. Windows Toast is intentionally not part of the project.

## Commands

- `npm run dev` – run the service with restart on changes (`tsx watch`)
- `npm run build` – compile TypeScript to `dist/`
- `npm run build:native` – build the Windows tray/starter and the sprite ICO
- `npm run test:native` – check native protocol, icon and install scripts
- `npm run send-test -- --channel <name>` – deliberately send a real test message
- `npm start` – run the built service
- `npm test` – tests (`vitest`)
- `npm run lint` / `npm run format` – ESLint / Prettier
- `npm run typecheck` – type check without output

## Working notes

- Use mocked adapters in tests; test real providers manually only.
- Keep this file and the README in sync when architecture or interfaces change.
