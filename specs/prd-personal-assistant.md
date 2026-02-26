# PRD: Privacy-First Personal Assistant

**Version:** 2.1
**Status:** Phases 1–3 complete, Phase 4 next
**Architecture reference:** `architecture-summary-v3.md`

---

## 1. Overview

Build a personal AI assistant on Zorya (customized NanoClaw fork). The assistant monitors Telegram conversations and Gmail, detects pending replies and scheduling intent, and helps you stay on top of communications. It extends NanoClaw's existing architecture — single Node.js process, Docker containers, existing scheduler and memory system — rather than building parallel infrastructure.

### Core Use Cases

1. **Pending message replies** — Detect Telegram conversations where someone messaged you and you haven't replied. Send periodic summary notifications.
2. **Pending email replies** — Detect Gmail threads where the last message isn't from you. Send periodic summary notifications.
3. **Meeting scheduling** — Detect scheduling intent in messages/emails ("let's find a time"), check Google Calendar availability, propose an event to the user for approval, and create it on approval.
4. **Morning briefing** — Daily summary: today's calendar, pending replies, unread email highlights, upcoming deadlines.
5. **Evening summary** — Daily wrap-up: what happened, what's still pending.
6. **Reminders and deadline detection** — Detect deadlines and action items in emails/messages, create scheduled reminders.

### Design Principles

This PRD follows NanoClaw's philosophy:

- **Extend, don't rebuild.** Use the existing scheduler (`task-scheduler.ts`), memory system (`CLAUDE.md` files), and single-process architecture. Don't create parallel systems.
- **Agent does the work.** The agent has CLI tools (`google-api`, `telegram-reader`) baked into the container. It calls Google APIs via the `google-api` CLI — no custom Python runtime, no third-party MCP servers with excessive permissions.
- **Minimal new code.** New host-side code is limited to: Google OAuth setup script, calendar approval handler (in the existing Telegram bot), and MTProto reader (the one justified new process).
- **Application-layer write protection.** The agent's CLI tools only expose read commands. Write operations (calendar events) require explicit user approval via the host process. Firewall deferred to v2.
- **Two setup paths.** Developer setup via Claude Code (`/setup`). Client/VPS deployment via standalone `setup.sh` — deterministic, no Claude Code dependency.

---

## 2. Components to Build

### 2.1 Google OAuth Setup ✅

A small Node.js script (`scripts/google-oauth.ts`) that handles the OAuth flow for Gmail and Calendar.

**Token strategy (implemented):** A single OAuth token at `~/.google-oauth/oauth.json` with all scopes:
- `gmail.readonly` — read messages, threads, labels
- `calendar.readonly` — read calendar list and events
- `calendar.events` — read + write events
- `calendar.freebusy` — check availability

The same token file is mounted read-only into the container. The container's `google-api` CLI tool only exposes read commands (list, read, freebusy) — it has no write subcommands. Event creation only happens on the host via the calendar approval handler (`src/calendar-approval.ts`), which reads the same `oauth.json` directly from disk.

**Why a single token instead of separate read/write tokens:**
- Simpler setup — one OAuth flow, one file, no scope confusion
- Same security outcome — the container can't write because the tool doesn't expose write commands, not because the token lacks scope. The structural protection is at the application layer (CLI tool API surface), not the credential layer.
- The host needs write access anyway for the approval handler, and it reads from the same file.

**Files:**
- `~/.google-oauth/client.json` — GCP OAuth client credentials (client_id, client_secret)
- `~/.google-oauth/oauth.json` — tokens (access_token, refresh_token, token_expiry, scopes)

**OAuth flow:** Script auto-detects environment. Local machine opens browser for consent. Headless/VPS falls back to copy-paste URL flow.

**Token refresh:** The container's `google-api` CLI handles refresh internally using credentials from the mounted `oauth.json`. The host's `calendar-approval.ts` also refreshes and writes the updated token back to disk.

