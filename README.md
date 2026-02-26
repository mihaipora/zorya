# Zorya

Privacy-first personal AI assistant. Monitors Gmail, Google Calendar, and Telegram conversations. Schedules meetings, detects pending replies, sends daily briefings — all with explicit user approval for any write actions.

Built on [NanoClaw](https://github.com/qwibitai/nanoclaw). Single Node.js process, Claude Agent SDK running in Docker containers.

## What It Does

- **Email monitoring** — reads Gmail threads, finds pending replies, surfaces action items
- **Calendar management** — checks availability, proposes events via inline keyboard (user taps to approve)
- **Telegram conversation tracking** — reads personal Telegram conversations (via MTProto), detects unanswered messages
- **Scheduled briefings** — can run morning summaries, evening wrap-ups, and periodic pending-reply checks on a cron schedule
- **Web browsing** — full browser automation for research, form filling, data extraction
- **General assistant** — answers questions, runs bash commands, manages files in isolated containers

## Security Model

The core principle: **the agent can read everything but write nothing without explicit approval.**

| Capability | Container (agent) | Host (NanoClaw process) |
|-----------|-------------------|------------------------|
| Read emails | Yes (`gmail.readonly` scope) | — |
| Send emails | No (scope prevents it) | — |
| Read calendar | Yes | — |
| Create calendar events | No (CLI has no write commands) | Yes, only after user taps "Create" |
| Read Telegram conversations | Yes (via host-side MTProto reader) | Yes |
| Send Telegram messages | Yes (via bot API, to registered chats only) | Yes |
| Access MTProto session | No (not mounted) | Yes |

Each group gets an isolated Docker container with its own filesystem and `CLAUDE.md` memory. Only explicitly mounted directories are accessible. IPC via filesystem.

## Calendar Approval Flow

```
Agent detects scheduling intent
  → checks calendar availability (freebusy)
  → calls propose_event MCP tool
  → host validates, saves to DB, sends inline keyboard to Telegram:

    📅 Coffee with Alice
    Wed 27 Feb, 14:00 – 14:30
    Attendees: alice@example.com

    [✅ Create]  [❌ Skip]

  → user taps Create → host calls Calendar API → event created
  → user taps Skip → proposal dismissed
```

Proposals expire after 24 hours.

## Setup

```bash
git clone https://github.com/mihaipora/zorya.git
cd zorya
npm install
claude
```

Then run `/setup`. Claude Code handles container build, Google OAuth, Telegram bot/MTProto setup, and service registration.

**Requirements:** Node.js 20+, Docker, Anthropic API key, Telegram bot token (from BotFather).

## Architecture

```
Telegram (grammy) → SQLite → Polling loop → Docker container (Claude Agent SDK) → Response
                                                  ↓
                                           IPC (filesystem)
                                                  ↓
                                    propose_event / send_message / schedule_task
                                                  ↓
                                         Host processes action
```

Key files:

| File | Purpose |
|------|---------|
| `src/index.ts` | Orchestrator: state, message loop, agent invocation |
| `src/channels/telegram.ts` | Telegram bot, inline keyboards, callback queries |
| `src/calendar-approval.ts` | OAuth token management, Calendar API event creation |
| `src/ipc.ts` | IPC watcher: messages, tasks, event proposals |
| `src/container-runner.ts` | Spawns streaming agent containers with mounts |
| `src/db.ts` | SQLite (messages, groups, sessions, event proposals) |
| `src/task-scheduler.ts` | Cron/interval/one-time scheduled tasks |
| `container/tools/google-api` | Gmail + Calendar CLI (read-only, baked into container) |
| `container/tools/telegram-reader` | Telegram conversation reader CLI |
| `container/agent-runner/src/ipc-mcp-stdio.ts` | MCP tools: send_message, schedule_task, propose_event |
| `groups/*/CLAUDE.md` | Per-group agent memory (isolated) |

## Telegram Commands

| Command | Description |
|---------|-------------|
| `/status` | Queue status, active agents, scheduled tasks |
| `/verbose` | Show tool-use progress updates while agent works |
| `/noverbose` | Only show final results |
| `/ping` | Check if bot is online |
| `/chatid` | Get chat ID for registration |

## Pulling Upstream Updates

```bash
git fetch upstream
git merge upstream/main
```

Or run `/update` inside Claude Code for guided merging.

## License

MIT
