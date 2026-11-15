/**
 * src/channels/discord.ts
 * Official Discord Channel Adapter for ProtoClaw.
 * 
 * Supports:
 * - Outbound delivery via Discord REST API v10 (POST /channels/{channel_id}/messages)
 * - Automatic message chunking for messages exceeding Discord's 2000-character limit
 * - Inbound Discord message parsing to InboundEvent for Router ingestion
 * - Bot mention detection (<@bot_id>, <@!bot_id>, and mentions array)
 * - Real-time Gateway WebSocket connection using Node 22 native WebSocket
 * - Zero third-party dependencies (no discord.js required)
 */

import type { ChannelAdapter, DeliveryResult, OutboundDeliverMessage } from './types.js';
import type { InboundEvent } from '../types.js';
import type { DatabaseSync } from 'node:sqlite';
import { routeInbound } from '../router.js';

export interface DiscordChannelOptions {
  /** Discord Bot token from Discord Developer Portal */
  botToken?: string;
  /** Custom Discord API base URL (defaults to 'https://discord.com/api/v10') */
  apiBaseUrl?: string;
  /** Optional fallback Discord channel ID if message.platform_id is omitted */
  defaultChannelId?: string;
  /** Optional Bot Application/User ID used for mention detection */
  botUserId?: string;
}

export interface DiscordMessageAuthor {
  id: string;
  username: string;
  discriminator?: string;
  global_name?: string | null;
  bot?: boolean;
}

export interface DiscordUserMention {
  id: string;
  username: string;
}

export interface DiscordMessage {
  id: string;
  channel_id: string;
  guild_id?: string;
  author: DiscordMessageAuthor;
  content: string;
  timestamp?: string;
  mentions?: DiscordUserMention[];
  message_reference?: {
    message_id?: string;
    channel_id?: string;
    guild_id?: string;
  };
  thread?: {
    id: string;
    name?: string;
  };
}

export interface DiscordGatewayOptions {
  db: DatabaseSync;
  token?: string;
  signal?: AbortSignal;
  onWake?: (sessionId: string) => void;
  onEventRouted?: (event: InboundEvent) => void;
  /** Gateway intents bitmask. Defaults to GUILDS | GUILD_MESSAGES | DIRECT_MESSAGES | MESSAGE_CONTENT (37377) */
  intents?: number;
}

export class DiscordChannelAdapter implements ChannelAdapter {
  readonly channelType = 'discord';
  private botToken: string;
  private apiBaseUrl: string;
  private defaultChannelId?: string;
  public botUserId?: string;
  public readonly deliveredHistory: OutboundDeliverMessage[] = [];

  constructor(options: DiscordChannelOptions = {}) {
    this.botToken =
      options.botToken !== undefined
        ? options.botToken
        : (typeof process !== 'undefined' ? process.env.DISCORD_BOT_TOKEN || '' : '');
    this.apiBaseUrl = (options.apiBaseUrl || 'https://discord.com/api/v10').replace(/\/+$/, '');
    this.defaultChannelId = options.defaultChannelId;
    this.botUserId =
      options.botUserId !== undefined
        ? options.botUserId
        : (typeof process !== 'undefined' ? process.env.DISCORD_CLIENT_ID || '' : '');
  }

