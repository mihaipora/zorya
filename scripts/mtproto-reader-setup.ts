#!/usr/bin/env tsx
/**
 * MTProto Reader Setup Script for NanoClaw
 *
 * One-time script to authenticate with Telegram via GramJS and save the session.
 * The session is used by the MTProto Reader HTTP server (src/mtproto-reader.ts).
 *
 * Usage:
 *   npx tsx scripts/mtproto-reader-setup.ts
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import readline from 'readline';

import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';

const HOME = os.homedir();
const MTPROTO_DIR = path.join(HOME, '.mtproto-reader');
const DOCS_DIR = path.join(MTPROTO_DIR, 'docs');
const SESSION_FILE = path.join(MTPROTO_DIR, 'session');
const CONFIG_FILE = path.join(MTPROTO_DIR, 'config.json');
const CLAUDE_MD_PATH = path.join(DOCS_DIR, 'CLAUDE.md');
const ALLOWLIST_PATH = path.join(HOME, '.config', 'nanoclaw', 'mount-allowlist.json');
const DB_PATH = path.join(process.cwd(), 'store', 'messages.db');

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

// --- Step 1: Get API credentials ---

async function getApiCredentials(): Promise<{ apiId: number; apiHash: string }> {
  // Check if config already exists
  if (fs.existsSync(CONFIG_FILE)) {
    const existing = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
    if (existing.apiId && existing.apiHash) {
      console.log(`Using existing API credentials from ${CONFIG_FILE}`);
      return { apiId: existing.apiId, apiHash: existing.apiHash };
    }
  }

  console.log('Get your API credentials from https://my.telegram.org\n');

  const apiIdStr = await ask('API ID: ');
  const apiId = parseInt(apiIdStr, 10);
  if (isNaN(apiId)) die('API ID must be a number');

  const apiHash = await ask('API Hash: ');
  if (!apiHash) die('API Hash is required');

  return { apiId, apiHash };
}

// --- Step 2: Authenticate with Telegram ---

async function authenticate(apiId: number, apiHash: string): Promise<string> {
  const existingSession = fs.existsSync(SESSION_FILE)
    ? fs.readFileSync(SESSION_FILE, 'utf-8').trim()
    : '';

  const client = new TelegramClient(
    new StringSession(existingSession),
    apiId,
    apiHash,
    { connectionRetries: 5 },
  );

  await client.start({
    phoneNumber: async () => ask('Phone number (with country code): '),
    phoneCode: async () => ask('Verification code: '),
    password: async () => ask('2FA password: '),
    onError: (err) => console.error('Auth error:', err.message),
  });

  console.log('\nAuthenticated successfully!');

  const sessionString = client.session.save() as unknown as string;
  await client.disconnect();
  return sessionString;
}

// --- Step 3: Save config and session ---

function saveConfig(apiId: number, apiHash: string, port: number): void {
  fs.mkdirSync(MTPROTO_DIR, { recursive: true });

  const config = { apiId, apiHash, port };
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + '\n');
  fs.chmodSync(CONFIG_FILE, 0o600);
  console.log(`Saved config to ${CONFIG_FILE}`);
}

function saveSession(sessionString: string): void {
  fs.writeFileSync(SESSION_FILE, sessionString + '\n');
  fs.chmodSync(SESSION_FILE, 0o600);
  console.log(`Saved session to ${SESSION_FILE}`);
}

// --- Step 4: Write CLAUDE.md ---

function writeClaudeMd(): void {
  fs.mkdirSync(DOCS_DIR, { recursive: true });

  const content = `# Telegram Reader — Conversation Access

The \`telegram-reader\` CLI tool provides read-only access to the user's Telegram conversations.

## Commands

\`\`\`bash
# List all conversations updated in the past 7 days
telegram-reader conversations

# Narrow the time window
telegram-reader conversations --days 1

# List chats where you have pending replies (unread or last message not from you)
telegram-reader pending

# Read messages from a specific chat
telegram-reader conversation <chatId>

# More messages
telegram-reader conversation <chatId> --limit 50

# Check if the reader is running
telegram-reader health
\`\`\`

## Flags

| Flag | Description |
|------|-------------|
| \`--json\` | Output raw JSON instead of formatted text |
| \`--limit N\` | Max results (default: 20; conversations: 50) |
| \`--days N\` | Time window for conversations (default: 7, max: 30) |

## Common Patterns

- **Review recent conversations:** \`telegram-reader conversations --days 7\` then \`telegram-reader conversation <chatId>\` for each that needs attention
- **Check pending replies:** \`telegram-reader pending\`
- **Read conversation context:** \`telegram-reader conversation <chatId>\` (use chatId from conversations/pending output)
- **Morning briefing:** combine \`telegram-reader conversations --days 1\` + \`google-api gmail list --days 1\` + \`google-api calendar today\`

## Notes

- Read-only — cannot send, delete, or modify messages
- Chat IDs are numeric (can be negative for groups)
- Media messages show as placeholders: [Photo], [Document: file.pdf], [Voice message]
`;

  fs.writeFileSync(CLAUDE_MD_PATH, content);
  console.log(`Wrote agent docs to ${CLAUDE_MD_PATH}`);
}

// --- Step 5: Update mount allowlist ---

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

  const alreadyPresent = allowlist.allowedRoots.some(
    (r: { path?: string }) => r.path === '~/.mtproto-reader/docs',
  );

  if (!alreadyPresent) {
    allowlist.allowedRoots.push({
      path: '~/.mtproto-reader/docs',
      allowReadWrite: false,
      description: 'MTProto reader docs (read-only)',
    });
    fs.writeFileSync(ALLOWLIST_PATH, JSON.stringify(allowlist, null, 2) + '\n');
    console.log(`Updated mount allowlist: added ~/.mtproto-reader/docs as allowed root`);
  } else {
    console.log(`Mount allowlist already contains ~/.mtproto-reader/docs`);
  }
}

// --- Step 6: Update group container_config in SQLite ---

function updateGroupContainerConfig(): void {
  if (!fs.existsSync(DB_PATH)) {
    console.log(`\nDatabase not found at ${DB_PATH}, skipping container config update.`);
    console.log('Run the bot first to initialize the database, then re-run this script.');
    return;
  }

  const db = new Database(DB_PATH);

  try {
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

    const alreadyPresent = mounts.some(
      (m) => m.hostPath === '~/.mtproto-reader/docs',
    );

    if (!alreadyPresent) {
      mounts.push({ hostPath: '~/.mtproto-reader/docs', containerPath: 'mtproto-reader', readonly: true });
      config.additionalMounts = mounts;

      db.prepare(
        'UPDATE registered_groups SET container_config = ? WHERE jid = ?',
      ).run(JSON.stringify(config), row.jid);

      console.log(`Updated main group container config: added ~/.mtproto-reader/docs mount`);
    } else {
      console.log(`Main group container config already has ~/.mtproto-reader/docs mount`);
    }
  } finally {
    db.close();
  }
}

// --- Step 7: Print service instructions ---

function printServiceInstructions(): void {
  const nodePath = process.execPath;
  const projectDir = process.cwd();
  const serverScript = path.join(projectDir, 'dist', 'mtproto-reader.js');

  console.log('\n=== Service Installation ===\n');

  if (process.platform === 'darwin') {
    const plistPath = path.join(HOME, 'Library', 'LaunchAgents', 'com.nanoclaw-mtproto-reader.plist');
    const logDir = path.join(projectDir, 'logs');

    console.log(`Create ${plistPath} with:\n`);
    console.log(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.nanoclaw-mtproto-reader</string>
    <key>ProgramArguments</key>
    <array>
        <string>${nodePath}</string>
        <string>${serverScript}</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${projectDir}</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${logDir}/mtproto-reader.log</string>
    <key>StandardErrorPath</key>
    <string>${logDir}/mtproto-reader.error.log</string>
</dict>
</plist>`);

    console.log(`\nThen run:`);
    console.log(`  mkdir -p ${logDir}`);
    console.log(`  launchctl load ${plistPath}`);
  } else {
    const serviceDir = path.join(HOME, '.config', 'systemd', 'user');
    const servicePath = path.join(serviceDir, 'nanoclaw-mtproto-reader.service');

    console.log(`Create ${servicePath} with:\n`);
    console.log(`[Unit]
Description=NanoClaw MTProto Reader
After=network.target

[Service]
ExecStart=${nodePath} ${serverScript}
WorkingDirectory=${projectDir}
Restart=always
RestartSec=10

[Install]
WantedBy=default.target`);

    console.log(`\nThen run:`);
    console.log(`  mkdir -p ${serviceDir}`);
    console.log(`  systemctl --user enable --now nanoclaw-mtproto-reader`);
  }

  console.log('\nOr test manually:');
  console.log(`  npm run build && node ${serverScript}`);
}

// --- Main ---

async function main(): Promise<void> {
  console.log('MTProto Reader Setup for NanoClaw');
  console.log('=================================\n');

  // Step 1: Get API credentials
  const { apiId, apiHash } = await getApiCredentials();

  // Step 2: Authenticate with Telegram
  const sessionString = await authenticate(apiId, apiHash);

  // Step 3: Save config and session
  saveConfig(apiId, apiHash, 8081);
  saveSession(sessionString);

  // Step 4: Write CLAUDE.md
  writeClaudeMd();

  // Step 5: Update mount allowlist
  updateMountAllowlist();

  // Step 6: Update group container_config
  updateGroupContainerConfig();

  // Step 7: Print service instructions
  printServiceInstructions();

  console.log('\nDone! Build and start the server:');
  console.log('  npm run build && node dist/mtproto-reader.js');

  process.exit(0);
}

main().catch((err) => {
  console.error(`\n❌ ${err.message || err}`);
  process.exit(1);
});
