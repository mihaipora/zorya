# Plan: Todoist Integration — IMPLEMENTED

## Context

Add personal task management via Todoist. The agent can create todos from conversations, query tasks by deadline/subject, and mark them complete. Write operations (create, complete) support two modes: **yolo** (auto-execute) and **confirm** (inline keyboard approval), toggled via `/todomode`.

## Security model

The Todoist API token is full read-write with no scope restrictions. It **never** enters the container. All access goes through the host, matching the mtproto-reader pattern.

## Architecture

```
READS:
  Agent → Bash: todoist list → CLI calls localhost:8081/todoist/tasks → Host HTTP server → Todoist API → response

WRITES:
  Agent → MCP: create_todo → IPC file → Host reads →
    Yolo:    Host calls Todoist API → sends confirmation message
    Confirm: Host sends inline keyboard → user taps → Host calls API
```

Single HTTP server on port 8081 serves all tool APIs. Owned by `src/tools-proxy.ts`, which dispatches by path prefix to tool modules. MTProto reader endpoints (`/pending-replies`, `/conversations`, etc.) coexist with Todoist endpoints (`/todoist/tasks`, `/todoist/projects`, etc.) on the same server.

As a prerequisite, the HTTP server is extracted from `src/mtproto-reader.ts` into `src/tools-proxy.ts`. MTProto reader becomes a pure GramJS client + route handler module — no HTTP server of its own.

Token stored only in `.env` as `TODOIST_API_TOKEN`. Read by host process only.

## Setup

No setup script. Add the token to `.env` and restart:

```
TODOIST_API_TOKEN=<token from https://app.todoist.com/app/settings/integrations/developer>
```

The proxy starts automatically if the token is present, skips silently if not.

## Files to create

### 1. `container/tools/todoist`

Pure Node.js CLI tool (pattern: `container/tools/telegram-reader`).

Calls `localhost:8081/todoist/*` via HTTP. Service discovery tries `host.docker.internal:8081` then `172.17.0.1:8081` (same as telegram-reader — can share its `resolveHost()` logic).

```
todoist list [--filter "..."] [--limit N] [--json]
todoist search <keyword> [--limit N] [--json]
todoist get <task-id> [--json]
todoist projects [--json]
todoist health
```

Key commands:
- `todoist list` — all active tasks, sorted by due date
- `todoist list --filter "due before: Apr 1"` — Todoist filter syntax
- `todoist list --filter "p1 | p2"` — high priority
- `todoist search "EU funding"` — wraps `search: <keyword>` filter
- `todoist projects` — list all projects

Text output format:
```
[ ] Buy groceries  (due: Mar 5, priority: high)  [id: 123456]
    Project: Personal
[ ] Send invoice  (due: Mar 3, priority: urgent)  [id: 789012]
    Project: Work
    Labels: billing, urgent
```

### 2. `src/tools-proxy.ts` — Shared HTTP server (extracted from mtproto-reader)

Owns the HTTP server on port 8081. Dispatches requests by path prefix to tool modules. Each tool module exports route handler functions; the proxy wires them together.

```typescript
import http from 'http';

type RouteHandler = (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>;

// Each tool module registers a prefix + handler
const routes: Array<{ prefix: string; handler: RouteHandler }> = [];

export function registerRoutes(prefix: string, handler: RouteHandler): void { ... }

export function startToolsProxy(): void {
  // Creates http.createServer, matches req.url against registered prefixes
  // /health returns aggregate status of all registered tools
  // Listens on 127.0.0.1:8081
}

export function stopToolsProxy(): void { ... }
```

### 3. `src/todoist.ts`

