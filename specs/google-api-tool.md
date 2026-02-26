# Spec: `google-api` CLI Tool

**Status:** Ready for implementation
**PRD reference:** `prd-personal-assistant.md` — Phase 1 (Foundation) + Section 2.2 (Agent Tools)

---

## 1. Overview

A single self-contained Node.js CLI tool that runs inside the NanoClaw container, giving the Claude agent simple commands to read Gmail and Google Calendar. Replaces the raw-curl approach from the PRD with a proper tool that handles token refresh, API pagination, and output formatting automatically.

## 2. Requirements

### Functional

- Agent can list and search email threads with Gmail search syntax
- Agent can read full email threads with decoded message bodies
- Agent can filter emails by time horizon (`--days`) to support pending-reply workflows
- Agent can list calendar events across all visible calendars
- Token refresh happens automatically — agent never deals with auth
- Clean plain text output by default, `--json` for structured data
- Agent auto-discovers the tool via CLAUDE.md in the mounted credentials directory

### Non-Functional

- Zero new npm dependencies — uses only Node.js built-ins (`https`, `fs`, `path`)
- Single file, CommonJS, no build step needed
- Works with read-only credential mount (caches refreshed tokens in `/tmp/`)

### Security

- Gmail access is read-only (`gmail.readonly` scope) — tool cannot send, delete, or modify
- Calendar access is read+write (`calendar.events` scope) — matches the OAuth scopes from the setup script
- Credentials file is read-only mounted — agent cannot modify tokens on host

---

## 3. CLI Interface

```
google-api <service> <command> [options]
```

### Gmail Commands

| Command | Description |
|---------|-------------|
| `google-api gmail list` | List recent email threads (default: 10) |
| `google-api gmail list --query "is:unread"` | Search with Gmail query syntax |
| `google-api gmail list --limit 20` | Control result count (max 50) |
| `google-api gmail list --days 7` | Threads from the last N days |
| `google-api gmail read <thread-id>` | Read full thread with message bodies |
| `google-api gmail labels` | List all Gmail labels |

### Calendar Commands

| Command | Description |
|---------|-------------|
| `google-api calendar list` | Upcoming events (default: next 7 days) |
| `google-api calendar list --days 14` | Custom range |
| `google-api calendar list --from 2026-03-01 --days 3` | Specific start date |
| `google-api calendar today` | Today's events only |
| `google-api calendar freebusy <email> [email2...]` | Check availability for one or more people |
| `google-api calendar freebusy alice@example.com --days 3` | Multi-day availability check |

### Utility Commands

| Command | Description |
|---------|-------------|
| `google-api auth test` | Verify credentials work, print token status |

### Global Flags

| Flag | Description |
|------|-------------|
| `--json` | Output raw JSON instead of formatted text |
| `--limit N` | Max results for gmail list (default: 10, max: 50) |
| `--query "..."` | Gmail search query |
| `--days N` | Time horizon — gmail list: threads from last N days; calendar list: days ahead (default: 7) |
| `--from YYYY-MM-DD` | Start date for calendar list (default: today) |

---

## 4. Output Formats

### `gmail list` (plain text)

```
From: Alice Smith <alice@example.com>
Date: 2026-02-25 14:30
Subject: Meeting tomorrow
Snippet: Hey, just wanted to confirm our meeting...
---
From: Bob <bob@work.com>
Date: 2026-02-25 10:15
Subject: Q1 Report
Snippet: Please review the attached...
```

### `gmail read` (plain text)

```
Thread: 18d7a3b2c4e5f6g7
Messages: 3

[1] From: Alice Smith <alice@example.com>
    Date: 2026-02-24 09:00
    Subject: Meeting tomorrow

    Hey, just wanted to confirm our meeting tomorrow at 2pm.
    Does that still work for you?

[2] From: Me
    Date: 2026-02-24 09:30

    Yes, 2pm works. See you then!

[3] From: Alice Smith <alice@example.com>
    Date: 2026-02-25 14:30

    Great, see you there!
```

