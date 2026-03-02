# NanoClaw

Personal Claude assistant. See [README.md](README.md) for philosophy and setup. See [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) for architecture decisions.

## Quick Context

Single Node.js process that connects to WhatsApp, routes messages to Claude Agent SDK running in containers (Linux VMs). Each group has isolated filesystem and memory.

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Orchestrator: state, message loop, agent invocation |
| `src/channels/whatsapp.ts` | WhatsApp connection, auth, send/receive |
| `src/ipc.ts` | IPC watcher and task processing |
| `src/router.ts` | Message formatting and outbound routing |
| `src/config.ts` | Trigger pattern, paths, intervals |
| `src/container-runner.ts` | Spawns agent containers with mounts |
| `src/task-scheduler.ts` | Runs scheduled tasks |
| `src/tools-proxy.ts` | HTTP proxy server (port 8081) for container tool APIs |
| `src/mtproto-reader.ts` | GramJS client + Telegram read-only route handlers |
| `src/todoist.ts` | Todoist API client + HTTP route handler |
| `src/db.ts` | SQLite operations |
| `groups/{name}/CLAUDE.md` | Per-group memory (isolated) |
| `container/skills/agent-browser.md` | Browser automation tool (available to all agents via Bash) |

## Skills

| Skill | When to Use |
|-------|-------------|
| `/setup` | First-time installation, authentication, service configuration |
| `/customize` | Adding channels, integrations, changing behavior |
| `/debug` | Container issues, logs, troubleshooting |
| `/update` | Pull upstream NanoClaw changes, merge with customizations, run migrations |
| `/qodo-pr-resolver` | Fetch and fix Qodo PR review issues interactively or in batch |
| `/get-qodo-rules` | Load org- and repo-level coding rules from Qodo before code tasks |

## Development

Run commands directly—don't tell the user to run them.

```bash
npm run dev          # Run with hot reload
npm run build        # Compile TypeScript
./container/build.sh # Rebuild agent container
```

Service management:
```bash
# macOS (launchd)
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # restart

# Linux (systemd)
systemctl --user start nanoclaw
systemctl --user stop nanoclaw
systemctl --user restart nanoclaw
```

## Tool Integration Patterns

When integrating with external APIs, prefer official SDK libraries over raw `fetch` calls. Libraries handle auth headers, retries, type safety, and API versioning. Only fall back to raw HTTP when no maintained library exists.

Container tools that need API tokens follow one of two patterns depending on the token's permissions:

**Read-only tokens** (e.g., `gmail.readonly` OAuth scope): Mount credentials into container. CLI tool calls API directly.
- Example: `google-api` reads `~/.google-oauth/oauth.json` from mount at `/workspace/extra/google-oauth/`

**Read-write tokens** (e.g., Todoist API token, MTProto session): Token stays on host only. Host exposes HTTP proxy on `localhost:8081`. Container CLI tool calls the proxy.
- Example: `telegram-reader` calls `localhost:8081/conversations`
- `src/tools-proxy.ts` owns the HTTP server, dispatches by path prefix to tool modules
- Each tool module exports a route handler (e.g., `src/mtproto-reader.ts`, `src/todoist.ts`)
- To add a new tool: create handler module, register prefix in `src/index.ts`

**Write operations with user approval**: Use MCP tools via IPC (pattern: `propose_event`).
- Agent calls MCP tool → writes IPC file → host processes it
- Host checks mode (yolo/confirm) → executes directly or sends inline keyboard
- Confirmation state stored in `router_state` table

## Container Build Cache

The container buildkit caches the build context aggressively. `--no-cache` alone does NOT invalidate COPY steps — the builder's volume retains stale files. To force a truly clean rebuild, prune the builder then re-run `./container/build.sh`.
