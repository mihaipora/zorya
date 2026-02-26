# Spec: Telegram MTProto Reader

**Status:** Ready for implementation
**PRD reference:** `prd-personal-assistant.md` — Phase 2 (Telegram MTProto Reader) + Section 2.3

---

## 1. Overview

A standalone host-side Node.js HTTP server that holds the GramJS MTProto session and exposes read-only conversation data on localhost. The agent accesses it from inside the container via a CLI tool that calls the HTTP API through `host.docker.internal`.

The MTProto session has full Telegram access (send, delete, join groups) — it stays on the host and never enters the container. Only read-only JSON responses cross the boundary.

---

## 2. Requirements

### Functional

- Agent can list chats with pending replies (last message isn't from the user)
- Agent can read recent messages from any conversation
- One-time interactive setup: phone number + verification code
- Session persists across restarts
- Agent auto-discovers the tool via CLAUDE.md in the mounted directory

### Non-Functional

- Localhost-only HTTP binding — not reachable from the network
- Independent process from NanoClaw — can restart without affecting the bot
- GramJS as the only significant dependency (npm: `telegram`)

### Security

- MTProto session file stays on the host (`~/.mtproto-reader/session`)
- API ID and API hash stay on the host
- No write endpoints — the HTTP API cannot send, delete, or modify anything
- Container only receives JSON over HTTP via `host.docker.internal`

---

## 3. Host-Side Components

### Setup script: `scripts/mtproto-reader-setup.ts`

One-time interactive setup. Run with `npx tsx scripts/mtproto-reader-setup.ts`.

1. Prompt for API ID and API hash (from https://my.telegram.org)
2. Prompt for phone number
3. GramJS initiates MTProto login, sends verification code to Telegram
4. Prompt for verification code (and 2FA password if enabled)
5. Save session string to `~/.mtproto-reader/session`
6. Save API ID and API hash to `~/.mtproto-reader/config.json`
7. Write `~/.mtproto-reader/docs/CLAUDE.md` with tool documentation
8. Add `~/.mtproto-reader/docs` to mount allowlist (read-only — no credentials are mounted)
9. Update DB `container_config`: add mount for `~/.mtproto-reader/docs`
10. Print service installation instructions

### Server: `src/mtproto-reader.ts`

Compiles to `dist/mtproto-reader.js` via the existing `tsc` build. Standalone entry point.

```
node dist/mtproto-reader.js
```

1. Load session from `~/.mtproto-reader/session`
2. Load config from `~/.mtproto-reader/config.json`
3. Connect to Telegram via GramJS
4. Start HTTP server on `127.0.0.1:8081`
5. Log ready message

### Configuration

```json
// ~/.mtproto-reader/config.json
{
  "apiId": 12345678,
  "apiHash": "abc123...",
  "port": 8081
}
```

### Session persistence

GramJS supports string sessions. The session string is saved to `~/.mtproto-reader/session` as a plain text file. On startup, the server loads the session string and reconnects without re-authentication.

---

## 4. HTTP API

Base URL: `http://127.0.0.1:8081`

All responses are JSON. Errors return `{ "error": "message" }` with appropriate HTTP status codes.

### `GET /pending-replies`

Returns dialogs where the last message is not from the authenticated user, sorted by most recent first.

**Query parameters:**

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `limit` | int | 20 | Max dialogs to return (max 50) |

**Response:**

```json
[
  {
    "chatId": "-1001234567890",
    "chatName": "Alice",
    "chatType": "private",
    "lastMessage": {
      "sender": "Alice",
      "text": "Hey, are we still meeting tomorrow?",
      "date": "2026-02-26T14:30:00Z"
    },
    "unreadCount": 2
  }
]
```

**Logic:**
1. Fetch recent dialogs via `client.getDialogs({ limit })`
2. Filter to dialogs where:
   - `dialog.unreadCount > 0`, OR
   - Last message sender is not the authenticated user
3. Exclude dialogs with bots, channels (broadcast), and service messages
4. Return chat metadata + last message preview

### `GET /conversation/:chatId`

Returns recent messages from a specific chat.

**Query parameters:**

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `limit` | int | 20 | Max messages to return (max 100) |

**URL parameters:**

| Param | Type | Description |
|-------|------|-------------|
| `chatId` | string | Telegram chat ID (numeric, can be negative for groups) |

**Response:**

```json
{
  "chatId": "-1001234567890",
  "chatName": "Alice",
  "messages": [
    {
      "id": 12345,
      "sender": "Alice",
      "text": "Hey, are we still meeting tomorrow?",
      "date": "2026-02-26T14:30:00Z",
      "replyTo": null
    },
    {
      "id": 12344,
      "sender": "Me",
      "text": "Let me check my calendar",
      "date": "2026-02-26T14:25:00Z",
      "replyTo": null
    }
  ]
}
```

**Logic:**
1. Resolve the chat entity from `chatId`
2. Fetch messages via `client.getMessages(entity, { limit })`
3. For each message: extract sender name, text content, timestamp, reply reference
4. Media messages: include `"[Photo]"`, `"[Document: filename.pdf]"`, `"[Voice message]"` etc. as text placeholders
5. Return newest first

### `GET /health`

Returns server status. Used by the container CLI tool to check connectivity.

**Response:**

```json
{
  "status": "ok",
  "connected": true,
  "user": "YourName"
}
```

### Error responses

| Status | When |
|--------|------|
| 400 | Invalid parameters (non-numeric chatId, limit out of range) |
| 404 | Chat not found |
| 503 | Not connected to Telegram (session expired, network issue) |

---

## 5. Container-Side CLI Tool

### File: `container/tools/telegram-reader`

Single self-contained Node.js script (CommonJS, shebang `#!/usr/bin/env node`). Zero dependencies — uses only `http` and `process` built-ins. Calls the host-side HTTP API via `host.docker.internal:8081`.

### CLI interface

```
telegram-reader <command> [options]
```

| Command | Description |
|---------|-------------|
| `telegram-reader pending` | Chats awaiting your reply |
| `telegram-reader pending --limit 5` | Limit results |
| `telegram-reader conversation <chatId>` | Read messages from a chat |
| `telegram-reader conversation <chatId> --limit 50` | More messages |
| `telegram-reader health` | Check if the reader is running |

### Global flags

| Flag | Description |
|------|-------------|
| `--json` | Output raw JSON instead of formatted text |
| `--limit N` | Max results (default: 20) |

### Output formats

#### `pending` (plain text)

```
Alice (private) — 2 unread
  "Hey, are we still meeting tomorrow?"
  Feb 26, 14:30
---
Work Group (group) — 5 unread
  "Can someone review the PR?"
  Feb 26, 13:15
---
```

#### `conversation <chatId>` (plain text)

```
Chat: Alice

[14:30] Alice:
  Hey, are we still meeting tomorrow?

[14:25] Me:
  Let me check my calendar

[14:20] Alice:
  I was thinking 2pm at the usual place
```

### Host resolution

The tool tries `host.docker.internal:8081` first (macOS Docker). If that fails, falls back to `172.17.0.1:8081` (Linux Docker bridge gateway). The host address can also be overridden via the `MTPROTO_READER_HOST` environment variable.

### Error handling

| Condition | Behavior |
|-----------|----------|
| Reader not running | stderr: "MTProto reader is not running. Start it on the host.", exit 1 |
| Reader not connected | stderr: "MTProto reader is not connected to Telegram.", exit 1 |
| Chat not found | stderr: "Chat not found: <chatId>", exit 1 |
| Network error | stderr: human-readable message, exit 1 |

---

## 6. Dockerfile Change

Insert alongside the existing `google-api` COPY:

```dockerfile
COPY tools/telegram-reader /usr/local/bin/telegram-reader
RUN chmod +x /usr/local/bin/telegram-reader
```

---

## 7. CLAUDE.md Content

Written to `~/.mtproto-reader/CLAUDE.md` by the setup script. Auto-discovered by the agent-runner via `/workspace/extra/mtproto-reader/CLAUDE.md`.

```markdown
# Telegram Reader — Conversation Access

The `telegram-reader` CLI tool provides read-only access to the user's Telegram conversations.

## Commands

```bash
# List chats where you have pending replies
telegram-reader pending

# Limit results
telegram-reader pending --limit 5

# Read messages from a specific chat
telegram-reader conversation <chatId>

# More messages
telegram-reader conversation <chatId> --limit 50

# Check if the reader is running
telegram-reader health
```

## Flags

| Flag | Description |
|------|-------------|
| `--json` | Output raw JSON instead of formatted text |
| `--limit N` | Max results (default: 20, max: 50 for pending, 100 for conversation) |

## Common Patterns

- **Check pending replies:** `telegram-reader pending`
- **Read conversation context:** `telegram-reader conversation <chatId>` (use chatId from pending output)
- **Morning briefing:** combine `telegram-reader pending` + `google-api gmail list --days 1` + `google-api calendar today`

## Notes

- Read-only — cannot send, delete, or modify messages
- Chat IDs are numeric (can be negative for groups)
- Media messages show as placeholders: [Photo], [Document: file.pdf], [Voice message]
```

---

## 8. Mount Configuration

Only `~/.mtproto-reader/docs/` is mounted into the container (read-only). This directory contains only `CLAUDE.md` — the session file and config.json stay in the parent directory and are never mounted.

Mount allowlist entry:
```json
{
  "path": "~/.mtproto-reader/docs",
  "allowReadWrite": false,
  "description": "MTProto reader docs (read-only)"
}
```

DB container_config entry:
```json
{
  "hostPath": "~/.mtproto-reader/docs",
  "containerPath": "mtproto-reader",
  "readonly": true
}
```

---

## 9. Service Configuration

The setup script (`scripts/mtproto-reader-setup.ts`) prints platform-specific service installation instructions with resolved paths. The service runs `node dist/mtproto-reader.js` (compiled TypeScript).

### macOS (launchd)

File: `~/Library/LaunchAgents/com.nanoclaw-mtproto-reader.plist`

The setup script generates the plist with the correct `node` path, project directory, and log paths.

### Linux (systemd)

File: `~/.config/systemd/user/nanoclaw-mtproto-reader.service`

The setup script generates the unit file with the correct `node` path and project directory.

---

## 10. Error Handling

| Condition | Behavior |
|-----------|----------|
| Session file missing | Log error, exit 1 with setup instructions |
| Session expired (Telegram revoked) | Log error, return 503 on all endpoints, print re-setup instructions |
| GramJS disconnect | Auto-reconnect (GramJS built-in). Return 503 while disconnected |
| Port 8081 in use | Log error, exit 1 |
| Invalid API ID/hash | Fail during setup with clear error message |
| 2FA required during setup | Prompt for password |

---

## 11. Verification

### Setup and manual test

```bash
# One-time setup
npx tsx scripts/mtproto-reader-setup.ts

# Build and start server
npm run build
node dist/mtproto-reader.js

# Rebuild container
./container/build.sh

# Test from container
docker run --rm --entrypoint bash nanoclaw-agent:latest \
  -c "telegram-reader health"
docker run --rm --entrypoint bash nanoclaw-agent:latest \
  -c "telegram-reader pending --limit 5"
docker run --rm --entrypoint bash nanoclaw-agent:latest \
  -c "telegram-reader conversation <chatId> --limit 10"
```

### End-to-end via the agent

Restart the bot, then message Zorya:
- "Check my pending Telegram replies"
- "What messages am I behind on?"
- "Give me a morning briefing" (combines telegram-reader + google-api)

### Security verification

```bash
# Verify session file is NOT in the container
docker run --rm --entrypoint bash \
  -v ~/.mtproto-reader/docs:/workspace/extra/mtproto-reader:ro \
  nanoclaw-agent:latest \
  -c "find /workspace/extra/mtproto-reader -type f"
# Should only show CLAUDE.md

# Verify no write endpoints exist
curl -X POST http://localhost:8081/send-message 2>&1
# Should return 404

curl -X DELETE http://localhost:8081/conversation/12345 2>&1
# Should return 404
```
