# Integrations

All integrations beyond the core Telegram bot are optional. The agent works without any of them — each one adds a capability that the agent can use when available and ignores when absent.

## Overview

| Integration | What it adds | Setup |
|---|---|---|
| [Google API](#google-api) | Gmail reading, calendar reading, event creation | OAuth script + GCP project |
| [Calendar approval](#calendar-approval) | Inline keyboard approval for calendar events | Automatic (after Google API) |
| [Telegram conversations](#telegram-conversations) | Read personal Telegram message history | MTProto setup script |
| [Voice transcription](#voice-transcription) | Transcribe Telegram voice messages to text | Add API key to `.env` |
| [Browser automation](#browser-automation) | Web browsing, form filling, data extraction | Baked into container |

## Google API

Read-only access to Gmail and Google Calendar from inside the container via the `google-api` CLI tool.

**How it works:**

```
Agent runs google-api CLI inside container
  → CLI reads OAuth tokens from mounted ~/.google-oauth/oauth.json
  → refreshes access token if expired (tokens cached in /tmp)
  → calls Gmail/Calendar API directly over HTTPS
  → returns formatted text or JSON
```

Available commands:

```bash
google-api gmail list              # recent threads (default: 7 days)
google-api gmail list --days 1     # narrow time window
google-api gmail search "query"    # search Gmail
google-api gmail thread <id>       # full thread with decoded bodies
google-api calendar today          # today's events
google-api calendar upcoming       # next 7 days
google-api calendar freebusy <email> # check someone's availability
```

**Prerequisites:** A Google Cloud project with Gmail API and Calendar API enabled.

**Setup:**

```bash
npx tsx scripts/google-oauth.ts ~/Downloads/client_secret_*.json
```

Opens a browser for Google sign-in, saves OAuth tokens to `~/.google-oauth/oauth.json`, and configures the container mount automatically.

See [GOOGLE-OAUTH.md](GOOGLE-OAUTH.md) for the full walkthrough (GCP project creation, consent screen, troubleshooting).

**Files created:**

| File | Purpose |
|---|---|
| `~/.google-oauth/oauth.json` | OAuth tokens (mounted read-only into container) |
| `~/.google-oauth/client.json` | GCP client credentials |

**Security:** The container gets read-only access to the OAuth file. The `gmail.readonly` scope prevents the agent from sending emails. Calendar write access is only used by the host process for approved events (see Calendar Approval below).

## Calendar Approval

Lets the agent propose calendar events. The user approves or skips via inline keyboard buttons in Telegram.

**Setup:** None — works automatically once Google API is configured. The Google OAuth scope `calendar.events` gives the host process write access to create events after user approval.

**How it works:**

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

## Telegram Conversations

Read-only access to the user's personal Telegram conversations. Uses a separate MTProto session (personal account), not the bot API.

**How it works:**

```
Agent runs telegram-reader CLI inside container
  → CLI calls host HTTP API on localhost:8081
  → host-side MTProto reader queries Telegram via GramJS
  → returns conversations, pending replies, or message history
```

The host holds the MTProto session and exposes a read-only HTTP API. The container CLI tool is a thin HTTP client — it never sees credentials.

Available commands:

```bash
telegram-reader conversations              # recent chats (default: 7 days)
telegram-reader conversations --days 1     # narrow time window
telegram-reader pending                    # chats awaiting your reply
telegram-reader conversation <chatId>      # read messages from a chat
telegram-reader health                     # check if reader is running
```

**Prerequisites:** A Telegram API app from https://my.telegram.org (API ID and hash).

**Setup:**

```bash
npx tsx scripts/mtproto-reader-setup.ts
```

Prompts for API credentials, phone number, and verification code. Saves credentials to `.env` and the session to `data/mtproto-session`.

**Env vars added:**

```
MTPROTO_API_ID=12345678
MTPROTO_API_HASH=abc123...
```

**Files created:**

| File | Purpose |
|---|---|
| `.env` | `MTPROTO_API_ID` and `MTPROTO_API_HASH` |
| `data/mtproto-session` | Encrypted session string (host-only, never mounted into containers) |

**Restart required** — the reader starts automatically with the main process:

```bash
# macOS
launchctl kickstart -k gui/$(id -u)/com.nanoclaw

# Linux
systemctl --user restart nanoclaw
```

**Verify:**

```bash
curl http://127.0.0.1:8081/health
```

**Security:** The MTProto session stays on the host. The container only has the `telegram-reader` CLI which calls `localhost:8081` over HTTP — it never sees the session or credentials.

## Voice Transcription

Transcribes Telegram voice messages to text using Groq's Whisper API. Without this, voice messages appear as `[Voice message]` placeholders.

**How it works:**

```
User sends voice message in Telegram
  → Telegram channel handler downloads the .ogg file
  → sends audio buffer to Groq API (whisper-large-v3-turbo model)
  → transcript stored as message text: [Voice: "transcribed text here"]
  → agent sees the transcript as regular text
```

Transcription happens on the host before the message reaches the agent — the agent never handles audio files.

**Prerequisites:** A Groq API key from https://console.groq.com.

**Setup:** Add to `.env`:

```
GROQ_API_KEY=gsk_...
```

**Restart required** to pick up the new key. If the key is missing or invalid, voice messages silently fall back to `[Voice message]` placeholders.

## Browser Automation

Full browser automation via Playwright. The agent can browse websites, fill forms, take screenshots, and extract data.

**How it works:**

```
Agent runs agent-browser CLI inside container
  → launches headless Chromium via Playwright
  → returns accessibility tree snapshots with element refs (@e1, @e2, ...)
  → agent interacts using refs: click, fill, type, scroll, etc.
```

The workflow is: open URL, take a snapshot to see interactive elements, interact using refs, re-snapshot after navigation.

```bash
agent-browser open https://example.com    # navigate
agent-browser snapshot -i                 # get interactive elements
agent-browser fill @e1 "search query"     # fill input by ref
agent-browser click @e2                   # click button by ref
agent-browser screenshot page.png         # capture screenshot
agent-browser close                       # close browser
```

**Setup:** None — baked into the container image. No API keys, no configuration. Available to all agents automatically.
