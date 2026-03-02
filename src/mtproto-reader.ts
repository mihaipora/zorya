/**
 * MTProto Reader — GramJS client + route handlers for read-only Telegram access
 *
 * Holds the GramJS MTProto session and provides route handlers for the tools proxy.
 * The agent calls this from inside the container via the telegram-reader CLI tool.
 *
 * Lifecycle: connectMtproto/disconnectMtproto
 * Route handler: handleMtprotoRequest (registered with tools-proxy)
 */
import fs from 'fs';
import http from 'http';
import path from 'path';

import bigInt from 'big-integer';
import { Api, TelegramClient } from 'telegram';
import type { Entity } from 'telegram/define.js';
import { StringSession } from 'telegram/sessions/index.js';

import { MTPROTO_API_ID, MTPROTO_API_HASH, DATA_DIR } from './config.js';
import { logger } from './logger.js';

// Module-level refs for lifecycle management
let _client: TelegramClient | null = null;
let _myName = 'Me';

// --- Types ---

interface PendingChat {
  chatId: string;
  chatName: string;
  chatType: 'private' | 'group' | 'channel';
  lastMessage: {
    sender: string;
    text: string;
    date: string;
  };
  unreadCount: number;
}

interface ConversationMessage {
  id: number;
  sender: string;
  text: string;
  date: string;
  replyTo: number | null;
}

// --- Helpers ---

function mediaPlaceholder(msg: Api.Message): string {
  if (msg.photo) return '[Photo]';
  if (msg.video) return '[Video]';
  if (msg.sticker) return '[Sticker]';
  if (msg.voice) return '[Voice message]';
  if (msg.videoNote) return '[Video note]';
  if (msg.gif) return '[GIF]';
  if (msg.document) {
    const doc = msg.document as Api.Document;
    const nameAttr = doc.attributes?.find(
      (a): a is Api.DocumentAttributeFilename =>
        a.className === 'DocumentAttributeFilename',
    );
    const filename = nameAttr?.fileName || 'file';
    return `[Document: ${filename}]`;
  }
  if (msg.contact) return '[Contact]';
  if (msg.geo) return '[Location]';
  if (msg.poll) return '[Poll]';
  return '[Media]';
}

function getChatType(_dialog: Api.Dialog, entity: Entity): 'private' | 'group' | 'channel' {
  if (entity instanceof Api.User) return 'private';
  if (entity instanceof Api.Channel && entity.broadcast) return 'channel';
  return 'group';
}

function getChatName(entity: Entity): string {
  if (entity instanceof Api.User) {
    const parts = [entity.firstName, entity.lastName].filter(Boolean);
    return parts.join(' ') || entity.username || 'Unknown';
  }
  if (entity instanceof Api.Chat || entity instanceof Api.Channel) {
    return entity.title || 'Unknown';
  }
  return 'Unknown';
}

function getChatId(entity: Entity): string {
  if (entity instanceof Api.User) return entity.id.toString();
  if (entity instanceof Api.Chat) return entity.id.negate().toString();
  if (entity instanceof Api.Channel) {
    // Channels use -100 prefix
    return bigInt('-1000000000000').subtract(entity.id).toString();
  }
  return '0';
}