  /**
   * 1. Outbound Delivery: Sends a message to a Discord channel via REST API
   */
  async deliver(message: OutboundDeliverMessage): Promise<DeliveryResult> {
    const rawToken =
      this.botToken !== undefined && this.botToken !== ''
        ? this.botToken
        : (typeof process !== 'undefined' ? process.env.DISCORD_BOT_TOKEN || '' : '');
    const token = rawToken.trim().replace(/^["']|["']$/g, '');

    if (!token) {
      throw new Error(
        'DiscordChannelAdapter: DISCORD_BOT_TOKEN is missing. Pass it to the constructor or set DISCORD_BOT_TOKEN in .env.'
      );
    }

    const channelId = message.platform_id || this.defaultChannelId;
    if (!channelId) {
      throw new Error(
        `DiscordChannelAdapter: No platform_id (Discord channel_id) specified for message ${message.id}.`
      );
    }

    // Split content if it exceeds Discord's 2000-character limit
    const chunks = this.chunkContent(message.content, 2000);
    let lastMessageId: string | null = null;

    for (const chunk of chunks) {
      const url = `${this.apiBaseUrl}/channels/${channelId}/messages`;
      const payload: Record<string, any> = {
        content: chunk
      };

      const res = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bot ${token}`,
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
          if (parsed.message) {
            desc = `${parsed.message} (code ${parsed.code || res.status})`;
          }
        } catch {}
        throw new Error(`Discord API error (HTTP ${res.status}): ${desc || res.statusText}`);
      }

      const data = (await res.json()) as { id?: string };
      lastMessageId = data.id || `discord-${Date.now()}`;
    }

    this.deliveredHistory.push(message);
    return { platformMessageId: lastMessageId };
  }

  /**
   * Splits message content into clean chunks respecting word boundaries and Discord's 2000-character limit.
   */
  chunkContent(text: string, maxLength = 2000): string[] {
    if (!text || text.length <= maxLength) return [text || ''];
    const chunks: string[] = [];
    let remaining = text;

    while (remaining.length > 0) {
      if (remaining.length <= maxLength) {
        chunks.push(remaining);
        break;
      }

      // Find natural split point (newline or space)
      let splitIndex = remaining.lastIndexOf('\n', maxLength);
      if (splitIndex === -1 || splitIndex < maxLength / 2) {
        splitIndex = remaining.lastIndexOf(' ', maxLength);
      }
      if (splitIndex === -1 || splitIndex < maxLength / 2) {
        splitIndex = maxLength;
      }

      chunks.push(remaining.slice(0, splitIndex).trimEnd());
      remaining = remaining.slice(splitIndex).trimStart();
    }

    return chunks;
  }

  /**
   * 2. Inbound Message Parsing: Converts Discord MESSAGE_CREATE payload to InboundEvent
   */
  parseMessage(msg: DiscordMessage): InboundEvent | null {
    // 1. Ignore messages from bots to prevent infinite response loops
    if (msg.author?.bot) {
      return null;
    }

    const trimmed = (msg.content || '').trim();
    if (!trimmed) {
      return null;
    }

    // 2. Mention detection
    let isMention = false;
    const botId = this.botUserId || (typeof process !== 'undefined' ? process.env.DISCORD_CLIENT_ID || '' : '');
    if (botId) {
      const mentionPatterns = [`<@${botId}>`, `<@!${botId}>`];
      isMention =
        mentionPatterns.some((pattern) => msg.content.includes(pattern)) ||
        (msg.mentions ? msg.mentions.some((m) => m.id === botId) : false);
    }

    return {
      channelType: 'discord',
      platformId: msg.channel_id,
      threadId: msg.thread?.id || null,
      sender: {
        id: `discord:${msg.author.id}`,
        displayName: msg.author.global_name || msg.author.username
      },
      text: trimmed,
      isMention,
      timestamp: msg.timestamp || new Date().toISOString()
    };
  }

  /**
   * 3. Inbound Gateway: Connects to Discord Gateway via native WebSocket for real-time messages
   */
  connectGateway(options: DiscordGatewayOptions): { close: () => void } {
    const rawToken =
      options.token ||
      this.botToken ||
      (typeof process !== 'undefined' ? process.env.DISCORD_BOT_TOKEN || '' : '');
    const token = rawToken.trim().replace(/^["']|["']$/g, '');

    if (!token) {
      throw new Error('DiscordChannelAdapter: DISCORD_BOT_TOKEN is missing for Gateway connection.');
    }

    // Intents: GUILDS (1) | GUILD_MESSAGES (512) | DIRECT_MESSAGES (4096) | MESSAGE_CONTENT (32768)
    const intents = options.intents ?? (1 | 512 | 4096 | 32768);
    const gatewayUrl = 'wss://gateway.discord.gg/?v=10&encoding=json';

    let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    let lastSequence: number | null = null;

    const ws = new WebSocket(gatewayUrl);

    const cleanup = () => {
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
    };

    if (options.signal) {
      options.signal.addEventListener('abort', () => {
        cleanup();
        try {
          ws.close(1000, 'Aborted');
        } catch {}
      });
    }

    ws.onmessage = async (event: MessageEvent) => {
      try {
        const payload = JSON.parse(event.data.toString());
        const { op, d, s, t } = payload;

        if (s !== null && s !== undefined) {
          lastSequence = s;
        }

        // Opcode 10: Hello -> start heartbeat interval and identify
        if (op === 10) {
          const heartbeatInterval = d.heartbeat_interval;
          heartbeatTimer = setInterval(() => {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ op: 1, d: lastSequence }));
            }
          }, heartbeatInterval);

          // Identify payload
          ws.send(
            JSON.stringify({
              op: 2,
              d: {
                token,
                intents,
                properties: {
                  os: process.platform,
                  browser: 'protoclaw',
                  device: 'protoclaw'
                }
              }
            })
          );
        }

        // Opcode 1: Heartbeat requested by Discord -> send immediately
        if (op === 1) {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ op: 1, d: lastSequence }));
          }
        }

        // Opcode 0: Dispatch events
        if (op === 0) {
          if (t === 'READY') {
            if (d.user) {
              this.botUserId = d.user.id;
            }
          } else if (t === 'MESSAGE_CREATE') {
            const inboundEvent = this.parseMessage(d);
            if (inboundEvent) {
              const routes = await routeInbound(inboundEvent, options.db);
              if (options.onEventRouted) {
                options.onEventRouted(inboundEvent);
              }
              const routed = routes.find((r) => r.status === 'routed');
              if (routed && options.onWake) {
                options.onWake(routed.sessionId);
              }
            }
          }
        }
      } catch (err) {
        // Silently ignore malformed frames
      }
    };

    ws.onclose = () => {
      cleanup();
    };

    return {
      close: () => {
        cleanup();
        try {
          ws.close(1000, 'Closed by user');
        } catch {}
      }
    };
  }

  clearHistory(): void {
    this.deliveredHistory.length = 0;
  }
}