### `calendar list` / `calendar today` (plain text)

```
Today: Wednesday, Feb 26, 2026

09:00 - 09:30  Team standup
               Calendar: Work
10:00 - 11:00  1:1 with Alice
               Location: Room 3B
               Calendar: Work
14:00 - 15:00  Dentist appointment
               Calendar: Personal

No more events.
```

All-day events display as:

```
All day         Company holiday
                Calendar: Work
```

### Error output

Errors go to stderr, exit code 1. Stdout is reserved for data.

```
Error: Google OAuth credentials not found at /workspace/extra/google-oauth/oauth.json
Run the setup script: npx tsx scripts/google-oauth.ts
```

---

## 5. Architecture

### Token refresh with read-only mount

```
/workspace/extra/google-oauth/oauth.json  (read-only mount)
    │
    ├── Contains: client_id, client_secret, refresh_token, access_token, token_expiry
    │
    └── Tool reads this on every invocation
            │
            ├── Token valid? → Use it
            │
            └── Token expired? → Refresh via oauth2.googleapis.com/token
                                     │
                                     └── Cache new token at /tmp/google-api-cache.json
                                         (writable, lost when container restarts — that's fine)
```

Expiry check includes a 5-minute buffer to avoid using tokens that are about to expire.

### Gmail API endpoints used

| Endpoint | Purpose |
|----------|---------|
| `GET /gmail/v1/users/me/threads?q=&maxResults=` | List/search threads |
| `GET /gmail/v1/users/me/threads/<id>?format=FULL` | Read thread with bodies |
| `GET /gmail/v1/users/me/labels` | List labels |
| `GET /gmail/v1/users/me/profile` | Auth test |

### `--days` for gmail list

When `--days N` is passed to `gmail list`, the tool prepends `after:YYYY/MM/DD` to the query (computing the date N days ago). This combines with any explicit `--query` — e.g., `google-api gmail list --days 7 --query "in:inbox"` becomes `after:2026/02/19 in:inbox`.

### Calendar API endpoints used

| Endpoint | Purpose |
|----------|---------|
| `GET /calendar/v3/users/me/calendarList` | Discover all calendars |
| `GET /calendar/v3/calendars/<id>/events?timeMin=&timeMax=&singleEvents=true&orderBy=startTime` | List events per calendar |

Calendar queries all visible calendars, merges events, sorts by start time, groups by day in output.

### MIME body extraction

For `gmail read`, the tool walks the MIME tree:
1. Prefer `text/plain` parts
2. Fall back to `text/html` with tag stripping (simple regex, no dependency)
3. Handle nested multipart (e.g., `multipart/alternative` inside `multipart/mixed`)
4. Decode base64url encoding

### Thread ID vs Message ID

`gmail read` tries fetching as a thread ID first. If 404, tries as a message ID, extracts its `threadId`, then fetches the full thread. This way the agent can pass either.

---

## 6. Files to Create/Modify

| File | Action | Description |
|------|--------|-------------|
| `container/tools/google-api` | **Create** | The CLI tool (~600 lines Node.js, CommonJS, shebang) |
| `container/Dockerfile` | **Modify** | Add COPY + chmod for the tool (2 lines, before `USER node`) |
| `scripts/google-oauth.ts` | **Modify** | Add CLAUDE.md generation in `~/.google-oauth/` after saving tokens |

### Dockerfile change

Insert before `USER node` (line 62):

```dockerfile
# Copy CLI tools
COPY tools/google-api /usr/local/bin/google-api
RUN chmod +x /usr/local/bin/google-api
```

### google-oauth.ts change

After saving `oauth.json`, also write `~/.google-oauth/CLAUDE.md` with tool documentation. The agent-runner auto-discovers CLAUDE.md files in `/workspace/extra/*/CLAUDE.md` and loads them into the agent's system prompt — so the agent learns about the tool automatically.

---

## 7. CLAUDE.md Content (agent-facing docs)