**Acceptance criteria:**
- [x] OAuth flow requests all needed scopes in a single flow
- [x] Container mounts `oauth.json` read-only — agent can read but not write to calendar via CLI
- [x] Host reads same `oauth.json` for calendar event creation (approval handler)
- [x] Refresh tokens persist across container restarts (host-mounted file)
- [x] Token refresh works both in container (google-api CLI) and on host (calendar-approval.ts)
- [x] OAuth works both with a local browser and headless (VPS/SSH)

---

### 2.2 Agent Tools (Gmail + Calendar) ✅

Implemented as `container/tools/google-api` — a standalone Node.js CLI baked into the container image at `/usr/local/bin/google-api`. No Python, no MCP servers.

**Commands:**
- `google-api gmail list [--query "..."] [--limit N] [--days N]` — list email threads
- `google-api gmail read <thread-id>` — read full thread with body extraction
- `google-api gmail labels` — list Gmail labels
- `google-api calendar list [--days N] [--from YYYY-MM-DD]` — list events across all calendars
- `google-api calendar today` — today's events
- `google-api calendar freebusy <email> [--days N]` — check availability
- `google-api auth test` — verify credentials

All commands support `--json` for structured output.

The CLI reads credentials from `/workspace/extra/google-oauth/oauth.json` (mounted read-only). Token refresh is handled internally with a `/tmp` cache.

**Write protection:** The CLI only exposes read commands. Even though the token has `calendar.events` write scope, the agent has no write subcommand available. Event creation goes through the `propose_event` MCP tool → host approval handler (section 2.4).

**Acceptance criteria:**
- [x] Agent can list and read emails using mounted Google credentials
- [x] Agent can list calendar events and check freebusy
- [x] Gmail API scope (`gmail.readonly`) prevents send/modify/delete
- [x] CLI exposes no write commands — event creation only via approval handler
- [x] Token refresh works transparently (cache in `/tmp`)

---

### 2.3 Telegram MTProto Reader ✅

Implemented as `container/tools/telegram-reader` — a CLI tool baked into the container that calls the host-side MTProto reader process.

The host-side reader (`~/.mtproto-reader/`) holds the MTProto userbot session and exposes a read-only localhost HTTP API. The container reaches it via `host.docker.internal`.

**Acceptance criteria:**
- [x] Container does NOT hold the MTProto session
- [x] Reader API is localhost-only
- [x] Reader provides read-only data (conversation history, pending replies)
- [x] Reader cannot be used to send messages, join groups, or modify anything
- [x] Agent can call reader API via CLI from inside the container

---

### 2.4 Calendar Approval Handler ✅

Lives in the existing NanoClaw Node.js process. The agent proposes events via the `propose_event` MCP tool, the host sends an inline keyboard to Telegram, and the user approves with a single tap.

**Implemented components:**
- `src/calendar-approval.ts` — OAuth token loading, refresh, Calendar API `events.insert`. Reads `~/.google-oauth/oauth.json` from host filesystem.
- `src/channels/telegram.ts` — `sendEventProposal()` method (inline keyboard), `callback_query:data` handler
- `src/ipc.ts` — `event_proposal` type handler with validation (title, dates, future check, authorization)
- `src/db.ts` — `event_proposals` table + CRUD functions
- `src/index.ts` — Wires callback handler (approve/skip/expiry logic), hourly `expireStaleProposals()`
- `container/agent-runner/src/ipc-mcp-stdio.ts` — `propose_event` MCP tool

**Flow:**
1. Agent detects scheduling intent, checks calendar availability
2. Agent calls `propose_event` MCP tool with title, start/end times, attendees, description
3. Host validates, saves to `event_proposals` table, sends inline keyboard to Telegram
4. User taps "Create" or "Skip"
5. On Create: host calls Calendar API `events.insert` using `oauth.json`, updates DB, edits message
6. On Skip: updates DB, edits message

