# Zorya

Personal AI assistant on Telegram, powered by Claude Agent SDK running in Docker containers. Fork of [qwibitai/nanoclaw](https://github.com/qwibitai/nanoclaw).

Bot name: **Zorya** (`@mihai_s_bot`)

## Setup

```bash
git clone https://github.com/mihaipora/zorya.git
cd zorya
npm install
# configure .env (TELEGRAM_BOT_TOKEN, ANTHROPIC_API_KEY, etc.)
claude
```

Then run `/setup`. Claude Code handles container build, service registration, and authentication.

## Architecture

```
Telegram (grammy) --> SQLite --> Polling loop --> Docker container (Claude Agent SDK) --> Response
```

Single Node.js process. Each group gets an isolated Docker container with its own filesystem and `CLAUDE.md` memory. Only explicitly mounted directories are accessible inside the container. IPC via filesystem.

Key files:

| File | Purpose |
|------|---------|
| `src/index.ts` | Orchestrator: state, message loop, agent invocation |
| `src/channels/telegram.ts` | Telegram bot, commands, send/receive |
| `src/container-runner.ts` | Spawns streaming agent containers |
| `src/router.ts` | Message formatting and outbound routing |
| `src/db.ts` | SQLite (messages, groups, sessions, state) |
| `src/task-scheduler.ts` | Scheduled tasks |
| `groups/*/CLAUDE.md` | Per-group memory (isolated) |

## Telegram Commands

| Command | Description |
|---------|-------------|
| `/status` | Queue status, active agents with prompt snippet, scheduled tasks |
| `/verbose` | Turn on progress streaming (tool-use summaries while agent works) |
| `/noverbose` | Turn off progress streaming |
| `/ping` | Check if bot is online |
| `/chatid` | Get the Telegram chat ID for registration |

## Custom Features

Changes on top of upstream NanoClaw:

- **Telegram-only channel** with bot commands (`/status`, `/verbose`, `/ping`, `/chatid`)
- **Progress streaming** — agent sends tool-use summaries (_Running command..._) as it works, not just the final result
- **Prompt snippet in status** — `/status` shows what the bot is currently working on
- **Scheduled task duplicate fix** — prevents duplicate task execution on restart

## Pulling Upstream Updates

```bash
git fetch upstream
git merge upstream/main
```

Or run `/update` inside Claude Code for guided merging.

## License

MIT
