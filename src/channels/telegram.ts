/**
 * src/channels/telegram.ts
 * Telegram Channel Adapter for ProtoClaw.
 * 
 * Supports:
 * - Outbound delivery via Telegram Bot API (sendMessage)
 * - Inbound update translation to InboundEvent for Router ingestion
 * - Polling loop (getUpdates) for bidirectional standalone bot execution
 * - Zero third-party dependencies (native fetch in Node 22)
 */

import type { ChannelAdapter, DeliveryResult, OutboundDeliverMessage } from './types.js';
import type { InboundEvent } from '../types.js';
import type { DatabaseSync } from 'node:sqlite';
import { routeInbound } from '../router.js';

export interface TelegramChannelOptions {
  /** Telegram Bot API token from @BotFather (or process.env.TELEGRAM_BOT_TOKEN) */
  botToken?: string;
  /** Custom Telegram API base URL (defaults to 'https://api.telegram.org') */
  apiBaseUrl?: string;
  /** Optional fallback chat ID if message.platform_id is omitted */
  defaultChatId?: string | number;
  /** Optional bot username (e.g. 'my_protoclaw_bot') used for mention detection in groups */
  botUsername?: string;
  /** Parse mode for outgoing messages (e.g. 'MarkdownV2', 'HTML', 'Markdown', or undefined for plain text) */
  parseMode?: 'Markdown' | 'MarkdownV2' | 'HTML';
}

export interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    from?: {
      id: number;
      is_bot: boolean;
      first_name?: string;
      last_name?: string;
      username?: string;
    };
    chat: {
      id: number | string;
      type: 'private' | 'group' | 'supergroup' | 'channel';
      title?: string;
      username?: string;
    };
    date: number;
    text?: string;
    message_thread_id?: number;
  };
}

export interface TelegramPollOptions {
  db: DatabaseSync;
  pollIntervalMs?: number;
  timeoutSeconds?: number;
  signal?: AbortSignal;
  onEventRouted?: (event: InboundEvent) => void;
  onWake?: (sessionId: string) => void;
}

export class TelegramChannelAdapter implements ChannelAdapter {
  readonly channelType = 'telegram';
  private botToken: string;
  private apiBaseUrl: string;
  private defaultChatId?: string | number;
  private botUsername?: string;
  private parseMode?: string;
  public readonly deliveredHistory: OutboundDeliverMessage[] = [];

  constructor(options: TelegramChannelOptions = {}) {
    this.botToken =
      options.botToken !== undefined
        ? options.botToken
        : (typeof process !== 'undefined' ? process.env.TELEGRAM_BOT_TOKEN || '' : '');
    this.apiBaseUrl = (options.apiBaseUrl || 'https://api.telegram.org').replace(/\/+$/, '');
    this.defaultChatId = options.defaultChatId;
    this.botUsername = options.botUsername?.replace(/^@/, '');
    this.parseMode = options.parseMode;
  }