function jsonResponse(res: http.ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function errorResponse(res: http.ServerResponse, status: number, message: string): void {
  jsonResponse(res, status, { error: message });
}

// --- Route handlers ---

async function handlePendingReplies(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  if (!_client?.connected) {
    errorResponse(res, 503, 'Not connected to Telegram');
    return;
  }

  const url = new URL(req.url!, `http://localhost`);
  const limitParam = url.searchParams.get('limit');
  const limit = Math.min(Math.max(parseInt(limitParam || '20', 10) || 20, 1), 50);

  const dialogs = await _client.getDialogs({ limit });
  const pending: PendingChat[] = [];

  for (const dialog of dialogs) {
    const entity = dialog.entity;
    if (!entity) continue;

    // Exclude bots
    if (entity instanceof Api.User && entity.bot) continue;

    // Exclude broadcast channels
    if (entity instanceof Api.Channel && entity.broadcast) continue;

    // Filter: unread or last message not from me
    const isFromMe = dialog.message?.out === true;
    if (dialog.unreadCount === 0 && isFromMe) continue;

    // Exclude service messages
    if (dialog.message && !(dialog.message instanceof Api.Message)) continue;

    const msg = dialog.message as Api.Message | undefined;
    const chatType = getChatType(dialog.dialog, entity);
    let senderName = 'Unknown';

    if (msg) {
      if (msg.out) {
        senderName = 'Me';
      } else if (chatType === 'private') {
        senderName = getChatName(entity);
      } else {
        try {
          const sender = await msg.getSender();
          if (sender && sender instanceof Api.User) {
            senderName = sender.firstName || sender.username || 'Unknown';
          }
        } catch {
          senderName = 'Unknown';
        }
      }
    }

    pending.push({
      chatId: getChatId(entity),
      chatName: getChatName(entity),
      chatType,
      lastMessage: {
        sender: senderName,
        text: msg?.message || (msg ? mediaPlaceholder(msg) : ''),
        date: msg ? new Date(msg.date * 1000).toISOString() : '',
      },
      unreadCount: dialog.unreadCount,
    });
  }

  jsonResponse(res, 200, pending);
}

async function handleConversations(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  if (!_client?.connected) {
    errorResponse(res, 503, 'Not connected to Telegram');
    return;
  }

  const url = new URL(req.url!, `http://localhost`);
  const daysParam = url.searchParams.get('days');
  const limitParam = url.searchParams.get('limit');
  const days = Math.min(Math.max(parseInt(daysParam || '7', 10) || 7, 1), 30);
  const limit = Math.min(Math.max(parseInt(limitParam || '50', 10) || 50, 1), 100);

  const cutoff = Math.floor(Date.now() / 1000) - days * 86400;

  const dialogs = await _client.getDialogs({ limit });
  const results: Array<{
    chatId: string;
    chatName: string;
    chatType: 'private' | 'group' | 'channel';
    lastMessage: { sender: string; text: string; date: string };
    lastMessageIsFromMe: boolean;
    unreadCount: number;
  }> = [];

  for (const dialog of dialogs) {
    const entity = dialog.entity;
    if (!entity) continue;

    // Exclude bots
    if (entity instanceof Api.User && entity.bot) continue;

    // Exclude broadcast channels
    if (entity instanceof Api.Channel && entity.broadcast) continue;

    // Exclude service messages
    if (dialog.message && !(dialog.message instanceof Api.Message)) continue;

    const msg = dialog.message as Api.Message | undefined;

    // Filter by time window
    if (!msg || msg.date < cutoff) continue;

    const chatType = getChatType(dialog.dialog, entity);
    let senderName = 'Unknown';

    if (msg.out) {
      senderName = 'Me';
    } else if (chatType === 'private') {
      senderName = getChatName(entity);
    } else {
      try {
        const sender = await msg.getSender();
        if (sender && sender instanceof Api.User) {
          senderName = sender.firstName || sender.username || 'Unknown';
        }
      } catch {
        senderName = 'Unknown';
      }
    }

    results.push({
      chatId: getChatId(entity),
      chatName: getChatName(entity),
      chatType,
      lastMessage: {
        sender: senderName,
        text: msg.message || mediaPlaceholder(msg),
        date: new Date(msg.date * 1000).toISOString(),
      },
      lastMessageIsFromMe: msg.out === true,
      unreadCount: dialog.unreadCount,
    });
  }

  jsonResponse(res, 200, results);
}

async function handleConversation(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  chatIdStr: string,
): Promise<void> {
  if (!_client?.connected) {
    errorResponse(res, 503, 'Not connected to Telegram');
    return;
  }

  const url = new URL(req.url!, `http://localhost`);
  const limitParam = url.searchParams.get('limit');
  const limit = Math.min(Math.max(parseInt(limitParam || '20', 10) || 20, 1), 100);

  // Parse chat ID — can be negative for groups/channels
  const chatId = bigInt(chatIdStr);

  let entity: Entity;
  try {
    entity = await _client.getEntity(chatId) as Entity;
  } catch {
    errorResponse(res, 404, `Chat not found: ${chatIdStr}`);
    return;
  }

  const messages = await _client.getMessages(entity, { limit });
  const result: ConversationMessage[] = [];

  for (const msg of messages) {
    if (!(msg instanceof Api.Message)) continue;

    let senderName: string;
    if (msg.out) {
      senderName = 'Me';
    } else {
      try {
        const sender = await msg.getSender();
        if (sender && sender instanceof Api.User) {
          senderName = sender.firstName || sender.username || 'Unknown';
        } else if (sender && (sender instanceof Api.Chat || sender instanceof Api.Channel)) {
          senderName = sender.title || 'Unknown';
        } else {
          senderName = 'Unknown';
        }
      } catch {
        senderName = 'Unknown';
      }
    }

    result.push({
      id: msg.id,
      sender: senderName,
      text: msg.message || mediaPlaceholder(msg),
      date: new Date(msg.date * 1000).toISOString(),
      replyTo: msg.replyTo?.replyToMsgId ?? null,
    });
  }

  jsonResponse(res, 200, {
    chatId: chatIdStr,
    chatName: getChatName(entity),
    messages: result,
  });
}

async function handleHealth(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  jsonResponse(res, 200, {
    status: 'ok',
    connected: _client?.connected ?? false,
    user: _myName,
  });
}

// --- Exported route handler ---

export async function handleMtprotoRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const url = new URL(req.url!, 'http://localhost');
  const pathname = url.pathname;

  if (req.method !== 'GET') {
    errorResponse(res, 404, 'Not found');
    return;
  }

  if (pathname === '/health') {
    await handleHealth(req, res);
  } else if (pathname === '/pending-replies') {
    await handlePendingReplies(req, res);
  } else if (pathname === '/conversations') {
    await handleConversations(req, res);
  } else if (pathname.startsWith('/conversation/')) {
    const chatIdStr = pathname.slice('/conversation/'.length);
    if (!chatIdStr || !/^-?\d+$/.test(chatIdStr)) {
      errorResponse(res, 400, 'Invalid chat ID');
      return;
    }
    await handleConversation(req, res, chatIdStr);
  } else {
    errorResponse(res, 404, 'Not found');
  }
}

// --- Exported lifecycle functions ---

export async function connectMtproto(): Promise<void> {
  if (!MTPROTO_API_ID || !MTPROTO_API_HASH) {
    logger.info('MTProto Reader not configured, skipping');
    return;
  }

  const sessionPath = path.join(DATA_DIR, 'mtproto-session');
  if (!fs.existsSync(sessionPath)) {
    logger.info('MTProto session not found, skipping');
    return;
  }

  const sessionString = fs.readFileSync(sessionPath, 'utf-8').trim();

  try {
    logger.info('MTProto Reader: connecting to Telegram...');
    const client = new TelegramClient(
      new StringSession(sessionString),
      MTPROTO_API_ID,
      MTPROTO_API_HASH,
      { connectionRetries: 5 },
    );

    await client.connect();
    _client = client;

    const me = await client.getMe() as Api.User;
    _myName = me.firstName || me.username || 'Me';
    logger.info({ user: _myName }, 'MTProto Reader: connected');
  } catch (err) {
    logger.error({ err }, 'MTProto Reader failed to start');
  }
}

export async function disconnectMtproto(): Promise<void> {
  if (_client) {
    try {
      await _client.disconnect();
    } catch {
      // ignore disconnect errors during shutdown
    }
    _client = null;
  }
}