Host-side Todoist module. Uses the official [`@doist/todoist-api-typescript`](https://github.com/Doist/todoist-api-typescript) SDK.

Reads token from `.env` via `readEnvFile(['TODOIST_API_TOKEN'])`. Initializes a `TodoistApi` instance. Used by both the HTTP proxy route handler (reads) and the IPC handler (writes).

```typescript
import { TodoistApi } from '@doist/todoist-api-typescript';
// Types: Task, PersonalProject, WorkspaceProject, GetTasksResponse, GetProjectsResponse

// Route handler (registered with tools-proxy for /todoist/* prefix)
export async function handleTodoistRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void>
// Dispatches:
//   GET /todoist/tasks?limit=N              → api.getTasks({ limit })
//   GET /todoist/tasks?filter=...&limit=N   → api.getTasksByFilter({ query: filter, limit })
//   GET /todoist/tasks/:id                  → api.getTask(id)
//   GET /todoist/projects                   → api.getProjects()
// Returns 503 if TODOIST_API_TOKEN is not set.
//
// Note: getTasks() and getTasksByFilter() are separate SDK methods.
// getTasks() filters by projectId/label/ids. getTasksByFilter() accepts
// Todoist filter syntax (e.g., "due before: Apr 1", "search: keyword", "p1 | p2").
// Both return paginated { results: Task[], nextCursor }.

// Read operations (called by route handler above)
export async function listTodoistTasks(filter?: string, limit?: number): Promise<Task[]>
// if filter: api.getTasksByFilter({ query: filter, limit })
// else: api.getTasks({ limit })
// Unwraps paginated response, returns results array.

export async function getTodoistTask(taskId: string): Promise<Task>
export async function listTodoistProjects(): Promise<(PersonalProject | WorkspaceProject)[]>

// Write operations (called by IPC handler)
export async function createTodoistTask(params: {
  content: string;
  description?: string;
  dueString?: string;
  projectId?: string;
  priority?: number;
  labels?: string[];
}): Promise<Task>
// → api.addTask(params)

export async function closeTodoistTask(taskId: string): Promise<boolean>
// → api.closeTask(taskId)

export async function resolveProjectId(projectName: string): Promise<string | null>
// → api.getProjects(), cache in memory, match by name
```

**Dependency:** `npm install @doist/todoist-api-typescript` (host only, not in container).

## Files to modify

### 4. `src/mtproto-reader.ts` — Refactor to pure client + route handlers

Remove the HTTP server. Export route handler + client lifecycle only:

```typescript
// Client lifecycle
export async function connectMtproto(): Promise<void>   // connects GramJS, sets module-level _client
export async function disconnectMtproto(): Promise<void> // disconnects, nulls _client

// Route handler (registered with tools-proxy for mtproto paths)
export async function handleMtprotoRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void>
// Dispatches: /health, /pending-replies, /conversations, /conversation/:id
```

No more `http.createServer`, no more `server.listen`. The tools-proxy owns the server and calls `handleMtprotoRequest` for matching paths.

### 5. `src/db.ts` — Add `todoist_proposals` table

Schema (mirrors `event_proposals`):

```sql
CREATE TABLE IF NOT EXISTS todoist_proposals (
  id TEXT PRIMARY KEY,
  action TEXT NOT NULL CHECK(action IN ('create', 'complete')),
  content TEXT NOT NULL,
  description TEXT DEFAULT '',
  due_string TEXT DEFAULT '',
  project_name TEXT DEFAULT '',
  priority INTEGER DEFAULT 1,
  labels TEXT DEFAULT '[]',
  todoist_task_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK(status IN ('pending', 'approved', 'rejected', 'expired')),
  telegram_message_id TEXT,
  chat_jid TEXT NOT NULL,
  created_at TEXT NOT NULL,
  resolved_at TEXT
);
```

Add accessors: `createTodoistProposal`, `getTodoistProposal`, `updateTodoistProposal`, `expireStaleTodoistProposals`.

### 6. `container/agent-runner/src/ipc-mcp-stdio.ts` — Add MCP tools

Two new tools (pattern: `propose_event`):

**`create_todo`** — writes IPC message `{ type: 'todoist_create', chatJid, content, description, due_string, project_name, priority, labels }`

**`complete_todo`** — writes IPC message `{ type: 'todoist_complete', chatJid, taskId, taskTitle }`

Both return immediate text response to agent ("Todo proposed: ...").

### 7. `src/ipc.ts` — Handle todoist IPC messages

Add to `IpcDeps`:
```typescript
sendTodoistProposal?: (jid: string, proposal: TodoistProposal) => Promise<string | undefined>;
```

For `todoist_create` and `todoist_complete`:
1. Read `todo_mode:{chatJid}` from `router_state` (default: `confirm`)
2. **Yolo mode**: call Todoist API directly via `src/todoist.ts`, send confirmation message to chat
3. **Confirm mode**: create `todoist_proposals` DB record, send inline keyboard via `sendTodoistProposal`

For create with `project_name`: resolve to `project_id` via `resolveProjectId()` before calling API.

### 8. `src/channels/telegram.ts` — Add command + callbacks

**`/todomode` command**: Shows current mode with inline keyboard to switch:
```
Todo mode: confirm
Select a mode:
[Yolo (auto-execute)] [✅ Confirm (approve each)]
```

Callback data: `todo:mode:yolo` / `todo:mode:confirm` — stores in `router_state` as `todo_mode:{chatJid}`.

**`sendTodoistProposal` method**: Sends inline keyboard for create/complete confirmation:
```
📋 Buy groceries
Due: Friday
Priority: high

[✅ Create]  [❌ Skip]
```

Callback data: `todo:approve:{proposalId}` / `todo:skip:{proposalId}`

Add to opts: `onTodoCallback`, `onTodoModeChange`.

Extend existing `callback_query:data` handler to route `todo:mode:*` and `todo:approve/skip:*` callbacks.

### 9. `src/index.ts` — Wire up

- Replace `startMtprotoReader`/`stopMtprotoReader` with `startToolsProxy`/`stopToolsProxy`
- Register mtproto routes: `registerRoutes('/', handleMtprotoRequest)` (legacy paths)
- Register todoist routes: `registerRoutes('/todoist', handleTodoistRequest)`
- Add `onTodoCallback` handler (pattern: `onEventCallback`) — fetches proposal from DB, validates, calls Todoist API, updates message
- Add `onTodoModeChange` handler — calls `setRouterState`, edits message
- Add `sendTodoistProposal` to IPC watcher deps
- Add `expireStaleTodoistProposals()` to hourly interval

### 10. `container/Dockerfile` — Add tool

```dockerfile
COPY tools/todoist /usr/local/bin/todoist
RUN chmod +x /usr/local/bin/todoist
```

### 11. Agent docs — `groups/main/CLAUDE.md`

Add Todoist section with CLI commands and MCP tool usage examples.

## Implementation order

0. `npm install @doist/todoist-api-typescript` — host dependency
1. `src/tools-proxy.ts` — extract HTTP server from mtproto-reader
2. `src/mtproto-reader.ts` — refactor to pure client + route handler (no HTTP server)
3. `src/index.ts` — swap `startMtprotoReader`/`stopMtprotoReader` for `startToolsProxy`/`stopToolsProxy` + route registration
4. Verify: `npm run build` + restart + `curl http://127.0.0.1:8081/health` (existing mtproto routes still work)
5. `src/todoist.ts` — host API client (reads + writes) + route handler
6. `src/index.ts` — register todoist routes with tools-proxy
7. `container/tools/todoist` — CLI tool calling localhost:8081
8. `src/db.ts` — schema + accessors
9. `container/agent-runner/src/ipc-mcp-stdio.ts` — MCP tools
10. `src/ipc.ts` — message handling
11. `src/channels/telegram.ts` — command + callbacks
12. `src/index.ts` — wire todo callbacks
13. `container/Dockerfile` — add tool
14. `groups/main/CLAUDE.md` — docs
15. Sync agent-runner: `cp -R container/agent-runner/src/* data/sessions/main/agent-runner-src/`
16. Rebuild container: `./container/build.sh`

## Verification

```bash
# Build
npm run build

# Restart — verify tools-proxy extraction didn't break mtproto routes
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
curl http://127.0.0.1:8081/health                    # existing — still works
curl http://127.0.0.1:8081/pending-replies           # existing — still works

# Add token to .env: TODOIST_API_TOKEN=<token>

# Restart again to pick up token
launchctl kickstart -k gui/$(id -u)/com.nanoclaw

# Verify todoist routes
curl http://127.0.0.1:8081/todoist/tasks              # new
curl http://127.0.0.1:8081/todoist/projects            # new

# Rebuild container
./container/build.sh

# Test CLI from inside container
docker run --rm --add-host=host.docker.internal:host-gateway nanoclaw-agent:latest todoist list

# Test /todomode toggle in Telegram
# Send /todomode — should show current mode with buttons

# Test confirm mode (default)
# Ask agent "add a todo to buy groceries by Friday"
# Should see inline keyboard: [✅ Create] [❌ Skip]
# Tap Create → should create in Todoist

# Test yolo mode
# Switch via /todomode → Yolo
# Ask agent "remind me to call dentist tomorrow"
# Should auto-create, send "✅ Todo created: ..."

# Test reads
# Ask agent "what's on my todo list?"
# Ask "what needs to be done before April?"

# Test completion
# Ask "I finished buying groceries"
# Agent searches, finds task, calls complete_todo
# Confirm mode: keyboard. Yolo: auto-complete.

# Test without Todoist config
# Remove TODOIST_API_TOKEN from .env, restart
# Todoist routes return 503, mtproto routes still work
```

## What we're NOT changing

- Existing integrations (google-api, telegram-reader, calendar approval)
- Container runtime or mount security model
- IPC protocol or file format
- Agent-runner SDK configuration
