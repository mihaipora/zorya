import { Bot, InlineKeyboard } from 'grammy';

import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
import { getAllTasks, getRouterState, setRouterState } from '../db.js';
import { logger } from '../logger.js';
import type { QueueStatus } from '../group-queue.js';
import {
  Channel,
  EventProposal,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

export interface TelegramChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
  getStatus?: () => QueueStatus;
  onEventCallback?: (proposalId: string, action: string, ctx: any) => Promise<void>;
}

export class TelegramChannel implements Channel {
  name = 'telegram';

  private bot: Bot | null = null;
  private opts: TelegramChannelOpts;
  private botToken: string;

  constructor(botToken: string, opts: TelegramChannelOpts) {
    this.botToken = botToken;
    this.opts = opts;
  }

  async connect(): Promise<void> {
    this.bot = new Bot(this.botToken);

    // Command to get chat ID (useful for registration)
    this.bot.command('chatid', (ctx) => {
      const chatId = ctx.chat.id;
      const chatType = ctx.chat.type;
      const chatName =
        chatType === 'private'
          ? ctx.from?.first_name || 'Private'
          : (ctx.chat as any).title || 'Unknown';

      ctx.reply(
        `Chat ID: \`tg:${chatId}\`\nName: ${chatName}\nType: ${chatType}`,
        { parse_mode: 'Markdown' },
      );
    });

    // Command to check bot status
    this.bot.command('ping', (ctx) => {
      ctx.reply(`${ASSISTANT_NAME} is online.`);
    });

    // Verbose progress toggle
    this.bot.command('verbose', (ctx) => {
      const chatJid = `tg:${ctx.chat.id}`;
      setRouterState(`verbose:${chatJid}`, 'true');
      ctx.reply('Verbose mode *on* — you\'ll see tool progress updates.', { parse_mode: 'Markdown' });
    });

    this.bot.command('noverbose', (ctx) => {
      const chatJid = `tg:${ctx.chat.id}`;
      setRouterState(`verbose:${chatJid}`, 'false');
      ctx.reply('Verbose mode *off* — only text messages and results.', { parse_mode: 'Markdown' });
    });

    this.bot.command('status', (ctx) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const lines: string[] = [];

      // Queue status
      const status = this.opts.getStatus?.();
      if (status) {
        const busy = status.activeGroups.filter((g) => !g.idle);
        if (busy.length === 0) {
          lines.push('*Status:* Idle');
        } else {
          const groups = this.opts.registeredGroups();
          lines.push(`*Status:* ${busy.length}/${status.maxConcurrent} active`);
          for (const g of busy) {
            const groupName = groups[g.jid]?.name || g.jid;
            const snippet = g.promptSnippet
              ? g.promptSnippet.length > 50 ? g.promptSnippet.slice(0, 50).trimEnd() + '...' : g.promptSnippet
              : g.isTask ? 'scheduled task' : 'processing';
            lines.push(`  • _${groupName}:_ ${snippet}`);
          }
        }
        if (status.waitingCount > 0 || status.pendingTaskCount > 0) {
          lines.push(`*Queue:* ${status.waitingCount} waiting, ${status.pendingTaskCount} pending tasks`);
        }
      }

      // Verbose mode
      const isVerbose = getRouterState(`verbose:${chatJid}`) === 'true';
      lines.push(`*Verbose:* ${isVerbose ? 'on' : 'off'}`);

      // Scheduled tasks
      const tasks = getAllTasks().filter((t) => t.status === 'active');
      if (tasks.length > 0) {
        lines.push('');
        lines.push(`*Scheduled tasks:* ${tasks.length}`);
        for (const t of tasks) {
          const truncated = t.prompt.length > 40 ? t.prompt.slice(0, 40).trimEnd() + '...' : t.prompt;
          const nextStr = t.next_run
            ? new Date(t.next_run).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false })
            : 'none';
          const schedule = t.schedule_type === 'once' ? 'once' : t.schedule_value;
          lines.push(`  • ${truncated}`);
          lines.push(`    _${schedule} — next: ${nextStr}_`);
        }
      }

