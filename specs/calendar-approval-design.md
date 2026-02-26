# Design: Calendar Approval Handler

**Status:** Ready for implementation
**PRD reference:** `prd-personal-assistant.md` — Section 2.4
**Depends on:** Phase 1 (Google OAuth + API tools) — done

---

## 1. Overview

The agent can read the user's Google Calendar but cannot create events — the container only has read access. The calendar approval handler bridges this gap: the agent proposes an event via IPC, the host process sends an inline keyboard to Telegram, and the user approves or skips with a single tap. On approval, the host process creates the event using the existing OAuth token (which already has `calendar.events` write scope).

No new OAuth flow needed. No new host-side processes. Everything runs in the existing NanoClaw process.

---

## 2. Flow

```
Agent (container)                    Host (NanoClaw)                     User (Telegram)
      │                                    │                                    │
      │ 1. Detects scheduling intent       │                                    │
      │    checks calendar availability    │                                    │
      │                                    │                                    │
      │ 2. IPC: propose_event              │                                    │
      │    {title, start, end, attendees}  │                                    │
      │ ──────────────────────────────────→│                                    │
      │                                    │ 3. Validate proposal               │
      │                                    │ 4. Save to event_proposals table   │
      │                                    │                                    │
      │                                    │ 5. Send inline keyboard            │
      │                                    │───────────────────────────────────→│
      │                                    │    📅 Meeting with Alice            │
      │                                    │    Tue Feb 27, 14:00 – 15:00      │
      │                                    │    [✅ Create]  [❌ Skip]           │
      │                                    │                                    │
      │                                    │                    6. User taps    │
      │                                    │←───────────────────────────────────│
      │                                    │                                    │
      │                                    │ 7. On "Create":                    │
      │                                    │    - Load OAuth token from host    │
      │                                    │    - Call Calendar events.insert   │
      │                                    │    - Update proposal → approved    │
      │                                    │    - Edit message → "Created ✅"   │
      │                                    │                                    │
      │                                    │    On "Skip":                      │
      │                                    │    - Update proposal → rejected    │
      │                                    │    - Edit message → "Skipped"      │
```

---

## 3. Components

### 3.1 MCP Tool: `propose_event`

**File:** `container/agent-runner/src/ipc-mcp-stdio.ts`

New MCP tool alongside existing `send_message` and `schedule_task`. Writes a JSON file to `/workspace/ipc/messages/` with `type: 'event_proposal'`.

**Parameters:**

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `title` | string | yes | Event title |
| `startTime` | string | yes | ISO 8601 local datetime (e.g., `2026-02-27T14:00:00`) |
| `endTime` | string | yes | ISO 8601 local datetime |
| `attendees` | string[] | no | Email addresses to invite |
| `description` | string | no | Event description/notes |
| `location` | string | no | Event location |

**IPC payload:**

```json
{
  "type": "event_proposal",
  "chatJid": "tg:123456789",
  "groupFolder": "main",
  "title": "Meeting with Alice",
  "startTime": "2026-02-27T14:00:00",
  "endTime": "2026-02-27T15:00:00",
  "attendees": ["alice@example.com"],
  "description": "Discuss Q1 planning",
  "location": "",
  "timestamp": "2026-02-26T18:00:00.000Z"
}
```

**Tool description for the agent:**

```
Propose a calendar event for user approval. The user will see an inline keyboard
in Telegram with Create/Skip buttons. You cannot create events directly — use
this tool and the user will approve or skip. Include all relevant details:
title, start/end times, attendees, and description.
```

### 3.2 SQLite Table: `event_proposals`

**File:** `src/db.ts`

```sql
CREATE TABLE IF NOT EXISTS event_proposals (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    start_time TEXT NOT NULL,
    end_time TEXT NOT NULL,
    attendees TEXT DEFAULT '[]',
    description TEXT DEFAULT '',
    location TEXT DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK(status IN ('pending', 'approved', 'rejected', 'expired')),
    telegram_message_id TEXT,
    chat_jid TEXT NOT NULL,
    created_at TEXT NOT NULL,
    resolved_at TEXT
);
```

**DB functions:**

- `createEventProposal(proposal)` — insert a new proposal
- `getEventProposal(id)` — get by ID
- `updateEventProposalStatus(id, status, telegramMessageId?)` — update status + resolved_at
- `expireStaleProposals()` — set status='expired' where status='pending' AND created_at < 24h ago