Written to `~/.google-oauth/CLAUDE.md` by the OAuth script. Auto-discovered by the agent-runner.

```markdown
# Google API — Gmail & Calendar Access

The `google-api` CLI tool provides access to the user's Gmail (read-only) and Calendar.

## Commands

### Gmail

# List recent email threads (default: 10)
google-api gmail list

# Search with Gmail query syntax
google-api gmail list --query "from:alice subject:meeting"
google-api gmail list --query "is:unread" --limit 20

# Read a full email thread
google-api gmail read <thread-id>

# Threads from the last 7 days (useful for pending-reply checks)
google-api gmail list --days 7

# List all Gmail labels
google-api gmail labels

### Calendar

# List upcoming events (default: next 7 days)
google-api calendar list

# Today's events only
google-api calendar today

# Specific range
google-api calendar list --from 2026-03-01 --days 3

### Utility

# Verify credentials work
google-api auth test

## Flags

--json     Output raw JSON instead of formatted text (any command)
--limit N  Max results for gmail list (default: 10, max: 50)
--query    Gmail search query (full Gmail search syntax)
--days N   gmail list: threads from last N days; calendar list: days ahead (default: 7)
--from     Start date for calendar list (default: today)

## Gmail Search Examples

is:unread                           Unread messages
from:alice@example.com              From specific sender
subject:invoice                     Subject contains word
after:2026/02/01 before:2026/02/28  Date range
has:attachment filename:pdf         With PDF attachments
in:inbox -category:promotions       Inbox minus promotions

## Common Patterns

Find emails needing reply:  google-api gmail list --days 7 --query "in:inbox"
                            then: google-api gmail read <thread-id> for each
Check today's schedule:     google-api calendar today
Check availability:         google-api calendar freebusy alice@example.com --from 2026-03-05 --days 1
Search person's emails:     google-api gmail list --query "from:alice" --limit 5

## Notes

- Gmail access is read-only — cannot send, delete, or modify emails
- Calendar access allows reading events
- Token refresh is automatic
- Errors go to stderr with exit code 1
```

---

## 8. Error Handling

| Condition | Behavior |
|-----------|----------|
| `oauth.json` missing | stderr: clear error + setup instructions, exit 1 |
| Token refresh fails (revoked) | stderr: Google's error + re-run suggestion, exit 1 |
| Cache write fails | stderr warning, continue with existing token |
| Empty results | `No messages found.` / `No events in this period.` |
| API rate limit (429) | stderr: rate limit message, exit 1 |
| Network error | stderr: human-readable message, exit 1 |
| Invalid command | stderr: usage help, exit 1 |

---

## 9. Verification

### Build and test manually

```bash
# Rebuild container with the new tool
./container/build.sh

# Start a test shell inside the container with credentials mounted
docker run -it --rm \
  -v ~/.google-oauth:/workspace/extra/google-oauth:ro \
  nanoclaw-agent:latest bash

# Inside the container:
google-api auth test
google-api gmail labels
google-api gmail list
google-api gmail list --query "is:unread" --limit 5
google-api gmail read <thread-id-from-list-output>
google-api gmail list --days 7 --query "in:inbox"
google-api calendar today
google-api calendar list --days 14
google-api calendar list --json
```

### Test via the agent

Restart the bot, then message Zorya:
- "Test your Google API access"
- "What's on my calendar today?"
- "Show me my unread emails"
- "What emails do I need to reply to?" (agent uses gmail list --days 7 + gmail read, then judges which need replies)

### Security verification

```bash
# Inside the container — these should all fail with 403:
# (the tool won't expose write operations, but verifying the scope)
curl -H "Authorization: Bearer $(google-api auth test --json | node -e "process.stdin.on('data',d=>console.log(JSON.parse(d).access_token))")" \
  -X POST "https://gmail.googleapis.com/gmail/v1/users/me/messages/send" \
  -d '{}'
# Expected: 403 Insufficient Permission
```