  /**
   * Delivers an outbound message to a Telegram chat via Telegram Bot API `sendMessage`.
   */
  async deliver(message: OutboundDeliverMessage): Promise<DeliveryResult> {
    const token =
      this.botToken !== undefined && this.botToken !== ''
        ? this.botToken
        : (typeof process !== 'undefined' ? process.env.TELEGRAM_BOT_TOKEN || '' : '');

    if (!token) {
      throw new Error(
        'TelegramChannelAdapter: TELEGRAM_BOT_TOKEN is missing. Pass it to the constructor or set TELEGRAM_BOT_TOKEN environment variable.'
      );
    }

    const chatId = message.platform_id || this.defaultChatId;
    if (!chatId) {
      throw new Error(
        `TelegramChannelAdapter: No platform_id (Telegram chat_id) specified for message ${message.id}.`
      );
    }

    const url = `${this.apiBaseUrl}/bot${token}/sendMessage`;

    const payload: Record<string, unknown> = {
      chat_id: chatId,
      text: message.content
    };

    if (message.thread_id) {
      const threadIdNum = Number(message.thread_id);
      if (!isNaN(threadIdNum)) {
        payload.message_thread_id = threadIdNum;
      }
    }

    if (this.parseMode) {
      payload.parse_mode = this.parseMode;
    }

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(30000) as any
    });

    if (!res.ok) {
      const errorText = await res.text().catch(() => '');
      let desc = errorText;
      try {
        const parsed = JSON.parse(errorText);
        if (parsed.description) {
          desc = parsed.description;
        }
      } catch {
        // use raw text
      }
      throw new Error(`Telegram API error (HTTP ${res.status}): ${desc || res.statusText}`);
    }

    const data = (await res.json()) as {
      ok: boolean;
      result?: {
        message_id: number;
      };
      description?: string;
    };

    if (!data.ok || !data.result) {
      throw new Error(`Telegram API returned error: ${data.description || 'Unknown error'}`);
    }

    this.deliveredHistory.push(message);

    return {
      platformMessageId: String(data.result.message_id)
    };
  }

  /**
   * Converts a Telegram Update object into an InboundEvent ready for the Router.
   */
  formatInboundUpdate(update: TelegramUpdate): InboundEvent | null {
    const msg = update.message;
    if (!msg || typeof msg.text !== 'string' || !msg.text.trim()) {
      return null;
    }

    const text = msg.text.trim();
    const isPrivate = msg.chat.type === 'private';
    const hasBotMention = this.botUsername
      ? new RegExp(`@${this.botUsername}\\b`, 'i').test(text)
      : false;

    // In private DMs, all messages are directed to the bot; in groups, check mentions
    const isMention = isPrivate || hasBotMention;

    const senderId = msg.from ? `telegram:${msg.from.id}` : `telegram:chat:${msg.chat.id}`;
    const displayName =
      msg.from?.username ||
      [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(' ') ||
      'Telegram User';

    return {
      channelType: 'telegram',
      platformId: String(msg.chat.id),
      threadId: msg.message_thread_id ? String(msg.message_thread_id) : null,
      sender: {
        id: senderId,
        displayName
      },
      text,
      isMention,
      timestamp: new Date(msg.date * 1000).toISOString()
    };
  }

  /**
   * Starts a long-polling loop against Telegram's `getUpdates` endpoint.
   * Feeds incoming messages directly into `routeInbound`.
   */
  async startPolling(options: TelegramPollOptions): Promise<void> {
    const token =
      this.botToken ||
      (typeof process !== 'undefined' ? process.env.TELEGRAM_BOT_TOKEN || '' : '');

    if (!token) {
      throw new Error('TelegramChannelAdapter: Cannot start polling without TELEGRAM_BOT_TOKEN.');
    }

    let lastUpdateId = 0;
    const timeout = options.timeoutSeconds ?? 20;

    while (!options.signal?.aborted) {
      try {
        const url = `${this.apiBaseUrl}/bot${token}/getUpdates?offset=${lastUpdateId + 1}&timeout=${timeout}`;
        const res = await fetch(url, {
          method: 'GET',
          signal: (options.signal ?? AbortSignal.timeout(45000)) as any
        });

        if (options.signal?.aborted) break;

        if (res.ok) {
          const data = (await res.json()) as {
            ok: boolean;
            result?: TelegramUpdate[];
          };

          if (data.ok && Array.isArray(data.result)) {
            for (const update of data.result) {
              if (update.update_id > lastUpdateId) {
                lastUpdateId = update.update_id;
              }

              const inboundEvent = this.formatInboundUpdate(update);
              if (inboundEvent) {
                await routeInbound(inboundEvent, options.db, options.onWake);
                options.onEventRouted?.(inboundEvent);
              }
            }
          }
        }
      } catch (err: any) {
        if (options.signal?.aborted) break;
        // Wait briefly before retrying polling on network error
        await new Promise((r) => setTimeout(r, options.pollIntervalMs ?? 1000));
      }

      if (options.signal?.aborted) break;
      if (options.pollIntervalMs) {
        await new Promise((r) => setTimeout(r, options.pollIntervalMs));
      }
    }
  }

  clearHistory(): void {
    this.deliveredHistory.length = 0;
  }
}

