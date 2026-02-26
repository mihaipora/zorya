#!/usr/bin/env tsx
/**
 * Google OAuth Setup Script for NanoClaw
 *
 * One-time script to obtain Google OAuth refresh tokens for Gmail and Calendar access.
 * Tokens are saved to ~/.google-oauth/oauth.json where the container can read them.
 *
 * Usage:
 *   npx tsx scripts/google-oauth.ts ~/Downloads/client_secret_*.json  # first time
 *   npx tsx scripts/google-oauth.ts                                    # re-run
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import http from 'http';
import https from 'https';
import os from 'os';
import path from 'path';
import readline from 'readline';

import { isHeadless, openBrowser } from '../setup/platform.js';

const HOME = os.homedir();
const OAUTH_DIR = path.join(HOME, '.google-oauth');
const CLIENT_FILE = path.join(OAUTH_DIR, 'client.json');
const OAUTH_FILE = path.join(OAUTH_DIR, 'oauth.json');
const ALLOWLIST_PATH = path.join(HOME, '.config', 'nanoclaw', 'mount-allowlist.json');
const DB_PATH = path.join(process.cwd(), 'store', 'messages.db');

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.freebusy',
];
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';

// --- Helpers ---

function die(msg: string): never {
  console.error(`\n❌ ${msg}`);
  process.exit(1);
}

function ask(prompt: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function httpsPost(url: string, body: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = https.request(
      {
        hostname: parsed.hostname,
        path: parsed.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => (data += chunk));
        res.on('end', () => resolve({ status: res.statusCode!, body: data }));
      },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// --- Step 1: Load or copy client credentials ---

interface ClientCredentials {
  client_id: string;
  client_secret: string;
}

function loadClientCredentials(): ClientCredentials {
  const arg = process.argv[2];

  if (arg) {
    const resolved = arg.startsWith('~/')
      ? path.join(HOME, arg.slice(2))
      : path.resolve(arg);

    if (!fs.existsSync(resolved)) {
      die(`File not found: ${resolved}`);
    }
    fs.mkdirSync(OAUTH_DIR, { recursive: true });
    fs.copyFileSync(resolved, CLIENT_FILE);
    fs.chmodSync(CLIENT_FILE, 0o600);
    console.log(`Copied client credentials to ${CLIENT_FILE}`);
  }

  if (!fs.existsSync(CLIENT_FILE)) {
    die(
      `No client credentials found at ${CLIENT_FILE}\n` +
        `Download from Google Cloud Console (OAuth 2.0 Client ID → Desktop app) and run:\n` +
        `  npx tsx scripts/google-oauth.ts ~/Downloads/client_secret_*.json`,
    );
  }

  const raw = JSON.parse(fs.readFileSync(CLIENT_FILE, 'utf-8'));

  // GCP downloads wrap credentials in "installed" or "web"
  const creds = raw.installed || raw.web || raw;
  if (!creds.client_id || !creds.client_secret) {
    die('client.json must contain client_id and client_secret');
  }

  return { client_id: creds.client_id, client_secret: creds.client_secret };
}

// --- Step 2: Get authorization code ---

function buildConsentUrl(clientId: string, redirectUri: string): string {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent',
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

async function getAuthCodeHeadless(
  clientId: string,
): Promise<{ code: string; redirectUri: string }> {
  const redirectUri = 'http://localhost:1/callback';
  const consentUrl = buildConsentUrl(clientId, redirectUri);

  console.log('\nOpen this URL in your browser:\n');
  console.log(consentUrl);
  console.log(
    "\nAfter authorizing, Google will redirect to localhost:1 (page won't load).",
  );
  console.log(
    "Copy the full URL from your browser's address bar and paste it here.\n",
  );

  const pastedUrl = await ask('Paste redirect URL: ');

  // Handle both full URL and just the code
  let code: string;
  if (pastedUrl.startsWith('http')) {
    const parsed = new URL(pastedUrl);
    const extracted = parsed.searchParams.get('code');
    if (!extracted) die('No ?code= parameter found in the pasted URL');
    code = extracted;
  } else {
    // Assume user pasted just the code
    code = pastedUrl;
  }

  return { code, redirectUri };
}

async function getAuthCodeViaCallback(
  clientId: string,
): Promise<{ code: string; redirectUri: string }> {
  return new Promise((resolve, reject) => {
    let timeoutHandle: NodeJS.Timeout;

    const server = http.createServer((req, res) => {
      const url = new URL(req.url!, `http://localhost`);

      const error = url.searchParams.get('error');
      if (error) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(
          `<h1>Authorization failed</h1><p>${error}</p><p>You can close this tab.</p>`,
        );
        clearTimeout(timeoutHandle);
        server.close();
        reject(new Error(`Google returned error: ${error}`));
        return;
      }

      const code = url.searchParams.get('code');
      if (code) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(
          '<h1>Authorization successful!</h1><p>You can close this tab and return to the terminal.</p>',
        );
        const port = (server.address() as { port: number }).port;
        clearTimeout(timeoutHandle);
        server.close();
        resolve({ code, redirectUri: `http://localhost:${port}/callback` });
        return;
      }

      // Ignore favicon and other requests
      res.writeHead(404);
      res.end();
    });

    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      const redirectUri = `http://localhost:${port}/callback`;
      const consentUrl = buildConsentUrl(clientId, redirectUri);

      console.log('\nOpening browser for Google authorization...');
      const opened = openBrowser(consentUrl);
      if (!opened) {
        console.log('\nCould not open browser. Open this URL manually:\n');
        console.log(consentUrl);
      }
      console.log('\nWaiting for authorization callback...');
    });

    // Timeout after 5 minutes
    timeoutHandle = setTimeout(() => {
      server.close();
      reject(new Error('Timed out waiting for OAuth callback (5 minutes)'));
    }, 5 * 60 * 1000);
  });
}

// --- Step 3: Exchange code for tokens ---

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: string;
  scope: string;
}

async function exchangeCode(
  code: string,
  clientId: string,
  clientSecret: string,
  redirectUri: string,
): Promise<TokenResponse> {
  const body = new URLSearchParams({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
  }).toString();

  const res = await httpsPost(TOKEN_ENDPOINT, body);
  const data = JSON.parse(res.body);

  if (res.status !== 200) {
    die(
      `Token exchange failed (${res.status}): ${data.error_description || data.error || res.body}`,
    );
  }

  if (!data.refresh_token) {
    die(
      'No refresh_token returned. This can happen if you already authorized this app.\n' +
        'Go to https://myaccount.google.com/connections → remove the app → re-run this script.',
    );
  }

  return data as TokenResponse;
}

// --- Step 4: Update mount allowlist ---

function updateMountAllowlist(): void {
  if (!fs.existsSync(ALLOWLIST_PATH)) {
    console.log(`\nMount allowlist not found at ${ALLOWLIST_PATH}, creating it...`);
    fs.mkdirSync(path.dirname(ALLOWLIST_PATH), { recursive: true });
    const template = {
      allowedRoots: [],
      blockedPatterns: [],
      nonMainReadOnly: true,
    };
    fs.writeFileSync(ALLOWLIST_PATH, JSON.stringify(template, null, 2) + '\n');
  }

  const allowlist = JSON.parse(fs.readFileSync(ALLOWLIST_PATH, 'utf-8'));

  // Check if already present
  const alreadyPresent = allowlist.allowedRoots.some(
    (r: { path?: string }) => r.path === '~/.google-oauth',
  );

  if (!alreadyPresent) {
    allowlist.allowedRoots.push({
      path: '~/.google-oauth',
      allowReadWrite: false,
      description: 'Google OAuth credentials (read-only)',
    });
    fs.writeFileSync(ALLOWLIST_PATH, JSON.stringify(allowlist, null, 2) + '\n');
    console.log(`Updated mount allowlist: added ~/.google-oauth as allowed root`);
  } else {
    console.log(`Mount allowlist already contains ~/.google-oauth`);
  }
}

// --- Step 5: Update group container_config in SQLite ---

function updateGroupContainerConfig(): void {
  if (!fs.existsSync(DB_PATH)) {
    console.log(`\nDatabase not found at ${DB_PATH}, skipping container config update.`);
    console.log('Run the bot first to initialize the database, then re-run this script.');
    return;
  }

  const db = new Database(DB_PATH);

  try {
    // Find the main group (folder = 'main')
    const row = db
      .prepare("SELECT jid, container_config FROM registered_groups WHERE folder = 'main'")
      .get() as { jid: string; container_config: string | null } | undefined;

    if (!row) {
      console.log('\nNo main group found in database, skipping container config update.');
      console.log('Register the main group first, then re-run this script.');
      return;
    }

    const config = row.container_config ? JSON.parse(row.container_config) : {};
    const mounts: Array<{ hostPath: string; containerPath?: string; readonly?: boolean }> =
      config.additionalMounts || [];

    // Check if already present
    const alreadyPresent = mounts.some(
      (m) => m.hostPath === '~/.google-oauth',
    );

    if (!alreadyPresent) {
      mounts.push({ hostPath: '~/.google-oauth', containerPath: 'google-oauth', readonly: true });
      config.additionalMounts = mounts;

      db.prepare(
        'UPDATE registered_groups SET container_config = ? WHERE jid = ?',
      ).run(JSON.stringify(config), row.jid);

      console.log(`Updated main group container config: added ~/.google-oauth mount`);
    } else {
      console.log(`Main group container config already has ~/.google-oauth mount`);
    }
  } finally {
    db.close();
  }
}

// --- Main ---

async function main(): Promise<void> {
  console.log('Google OAuth Setup for NanoClaw');
  console.log('===============================\n');

  // Step 1: Load client credentials
  const creds = loadClientCredentials();
  console.log(`Client ID: ${creds.client_id.slice(0, 30)}...`);

  // Step 2: Get authorization code
  let code: string;
  let redirectUri: string;

  if (isHeadless()) {
    ({ code, redirectUri } = await getAuthCodeHeadless(creds.client_id));
  } else {
    ({ code, redirectUri } = await getAuthCodeViaCallback(creds.client_id));
  }

  // Step 3: Exchange code for tokens
  console.log('\nExchanging authorization code for tokens...');
  const tokens = await exchangeCode(
    code,
    creds.client_id,
    creds.client_secret,
    redirectUri,
  );

  // Step 4: Save oauth.json
  fs.mkdirSync(OAUTH_DIR, { recursive: true });
  const oauthData = {
    client_id: creds.client_id,
    client_secret: creds.client_secret,
    refresh_token: tokens.refresh_token,
    access_token: tokens.access_token,
    token_expiry: new Date(Date.now() + tokens.expires_in * 1000).toISOString(),
    scopes: SCOPES,
  };

  fs.writeFileSync(OAUTH_FILE, JSON.stringify(oauthData, null, 2) + '\n');
  fs.chmodSync(OAUTH_FILE, 0o600);
  console.log(`\nSaved tokens to ${OAUTH_FILE}`);

  // Step 5: Write CLAUDE.md for agent auto-discovery
  const CLAUDE_MD_PATH = path.join(OAUTH_DIR, 'CLAUDE.md');
  const claudeMdContent = `# Google API — Gmail & Calendar Access

The \`google-api\` CLI tool provides access to the user's Gmail (read-only) and Calendar.

## Commands

### Gmail

\`\`\`bash
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
\`\`\`

### Calendar

\`\`\`bash
# List upcoming events (default: next 7 days)
google-api calendar list

# Today's events only
google-api calendar today

# Specific range
google-api calendar list --from 2026-03-01 --days 3

# Check a colleague's availability (today by default)
google-api calendar freebusy colleague@example.com

# Check multiple people for a specific day
google-api calendar freebusy alice@work.com bob@work.com --from 2026-03-05 --days 1
\`\`\`

### Utility

\`\`\`bash
# Verify credentials work
google-api auth test
\`\`\`

## Flags

| Flag | Description |
|------|-------------|
| \`--json\` | Output raw JSON instead of formatted text (any command) |
| \`--limit N\` | Max results for gmail list (default: 10, max: 50) |
| \`--query "..."\` | Gmail search query (full Gmail search syntax) |
| \`--days N\` | gmail list: threads from last N days; calendar list: days ahead (default: 7) |
| \`--from YYYY-MM-DD\` | Start date for calendar list (default: today) |

## Gmail Search Examples

| Query | Description |
|-------|-------------|
| \`is:unread\` | Unread messages |
| \`from:alice@example.com\` | From specific sender |
| \`subject:invoice\` | Subject contains word |
| \`after:2026/02/01 before:2026/02/28\` | Date range |
| \`has:attachment filename:pdf\` | With PDF attachments |
| \`in:inbox -category:promotions\` | Inbox minus promotions |

## Common Patterns

- **Find emails needing reply:** \`google-api gmail list --days 7 --query "in:inbox"\`, then \`google-api gmail read <thread-id>\` for each
- **Check today's schedule:** \`google-api calendar today\`
- **Check your availability:** \`google-api calendar list --from 2026-03-05 --days 1\`
- **Check colleague's availability:** \`google-api calendar freebusy alice@work.com --from 2026-03-05\`
- **Find mutual free time:** \`google-api calendar freebusy alice@work.com bob@work.com --from 2026-03-05\`
- **Search person's emails:** \`google-api gmail list --query "from:alice" --limit 5\`

## Notes

- Gmail access is read-only — cannot send, delete, or modify emails
- Calendar access allows reading events, creating events, and checking free/busy for other people
- Check a colleague's availability: \`google-api calendar freebusy colleague@example.com\`
- Token refresh is automatic
- Errors go to stderr with exit code 1
`;

  fs.writeFileSync(CLAUDE_MD_PATH, claudeMdContent);
  console.log(`Wrote agent docs to ${CLAUDE_MD_PATH}`);

  // Step 6: Update mount allowlist
  updateMountAllowlist();

  // Step 7: Update group container_config
  updateGroupContainerConfig();

  console.log('\nDone! The agent can access Google APIs from inside the container.');
  console.log('Tokens will be at: /workspace/extra/google-oauth/oauth.json');

  process.exit(0);
}

main().catch((err) => {
  console.error(`\n❌ ${err.message || err}`);
  process.exit(1);
});