      ctx.reply(lines.join('\n'), { parse_mode: 'Markdown' });
    });

    // Handle inline keyboard callbacks (event proposals, etc.)
    this.bot.on('callback_query:data', async (ctx) => {
      const data = ctx.callbackQuery.data;
      if (!data?.startsWith('event:')) return;

      const [, action, proposalId] = data.split(':');
      if (this.opts.onEventCallback) {
        await this.opts.onEventCallback(proposalId, action, ctx);
      }
    });

    this.bot.on('message:text', async (ctx) => {
      // Skip commands
      if (ctx.message.text.startsWith('/')) return;

      const chatJid = `tg:${ctx.chat.id}`;
      let content = ctx.message.text;
      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id.toString() ||
        'Unknown';
      const sender = ctx.from?.id.toString() || '';
      const msgId = ctx.message.message_id.toString();

      // Determine chat name
      const chatName =
        ctx.chat.type === 'private'
          ? senderName
          : (ctx.chat as any).title || chatJid;

      // Translate Telegram @bot_username mentions into TRIGGER_PATTERN format.
      // Telegram @mentions (e.g., @andy_ai_bot) won't match TRIGGER_PATTERN
      // (e.g., ^@Andy\b), so we prepend the trigger when the bot is @mentioned.
      const botUsername = ctx.me?.username?.toLowerCase();
      if (botUsername) {
        const entities = ctx.message.entities || [];
        const isBotMentioned = entities.some((entity) => {
          if (entity.type === 'mention') {
            const mentionText = content
              .substring(entity.offset, entity.offset + entity.length)
              .toLowerCase();
            return mentionText === `@${botUsername}`;
          }
          return false;
        });
        if (isBotMentioned && !TRIGGER_PATTERN.test(content)) {
          content = `@${ASSISTANT_NAME} ${content}`;
        }
      }

      // Store chat metadata for discovery
      this.opts.onChatMetadata(chatJid, timestamp, chatName);

      // Only deliver full message for registered groups
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) {
        logger.debug(
          { chatJid, chatName },
          'Message from unregistered Telegram chat',
        );
        return;
      }

      // Deliver message — startMessageLoop() will pick it up
      this.opts.onMessage(chatJid, {
        id: msgId,
        chat_jid: chatJid,
        sender,
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
      });

      logger.info(
        { chatJid, chatName, sender: senderName },
        'Telegram message stored',
      );
    });

    // Handle non-text messages with placeholders so the agent knows something was sent
    const storeNonText = (ctx: any, placeholder: string) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id?.toString() ||
        'Unknown';
      const caption = ctx.message.caption ? ` ${ctx.message.caption}` : '';

      this.opts.onChatMetadata(chatJid, timestamp);
      this.opts.onMessage(chatJid, {
        id: ctx.message.message_id.toString(),
        chat_jid: chatJid,
        sender: ctx.from?.id?.toString() || '',
        sender_name: senderName,
        content: `${placeholder}${caption}`,
        timestamp,
        is_from_me: false,
      });
    };

    this.bot.on('message:photo', (ctx) => storeNonText(ctx, '[Photo]'));
    this.bot.on('message:video', (ctx) => storeNonText(ctx, '[Video]'));
    this.bot.on('message:voice', (ctx) =>
      storeNonText(ctx, '[Voice message]'),
    );
    this.bot.on('message:audio', (ctx) => storeNonText(ctx, '[Audio]'));
    this.bot.on('message:document', (ctx) => {
      const name = ctx.message.document?.file_name || 'file';
      storeNonText(ctx, `[Document: ${name}]`);
    });
    this.bot.on('message:sticker', (ctx) => {
      const emoji = ctx.message.sticker?.emoji || '';
      storeNonText(ctx, `[Sticker ${emoji}]`);
    });
    this.bot.on('message:location', (ctx) => storeNonText(ctx, '[Location]'));
    this.bot.on('message:contact', (ctx) => storeNonText(ctx, '[Contact]'));

    // Handle errors gracefully
    this.bot.catch((err) => {
      logger.error({ err: err.message }, 'Telegram bot error');
    });

    // Start polling — returns a Promise that resolves when started
    return new Promise<void>((resolve) => {
      this.bot!.start({
        onStart: (botInfo) => {
          logger.info(
            { username: botInfo.username, id: botInfo.id },
            'Telegram bot connected',
          );
          console.log(`\n  Telegram bot: @${botInfo.username}`);
          console.log(
            `  Send /chatid to the bot to get a chat's registration ID\n`,
          );
          resolve();
        },
      });
    });
  }

  async sendEventProposal(jid: string, proposal: EventProposal): Promise<string | undefined> {
    if (!this.bot) {
      logger.warn('Telegram bot not initialized');
      return undefined;
    }

    try {
      const numericId = jid.replace(/^tg:/, '');

      const startDate = new Date(proposal.start_time);
      const endDate = new Date(proposal.end_time);
      const dateStr = startDate.toLocaleDateString('en-GB', {
        weekday: 'short', day: 'numeric', month: 'short',
      });
      const startStr = startDate.toLocaleTimeString('en-GB', {
        hour: '2-digit', minute: '2-digit',
      });
      const endStr = endDate.toLocaleTimeString('en-GB', {
        hour: '2-digit', minute: '2-digit',
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
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send event proposal');
      return undefined;
    }
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.bot) {
      logger.warn('Telegram bot not initialized');
      return;
    }

    try {
      const numericId = jid.replace(/^tg:/, '');

      const sendChunk = async (chunk: string) => {
        try {
          await this.bot!.api.sendMessage(numericId, chunk, { parse_mode: 'Markdown' });
        } catch {
          // Markdown parse failed — retry as plain text
          await this.bot!.api.sendMessage(numericId, chunk);
        }
      };

      // Telegram has a 4096 character limit per message — split if needed
      const MAX_LENGTH = 4096;
      if (text.length <= MAX_LENGTH) {
        await sendChunk(text);
      } else {
        for (let i = 0; i < text.length; i += MAX_LENGTH) {
          await sendChunk(text.slice(i, i + MAX_LENGTH));
        }
      }
      logger.info({ jid, length: text.length }, 'Telegram message sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Telegram message');
    }
  }

  isConnected(): boolean {
    return this.bot !== null;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('tg:');
  }

  async disconnect(): Promise<void> {
    if (this.bot) {
      this.bot.stop();
      this.bot = null;
      logger.info('Telegram bot stopped');
    }
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!this.bot || !isTyping) return;
    try {
      const numericId = jid.replace(/^tg:/, '');
      await this.bot.api.sendChatAction(numericId, 'typing');
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to send Telegram typing indicator');
    }
  }
}