### 3.3 IPC Handler

**File:** `src/ipc.ts`

In the existing message file processing loop, add a branch for `type: 'event_proposal'`:

```
if (data.type === 'event_proposal') {
    1. Validate: title non-empty, startTime < endTime, startTime in the future
    2. Generate proposal ID (e.g., `prop-{timestamp}-{random}`)
    3. Save to event_proposals table (status: 'pending')
    4. Call deps.sendEventProposal(data.chatJid, proposal)
}
```

The `sendEventProposal` callback is a new dependency — the Telegram channel implements it.

### 3.4 Inline Keyboard

**File:** `src/channels/telegram.ts`

New method `sendEventProposal(jid, proposal)`:

```typescript
import { InlineKeyboard } from 'grammy';

async sendEventProposal(jid: string, proposal: EventProposal): Promise<string | undefined> {
    const numericId = jid.replace(/^tg:/, '');

    const startDate = new Date(proposal.start_time);
    const endDate = new Date(proposal.end_time);
    const dateStr = startDate.toLocaleDateString('en-GB', {
        weekday: 'short', day: 'numeric', month: 'short'
    });
    const startStr = startDate.toLocaleTimeString('en-GB', {
        hour: '2-digit', minute: '2-digit'
    });
    const endStr = endDate.toLocaleTimeString('en-GB', {
        hour: '2-digit', minute: '2-digit'
    });

    let text = `📅 *${proposal.title}*\n${dateStr}, ${startStr} – ${endStr}`;
    if (proposal.attendees.length > 0) {
        text += `\nAttendees: ${proposal.attendees.join(', ')}`;
    }
    if (proposal.location) {
        text += `\nLocation: ${proposal.location}`;
    }
    if (proposal.description) {
        text += `\n\n${proposal.description}`;
    }

    const keyboard = new InlineKeyboard()
        .text('✅ Create', `event:approve:${proposal.id}`)
        .text('❌ Skip', `event:skip:${proposal.id}`);

    const msg = await this.bot.api.sendMessage(numericId, text, {
        parse_mode: 'Markdown',
        reply_markup: keyboard,
    });

    return msg.message_id.toString();
}
```

Returns the Telegram message ID so it can be stored in the proposal row (for later editing).

### 3.5 Callback Query Handler

**File:** `src/channels/telegram.ts`

Register during `connect()`, after existing command handlers:

```typescript
this.bot.on('callback_query:data', async (ctx) => {
    const data = ctx.callbackQuery.data;
    if (!data.startsWith('event:')) return;

    const [, action, proposalId] = data.split(':');
    // action is 'approve' or 'skip'

    await this.opts.onEventCallback(proposalId, action, ctx);
});
```

The actual Calendar API call and DB update happen in the callback provided by the host process (`onEventCallback`), not in the Telegram channel itself. This keeps the channel thin and the business logic in `src/index.ts` or a dedicated `src/calendar-approval.ts` module.

### 3.6 Calendar API Call

**File:** `src/calendar-approval.ts` (new)

Standalone module that:
1. Loads OAuth credentials from `~/.google-oauth/oauth.json` (same file the container uses, but read from the host)
2. Refreshes the access token if expired (using client credentials embedded in `oauth.json`)
3. Calls `POST https://www.googleapis.com/calendar/v3/calendars/primary/events`

```typescript
export async function createCalendarEvent(proposal: EventProposal): Promise<{ eventId: string; htmlLink: string }> {
    const token = await getAccessToken();  // refresh if needed

    const event = {
        summary: proposal.title,
        description: proposal.description,
        location: proposal.location,
        start: { dateTime: proposal.start_time, timeZone: TIMEZONE },
        end: { dateTime: proposal.end_time, timeZone: TIMEZONE },
        attendees: proposal.attendees.map(email => ({ email })),
    };

    // POST to Calendar API using node:https
    const response = await calendarApiPost('/calendar/v3/calendars/primary/events', token, event);
    return { eventId: response.id, htmlLink: response.htmlLink };
}
```

This is the only place in the host codebase that writes to Google Calendar.

### 3.7 Callback Handler Logic

**File:** `src/index.ts` (or `src/calendar-approval.ts`)

Wired into the Telegram channel's `onEventCallback` option:

```
onEventCallback(proposalId, action, ctx):
    1. Load proposal from DB
    2. If not found or status !== 'pending':
         ctx.answerCallbackQuery("This proposal has already been handled.")
         return
    3. If expired (created_at > 24h ago):
         Update status → 'expired'
         Edit message → "⏰ Proposal expired"
         ctx.answerCallbackQuery("Expired")
         return
    4. If action === 'approve':
         Validate startTime is still in the future
         Call createCalendarEvent(proposal)
         Update status → 'approved'
         Edit message → "✅ Event created: {title}"
         ctx.answerCallbackQuery("Event created!")
    5. If action === 'skip':
         Update status → 'rejected'
         Edit message → "❌ Skipped: {title}"
         ctx.answerCallbackQuery("Skipped")
```

"Edit message" uses `ctx.editMessageText(newText)` to replace the original inline keyboard message with the result. The buttons disappear.

### 3.8 Proposal Expiry

**File:** `src/task-scheduler.ts` or `src/index.ts`

A periodic check (piggyback on the existing scheduler loop or a simple `setInterval`) that runs `expireStaleProposals()` every hour. This updates any `pending` proposals older than 24h to `expired`. No Telegram message edit needed for expired proposals — the buttons just stop working (the callback handler checks).

---

## 4. Files to Create/Modify

| File | Change |
|------|--------|
| `src/calendar-approval.ts` | **Create.** OAuth token loading, token refresh, Calendar API insert. |
| `src/db.ts` | **Modify.** Add `event_proposals` table + CRUD functions. |
| `src/ipc.ts` | **Modify.** Handle `type: 'event_proposal'` in message processing. Add `sendEventProposal` to deps interface. |
| `src/channels/telegram.ts` | **Modify.** Add `sendEventProposal()` method, `callback_query` handler, `onEventCallback` option. |
| `src/index.ts` | **Modify.** Wire `onEventCallback` handler, pass to Telegram channel. |
| `container/agent-runner/src/ipc-mcp-stdio.ts` | **Modify.** Add `propose_event` MCP tool. |
| `~/.mtproto-reader/docs/CLAUDE.md` or group CLAUDE.md | **Modify.** Document the `propose_event` tool for the agent. |

---

## 5. OAuth Token Reuse

The existing `scripts/google-oauth.ts` already requests `calendar.events` scope (full read+write). The token at `~/.google-oauth/oauth.json` has write access. The host process reads this file directly — no second OAuth flow needed.

The container mounts the `~/.google-oauth` directory (read-only), but the container's `google-api` CLI tool only uses read endpoints. The write scope is harmless in the container since the CLI tool doesn't expose write commands, but the structural protection is that **event creation only happens on the host** through the approval handler.

---

## 6. Validation Rules

Applied in the IPC handler (step 3.3) before saving the proposal:

| Rule | Error |
|------|-------|
| Title is non-empty | "Event title is required" |
| startTime parses as valid date | "Invalid start time" |
| endTime parses as valid date | "Invalid end time" |
| startTime < endTime | "Start time must be before end time" |
| startTime is in the future | "Start time must be in the future" |
| attendees (if provided) are email-shaped | "Invalid attendee email: {x}" |

Validation errors are logged and the proposal is not created. The agent receives no feedback (IPC is fire-and-forget for messages), but this is fine — the agent already validated on its side before proposing.

---

## 7. Error Handling

| Condition | Behavior |
|-----------|----------|
| OAuth token expired | Refresh using client credentials, retry once |
| Token refresh fails | Edit message: "❌ Failed to create event (auth error). Re-run Google OAuth setup." |
| Calendar API error (quota, invalid, etc.) | Edit message: "❌ Failed: {error message}" |
| Proposal not found in DB | `answerCallbackQuery("This proposal is no longer available.")` |
| Proposal already resolved | `answerCallbackQuery("Already handled.")` |
| Start time has passed by approval time | Edit message: "⏰ Can't create — the start time has passed." Status → expired. |
| Network error calling Calendar API | Edit message: "❌ Failed to create event (network error). Try again later." |

---

## 8. Security

- **Write token stays on host.** The `oauth.json` file is mounted read-only in the container, but the Calendar API write call happens in the NanoClaw host process, not in the container.
- **User must explicitly approve.** No event is created without the user tapping "Create".
- **Callback data is proposal-ID-scoped.** Each button references a specific proposal ID. No way to create arbitrary events via callback manipulation.
- **Proposals expire.** Stale proposals can't be approved after 24h.
- **Recipient is fixed.** Events are created on the authenticated user's primary calendar — the agent can't target arbitrary calendars.
