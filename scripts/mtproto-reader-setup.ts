#!/usr/bin/env tsx
/**
 * MTProto Reader Setup Script for NanoClaw
 *
 * One-time script to authenticate with Telegram via GramJS and save the session.
 * The session is used by the MTProto Reader (integrated into the main process).
 *
 * Usage:
 *   npx tsx scripts/mtproto-reader-setup.ts
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import readline from 'readline';

import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';

const HOME = os.homedir();
const MTPROTO_DIR = path.join(HOME, '.mtproto-reader');
const ENV_PATH = path.join(process.cwd(), '.env');
const DATA_DIR = path.join(process.cwd(), 'data');
const SESSION_PATH = path.join(DATA_DIR, 'mtproto-session');

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

/**
 * Read a key from the .env file. Returns empty string if not found.
 */
function readEnvKey(key: string): string {
  if (!fs.existsSync(ENV_PATH)) return '';
  const content = fs.readFileSync(ENV_PATH, 'utf-8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const k = trimmed.slice(0, eqIdx).trim();
    if (k !== key) continue;
    let value = trimmed.slice(eqIdx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    return value;
  }
  return '';
}

/**
 * Set a key=value in the .env file. Replaces existing key or appends.
 */
function setEnvKey(key: string, value: string): void {
  let content = '';
  if (fs.existsSync(ENV_PATH)) {
    content = fs.readFileSync(ENV_PATH, 'utf-8');
  }

  const lines = content.split('\n');
  let found = false;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const k = trimmed.slice(0, eqIdx).trim();
    if (k === key) {
      lines[i] = `${key}=${value}`;
      found = true;
      break;
    }
  }

  if (!found) {
    // Ensure trailing newline before appending
    if (content.length > 0 && !content.endsWith('\n')) {
      lines.push('');
    }
    lines.push(`${key}=${value}`);
  }

  fs.writeFileSync(ENV_PATH, lines.join('\n'));
}

// --- Step 1: Get API credentials ---

async function getApiCredentials(): Promise<{ apiId: number; apiHash: string }> {
  // Check if credentials already exist in .env
  const existingId = readEnvKey('MTPROTO_API_ID');
  const existingHash = readEnvKey('MTPROTO_API_HASH');
  if (existingId && existingHash) {
    console.log('Using existing API credentials from .env');
    return { apiId: parseInt(existingId, 10), apiHash: existingHash };
  }

  // Fall back to old config location
  const oldConfigFile = path.join(MTPROTO_DIR, 'config.json');
  if (fs.existsSync(oldConfigFile)) {
    const existing = JSON.parse(fs.readFileSync(oldConfigFile, 'utf-8'));
    if (existing.apiId && existing.apiHash) {
      console.log(`Migrating API credentials from ${oldConfigFile} to .env`);
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
  // Check for existing session in new location, then old location
  let existingSession = '';
  if (fs.existsSync(SESSION_PATH)) {
    existingSession = fs.readFileSync(SESSION_PATH, 'utf-8').trim();
  } else {
    const oldSessionFile = path.join(MTPROTO_DIR, 'session');
    if (fs.existsSync(oldSessionFile)) {
      existingSession = fs.readFileSync(oldSessionFile, 'utf-8').trim();
      console.log('Found existing session in old location, will migrate');
    }
  }

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

function saveConfig(apiId: number, apiHash: string): void {
  setEnvKey('MTPROTO_API_ID', String(apiId));
  setEnvKey('MTPROTO_API_HASH', apiHash);
  console.log('Saved MTPROTO_API_ID and MTPROTO_API_HASH to .env');
}

function saveSession(sessionString: string): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(SESSION_PATH, sessionString + '\n');
  fs.chmodSync(SESSION_PATH, 0o600);
  console.log(`Saved session to ${SESSION_PATH}`);
}

// --- Step 4: Print restart instructions ---

function printRestartInstructions(): void {
  console.log('\n=== Activation ===\n');
  console.log('MTProto Reader is now built into the main NanoClaw process.');
  console.log('Restart to activate:\n');

  if (process.platform === 'darwin') {
    console.log('  launchctl kickstart -k gui/$(id -u)/com.nanoclaw');
  } else {
    console.log('  systemctl --user restart nanoclaw');
  }

  console.log('\nOr test manually:');
  console.log('  npm run build && npm run dev');
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
  saveConfig(apiId, apiHash);
  saveSession(sessionString);

  // Step 4: Print restart instructions
  printRestartInstructions();

  console.log('\nDone!');

  process.exit(0);
}

main().catch((err) => {
  console.error(`\n❌ ${err.message || err}`);
  process.exit(1);
});