**Acceptance criteria:**
- [x] Only creates events when user explicitly taps "Create"
- [x] Validates: title non-empty, start < end, start is in the future
- [x] Sends confirmation with calendar link after creation
- [x] Event creation runs on host process only, not in container
- [x] No new host-side processes — runs in existing NanoClaw process
- [x] Proposals expire after 24h (hourly cleanup)

---

### 2.5 Default Scheduled Tasks

Use NanoClaw's existing scheduler (`src/task-scheduler.ts`) for all recurring jobs. These are standard NanoClaw scheduled tasks — the agent runs in a container with CLI tools (`google-api`, `telegram-reader`) and sends results back via the existing `send_message` mechanism.

Tasks are created by telling Zorya to set them up. They use the existing schedule types: cron expressions, intervals, or one-time timestamps.

| Task | Schedule | What the Agent Does |
|------|----------|---------------------|
| **Morning briefing** | Cron: `0 7 * * 1-5` (weekdays 7am) | Calls Calendar API for today's events, Gmail API for pending emails, MTProto reader for pending Telegram replies. Composes and sends a formatted summary. |
| **Pending reply check** | Cron: `0 */2 * * 1-5` (every 2h, weekdays) | Calls Gmail API + MTProto reader for pending replies. If any, sends a summary notification. |
| **Email scan** | Cron: `5 7 * * 1-5` (weekdays 7:05am) | Searches recent emails for deadlines, action items, meeting requests. Creates reminders for deadlines. For scheduling intent, proposes events via the approval flow. |
| **Meeting detection** | Cron: `30 */2 * * 1-5` (every 2h, weekdays) | Scans recent messages and emails for scheduling intent. Checks availability, proposes events. |
| **Evening summary** | Cron: `0 18 * * 1-5` (weekdays 6pm) | Summarizes the day: events that happened, pending items still open. |

**Acceptance criteria:**
- [ ] All tasks use the existing NanoClaw scheduler, not a custom system
- [ ] Tasks are idempotent — re-running setup doesn't create duplicates
- [ ] User can modify or disable any task via natural language ("stop the evening summary", "move morning briefing to 8am")
- [ ] Tasks catch up on restart if overdue (existing scheduler behavior)

---

### 2.6 Memory

Use NanoClaw's existing memory system: `CLAUDE.md` files per group. The agent reads and writes its own `CLAUDE.md` to remember user preferences (timezone, meeting duration, working hours), recurring patterns, and corrections.

No custom SQLite memory database. No FTS5. The agent's built-in capability to read and update `CLAUDE.md` is sufficient for a personal assistant's memory needs.

**Acceptance criteria:**
- [ ] Agent remembers user timezone, preferred meeting duration, working hours
- [ ] Agent learns from corrections ("I prefer 30-minute meetings", "don't schedule before 9am")
- [ ] Memories persist across container restarts (group folder is host-mounted)

---

## 3. Data Model

### 3.1 Event Proposals (added to existing SQLite: `src/db.ts`)

```sql
CREATE TABLE IF NOT EXISTS event_proposals (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    start_time TEXT NOT NULL,          -- ISO 8601
    end_time TEXT NOT NULL,
    attendees TEXT DEFAULT '[]',       -- JSON array of email addresses
    description TEXT DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'approved', 'rejected', 'expired')),
    telegram_message_id TEXT,          -- for callback matching
    chat_jid TEXT NOT NULL,            -- which chat proposed it
    created_at TEXT NOT NULL,
    resolved_at TEXT
);
```

This is the only new table. Scheduled tasks use the existing `tasks` table. Memory uses `CLAUDE.md` files.

---

## 4. Security Constraints

These are hard requirements, not guidelines.

### 4.1 Credential Scoping

| Credential | Location | Scope | Protection Layer |
|-----------|----------|-------|-----------------|
| Google OAuth token (`oauth.json`) | Container (read-only mount) + Host | `gmail.readonly`, `calendar.readonly`, `calendar.events`, `calendar.freebusy` | Container CLI only exposes read commands; write operations only via host approval handler |
| Telegram MTProto session | Host process only (MTProto reader) | Full read access | Not mounted in container |
| Telegram Bot API token | Container (env var) | Bot messaging | Cannot read user conversations or send as user |
| Claude API key | Container (env var) | LLM calls | — |

