# NanoClaw Security Model

## Trust Model

| Entity | Trust Level | Rationale |
|--------|-------------|-----------|
| Main group | Trusted | Private self-chat, admin control |
| Non-main groups | Untrusted | Other users may be malicious |
| Container agents | Sandboxed | Isolated execution environment |
| WhatsApp messages | User input | Potential prompt injection |

## Security Boundaries

### 1. Container Isolation (Primary Boundary)

Agents execute in containers (lightweight Linux VMs), providing:
- **Process isolation** - Container processes cannot affect the host
- **Filesystem isolation** - Only explicitly mounted directories are visible
- **Non-root execution** - Runs as unprivileged `node` user (uid 1000)
- **Ephemeral containers** - Fresh environment per invocation (`--rm`)

This is the primary security boundary. Rather than relying on application-level permission checks, the attack surface is limited by what's mounted.

### 2. Mount Security

**External Allowlist** - Mount permissions stored at `~/.config/nanoclaw/mount-allowlist.json`, which is:
- Outside project root
- Never mounted into containers
- Cannot be modified by agents

**Default Blocked Patterns:**
```
.ssh, .gnupg, .aws, .azure, .gcloud, .kube, .docker,
credentials, .env, .netrc, .npmrc, id_rsa, id_ed25519,
private_key, .secret
```

**Protections:**
- Symlink resolution before validation (prevents traversal attacks)
- Container path validation (rejects `..` and absolute paths)
- `nonMainReadOnly` option forces read-only for non-main groups

**Read-Only Project Root:**

The main group's project root is mounted read-only. Writable paths the agent needs (group folder, IPC, `.claude/`) are mounted separately. This prevents the agent from modifying host application code (`src/`, `dist/`, `package.json`, etc.) which would bypass the sandbox entirely on next restart.

### 3. Session Isolation

Each group has isolated Claude sessions at `data/sessions/{group}/.claude/`:
- Groups cannot see other groups' conversation history
- Session data includes full message history and file contents read
- Prevents cross-group information disclosure

### 4. IPC Authorization

Messages and task operations are verified against group identity:

| Operation | Main Group | Non-Main Group |
|-----------|------------|----------------|
| Send message to own chat | ✓ | ✓ |
| Send message to other chats | ✓ | ✗ |
| Schedule task for self | ✓ | ✓ |
| Schedule task for others | ✓ | ✗ |
| View all tasks | ✓ | Own only |
| Manage other groups | ✓ | ✗ |

### 5. Credential Handling

**Mounted Credentials:**
- Claude auth tokens (filtered from `.env`, read-only)

**NOT Mounted:**
- WhatsApp session (`store/auth/`) - host only
- Mount allowlist - external, never mounted
- Any credentials matching blocked patterns

**Credential Filtering:**
Only these environment variables are exposed to containers:
```typescript
const allowedVars = ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY'];
```

> **Note:** Anthropic credentials are mounted so that Claude Code can authenticate when the agent runs. However, this means the agent itself can discover these credentials via Bash or file operations. Ideally, Claude Code would authenticate without exposing credentials to the agent's execution environment, but I couldn't figure this out. **PRs welcome** if you have ideas for credential isolation.

### 6. External API Tool Patterns

Container tools that integrate with external APIs (Gmail, Todoist, Telegram) use two different patterns depending on what the token allows:

**Read-only tokens → mount into container, CLI calls API directly.**

When the token's permissions are scoped to read-only (e.g., Gmail's `gmail.readonly` OAuth scope), the credentials are mounted read-only into the container. The CLI tool calls the external API directly and returns data to the agent via stdout. This is a synchronous request-response — the agent needs the data in the same turn to reason about it.

```
Agent → Bash: google-api gmail list
  → CLI reads token from /workspace/extra/google-oauth/oauth.json
  → CLI calls Gmail API over HTTPS
  → Returns data to agent via stdout
```

Even if the agent extracted the token and tried to misuse it, the OAuth scope prevents writes.

**Read-write tokens → token stays on host, CLI calls host HTTP proxy.**

When the token grants write access (e.g., Todoist API token, MTProto session), it never enters the container. The host process holds the token and exposes a read-only HTTP proxy on `localhost:8081`. The container CLI tool calls the proxy for reads — same synchronous flow, but the token is never exposed.

```
Agent → Bash: todoist list
  → CLI calls localhost:8081/todoist/tasks (HTTP, no token)
  → Host proxy adds auth header, calls Todoist API
  → Returns data through HTTP → CLI → stdout → agent
```

**Write operations go through IPC with user approval.** The agent calls an MCP tool (e.g., `create_todo`), which writes a JSON file to the IPC directory. The host picks it up asynchronously and either executes immediately (yolo mode) or sends an inline keyboard to Telegram for user confirmation. The agent doesn't wait for the result — it gets a static "proposed" response. The user sees the outcome directly in Telegram.

```
Agent → MCP: create_todo("Buy groceries")
  → Writes IPC file, returns "Todo proposed" immediately

Host (async):
  → IPC watcher reads file
  → Confirm mode: sends inline keyboard → user taps → host calls API
  → Yolo mode: host calls API directly → sends confirmation to chat
```

Why two patterns for reads vs writes:
- **Reads need synchronous data.** The agent asks "what's on my todo list?" and needs the list now, in the same turn, to formulate a response. HTTP gives request-response for free. IPC is one-way — there's no return channel to send data back to the agent.
- **Writes need host-side context.** The confirmation flow requires access to the Telegram bot (inline keyboards), the database (proposal tracking), and the user's mode preference. The HTTP proxy doesn't have any of this. The IPC watcher runs inside the main process alongside all subsystems.

## Privilege Comparison

| Capability | Main Group | Non-Main Group |
|------------|------------|----------------|
| Project root access | `/workspace/project` (ro) | None |
| Group folder | `/workspace/group` (rw) | `/workspace/group` (rw) |
| Global memory | Implicit via project | `/workspace/global` (ro) |
| Additional mounts | Configurable | Read-only unless allowed |
| Network access | Unrestricted | Unrestricted |
| MCP tools | All | All |

## Security Architecture Diagram

```
┌──────────────────────────────────────────────────────────────────┐
│                        UNTRUSTED ZONE                             │
│  WhatsApp Messages (potentially malicious)                        │
└────────────────────────────────┬─────────────────────────────────┘
                                 │
                                 ▼ Trigger check, input escaping
┌──────────────────────────────────────────────────────────────────┐
│                     HOST PROCESS (TRUSTED)                        │
│  • Message routing                                                │
│  • IPC authorization                                              │
│  • Mount validation (external allowlist)                          │
│  • Container lifecycle                                            │
│  • Credential filtering                                           │
└────────────────────────────────┬─────────────────────────────────┘
                                 │
                                 ▼ Explicit mounts only
┌──────────────────────────────────────────────────────────────────┐
│                CONTAINER (ISOLATED/SANDBOXED)                     │
│  • Agent execution                                                │
│  • Bash commands (sandboxed)                                      │
│  • File operations (limited to mounts)                            │
│  • Network access (unrestricted)                                  │
│  • Cannot modify security config                                  │
└──────────────────────────────────────────────────────────────────┘
```