**Note on token strategy:** The Google OAuth token has write scope (`calendar.events`) even inside the container. The security boundary is the application layer — the `google-api` CLI tool in the container has no write subcommands. Event creation is only possible through the `propose_event` MCP tool → host approval handler → user taps "Create" in Telegram. This is a deliberate trade-off: simpler setup (one token, one OAuth flow) with equivalent practical security.

### 4.2 Notification Recipient Hardening

The agent sends messages via NanoClaw's existing `send_message` IPC mechanism, which routes through the registered group's chat. The recipient is determined by the group registration, not by the agent. The agent cannot message arbitrary Telegram users.

### 4.3 What's Deferred to v2

| Item | Why Deferred |
|------|-------------|
| **Container hardening** (`--cap-drop ALL`, `--read-only`, `--no-new-privileges`) | Containers are already ephemeral (`--rm`). Hardening flags risk breaking agent functionality (npm cache, chromium, temp files) for marginal benefit on a personal assistant. |
| **Network firewall** (iptables/squid) | Credential scoping handles the main threats. Firewall adds significant ops complexity for marginal v1 benefit. |
| **Structured audit log** (JSONL) | Container logs + NanoClaw logs already capture tool calls. AI-native: "ask Claude to read the logs." |
| **DNS restriction** | Depends on firewall. |

---

## 5. Configuration

All configuration via environment variables in `.env` (NanoClaw standard).

```bash
# .env additions for personal assistant features

# Google OAuth — single token with all scopes
# Files: ~/.google-oauth/client.json, ~/.google-oauth/oauth.json
# Container mounts oauth.json read-only; host reads it directly for calendar writes

# Telegram MTProto reader
MTPROTO_READER_URL=http://localhost:8081   # host-side reader API
MTPROTO_READER_PORT=8081

# User preferences (can also be learned via CLAUDE.md)
USER_TIMEZONE=Europe/Warsaw
```

---

## 6. Development Phases

### Phase 1: Foundation ✅
- Google OAuth script (`scripts/google-oauth.ts`) — all scopes in single token
- `google-api` CLI tool baked into container image
- Mount `oauth.json` read-only into container
- Agent can call Gmail + Calendar APIs via `google-api` CLI

### Phase 2: Telegram MTProto Reader ✅
- Host-side reader process with localhost HTTP API
- `telegram-reader` CLI tool baked into container image
- Container reaches reader via `host.docker.internal`

### Phase 3: Scheduled Tasks + Calendar Approval ✅
- Calendar approval handler: `propose_event` MCP tool, inline keyboard, callback handler, Calendar API insert
- `event_proposals` table in SQLite with CRUD + 24h expiry
- `src/calendar-approval.ts` — standalone OAuth + Calendar API module on host
- Default scheduled tasks: created interactively via Zorya (morning briefing, pending check, etc.)

### Phase 4: Polish — **Next**
- Update agent `CLAUDE.md` with instructions for all tools and workflows
- Seed default scheduled tasks (morning briefing, pending replies, email scan, evening summary)
- Memory: teach agent to learn timezone, preferences, meeting habits via `CLAUDE.md`
- End-to-end testing of all scheduled tasks
- Error handling polish for API failures and edge cases

---

## 7. Setup

Two setup paths for different scenarios.

### 7.1 Developer Setup (Claude Code)

For the developer (you). Requires `claude` CLI installed.

```bash
cd zorya
claude
> /setup
```

Claude Code guides through:
1. GCP project creation, OAuth client ID setup
2. Google OAuth flow (single token with all scopes)
3. Telegram MTProto setup (phone number + verification code)
4. Default scheduled tasks creation
5. Container build and service start
6. Test notification to verify everything works

### 7.2 Client/VPS Setup (standalone script)

For deploying to a client's VPS. No Claude Code needed. Deterministic, predictable. **Status: planned — not yet implemented.** Current `setup.sh` only bootstraps npm dependencies.

```bash
ssh client-vps
git clone ... && cd zorya
npm install
./setup.sh
```

**`setup.sh` flow:**
```
./setup.sh
  │
  ├── Check prerequisites (Docker, Node.js 20+)
  │
  ├── Anthropic API key:
  │     "Enter your Anthropic API key: "
  │     → Saved to .env
  │
  ├── Telegram bot:
  │     "Enter your Telegram bot token (from @BotFather): "
  │     "Enter the Telegram chat ID for notifications: "
  │     → Saved to .env
  │
  ├── Telegram MTProto (for pending reply detection):
  │     "Enter your Telegram API ID (from my.telegram.org): "
  │     "Enter your Telegram API hash: "
  │     "Enter your phone number: "
  │     "Enter the verification code sent to your Telegram: "
  │     → MTProto session saved (host only)
  │
  ├── Google OAuth:
  │     ├── If browser available:
  │     │     "Opening browser for Google authorization..."
  │     │     → localhost callback → oauth.json saved
  │     │
  │     └── If headless (VPS/SSH):
  │           "Open this URL in your browser:"
  │           "  https://accounts.google.com/o/oauth2/auth?..."
  │           "After clicking Allow, paste the redirect URL here: "
  │           → Extract auth code → oauth.json saved
  │
  │           OR: "Already have oauth.json? Enter path (or press Enter to use URL flow): "
  │
  ├── Build container image
  │
  ├── Create default scheduled tasks
  │
  ├── Install and start systemd service
  │
  └── "✅ Assistant is running. You'll receive a test notification shortly."
```

**Acceptance criteria:**
- [ ] Non-technical user can complete setup in under 10 minutes
- [ ] Script checks prerequisites before starting
- [ ] Credentials saved with appropriate file permissions (not world-readable)
- [ ] Google OAuth works headless (copy-paste URL or local-to-VPS transfer)
- [ ] Script is idempotent — re-running updates credentials without breaking existing setup
- [ ] Sends test notification on completion
- [ ] Works on both macOS (launchd) and Linux (systemd)

---

## 8. Testing

### 8.1 Security Tests

| Test | Expected Result |
|------|----------------|
| Call Gmail API with `gmail.send` from container | 403 Forbidden — scope is `gmail.readonly` |
| Agent tries to create calendar event directly (curl) | Token has scope, but `google-api` CLI has no write command. Agent would need to craft raw curl — acceptable risk for personal assistant. |
| Agent tries to read MTProto session file | File not found — not in container |
| Agent uses `propose_event` MCP tool | Event proposal sent to host, user must tap "Create" before anything is created |

### 8.2 Functional Tests

| Test | Expected Result |
|------|----------------|
| Agent lists recent emails | Returns email summaries via Gmail API |
| Agent finds pending email replies | Returns threads where last message isn't from user |
| Agent lists today's calendar events | Returns events via Calendar API |
| Agent proposes a calendar event | User sees inline keyboard in Telegram with Create/Skip |
| User taps "Create" | Event created in Google Calendar, confirmation sent |
| User taps "Skip" | No event created, acknowledgment sent |
| Morning briefing fires at 7am | User receives summary with calendar, pending replies, emails |
| Pending reply check fires | User receives summary of unanswered messages |
| Token expires during agent run | Agent refreshes token via oauth2.googleapis.com, continues |

### 8.3 Integration Tests

| Test | Expected Result |
|------|----------------|
| Full flow: scheduling intent in email → event proposal → approval → calendar event | End to end works |
| MTProto reader returns pending Telegram replies | Agent incorporates them in briefing |
| Agent remembers user preference ("30-minute meetings") | Next proposal uses 30 minutes |
| NanoClaw restarts | Overdue scheduled tasks catch up, credentials still mounted |
