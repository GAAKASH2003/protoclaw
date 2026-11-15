import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import { TelegramChannelAdapter } from '../src/channels/telegram.js';
import { registerChannelAdapter, clearChannelAdapters } from '../src/channels/registry.js';
import { deliverSessionMessages } from '../src/delivery.js';
import { 
  provisionSessionStorage, 
  sessionDir, 
  inboundDbPath, 
  outboundDbPath 
} from '../src/session-manager.js';
import { 
  openInboundDb, 
  openOutboundDb, 
  writeMessageOut 
} from '../src/mailbox/session-db.js';

describe('Telegram Channel Adapter', () => {
  const agentGroupId = 'test-agent';
  let sessionIndex = 0;
  let currentSessionId: string;
  let currentSessionDir: string;

  beforeEach(() => {
    sessionIndex++;
    currentSessionId = `test-tg-${Date.now()}-${sessionIndex}`;
    currentSessionDir = sessionDir(agentGroupId, currentSessionId);
    provisionSessionStorage(agentGroupId, currentSessionId);
    clearChannelAdapters();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    clearChannelAdapters();
    if (fs.existsSync(currentSessionDir)) {
      try {
        fs.rmSync(currentSessionDir, { recursive: true, force: true });
      } catch {
        // Ignore transient lock cleanup during test teardown
      }
    }
  });

  describe('Outbound Delivery', () => {
    it('throws when TELEGRAM_BOT_TOKEN is missing', async () => {
      const oldToken = process.env.TELEGRAM_BOT_TOKEN;
      delete process.env.TELEGRAM_BOT_TOKEN;

      const adapter = new TelegramChannelAdapter({ botToken: '' });

      await expect(
        adapter.deliver({
          id: 'out-1',
          seq: 1,
          timestamp: new Date().toISOString(),
          kind: 'text',
          platform_id: '12345678',
          content: 'Hello'
        })
      ).rejects.toThrow('TELEGRAM_BOT_TOKEN is missing');

      if (oldToken) process.env.TELEGRAM_BOT_TOKEN = oldToken;
    });

    it('throws when platform_id (chat_id) is missing and no defaultChatId is set', async () => {
      const adapter = new TelegramChannelAdapter({ botToken: 'mock-bot-token' });

      await expect(
        adapter.deliver({
          id: 'out-1',
          seq: 1,
          timestamp: new Date().toISOString(),
          kind: 'text',
          platform_id: null,
          content: 'Hello'
        })
      ).rejects.toThrow('No platform_id (Telegram chat_id) specified');
    });

    it('sends message via Telegram Bot API and parses platform message ID', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          ok: true,
          result: {
            message_id: 99482
          }
        })
      });
      vi.stubGlobal('fetch', mockFetch);

      const adapter = new TelegramChannelAdapter({
        botToken: '12345:mock-token',
        botUsername: 'protoclaw_bot',
        parseMode: 'HTML'
      });

      const res = await adapter.deliver({
        id: 'msg-1',
        seq: 1,
        timestamp: new Date().toISOString(),
        kind: 'text',
        channel_type: 'telegram',
        platform_id: '100200300',
        thread_id: '42',
        content: '<b>Hello Telegram!</b>'
      });

      expect(res.platformMessageId).toBe('99482');
      expect(adapter.deliveredHistory.length).toBe(1);
      expect(mockFetch).toHaveBeenCalledTimes(1);

      const [calledUrl, calledOptions] = mockFetch.mock.calls[0];
      expect(calledUrl).toBe('https://api.telegram.org/bot12345:mock-token/sendMessage');

      const body = JSON.parse(calledOptions.body);
      expect(body).toEqual({
        chat_id: '100200300',
        text: '<b>Hello Telegram!</b>',
        message_thread_id: 42,
        parse_mode: 'HTML'
      });
    });

    it('handles Telegram API error responses', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        statusText: 'Bad Request',
        text: async () => JSON.stringify({ ok: false, error_code: 400, description: 'chat not found' })
      }));

      const adapter = new TelegramChannelAdapter({ botToken: 'mock-token' });

      await expect(
        adapter.deliver({
          id: 'out-1',
          seq: 1,
          timestamp: new Date().toISOString(),
          kind: 'text',
          platform_id: 'invalid-chat',
          content: 'Ping'
        })
      ).rejects.toThrow('Telegram API error (HTTP 400): chat not found');
    });
  });

  describe('Inbound Update Parsing', () => {
    const adapter = new TelegramChannelAdapter({
      botToken: 'mock-token',
      botUsername: 'protoclaw_bot'
    });

    it('parses private DM messages as always-mentioned', () => {
      const event = adapter.formatInboundUpdate({
        update_id: 101,
        message: {
          message_id: 50,
          date: 1700000000,
          chat: { id: 12345, type: 'private' },
          from: { id: 12345, is_bot: false, username: 'alice', first_name: 'Alice' },
          text: 'Hello bot'
        }
      });

      expect(event).toBeDefined();
      expect(event?.channelType).toBe('telegram');
      expect(event?.platformId).toBe('12345');
      expect(event?.sender.id).toBe('telegram:12345');
      expect(event?.sender.displayName).toBe('alice');
      expect(event?.text).toBe('Hello bot');
      expect(event?.isMention).toBe(true);
    });

    it('parses group messages and detects bot username mention', () => {
      // 1. Group message without mention
      const eventNoMention = adapter.formatInboundUpdate({
        update_id: 102,
        message: {
          message_id: 51,
          date: 1700000000,
          chat: { id: -100999, type: 'supergroup', title: 'Dev Group' },
          from: { id: 777, is_bot: false, first_name: 'Bob' },
          text: 'General chat message'
        }
      });
      expect(eventNoMention?.isMention).toBe(false);

      // 2. Group message with mention
      const eventWithMention = adapter.formatInboundUpdate({
        update_id: 103,
        message: {
          message_id: 52,
          date: 1700000000,
          chat: { id: -100999, type: 'supergroup', title: 'Dev Group' },
          from: { id: 777, is_bot: false, first_name: 'Bob' },
          text: 'Hey @protoclaw_bot can you help me?'
        }
      });
      expect(eventWithMention?.isMention).toBe(true);
    });

    it('extracts thread_id from forum topic updates', () => {
      const event = adapter.formatInboundUpdate({
        update_id: 104,
        message: {
          message_id: 53,
          date: 1700000000,
          chat: { id: -100888, type: 'supergroup' },
          message_thread_id: 999,
          from: { id: 888, is_bot: false },
          text: 'Thread message'
        }
      });

      expect(event?.threadId).toBe('999');
    });

    it('returns null for non-text messages', () => {
      const event = adapter.formatInboundUpdate({
        update_id: 105,
        message: {
          message_id: 54,
          date: 1700000000,
          chat: { id: 12345, type: 'private' }
          // no text
        }
      });

      expect(event).toBeNull();
    });
  });

  describe('Integration with Delivery Engine', () => {
    it('dispatches telegram messages and updates delivered ledger in inbound.db', async () => {
      const inPath = inboundDbPath(agentGroupId, currentSessionId);
      const outPath = outboundDbPath(agentGroupId, currentSessionId);

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          ok: true,
          result: { message_id: 77112 }
        })
      });
      vi.stubGlobal('fetch', mockFetch);

      const adapter = new TelegramChannelAdapter({ botToken: 'test-token' });
      registerChannelAdapter(adapter);

      // 1. Write an outbound message targeted to telegram
      const outDb = openOutboundDb(outPath, false);
      let outMsg;
      try {
        outMsg = writeMessageOut(outDb, {
          content: 'Hello Telegram User',
          channel_type: 'telegram',
          platform_id: '99887766'
        });
      } finally {
        outDb.close();
      }

      // 2. Deliver via Delivery Engine
      const res = await deliverSessionMessages(agentGroupId, currentSessionId);

      expect(res.delivered).toBe(1);
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(adapter.deliveredHistory.length).toBe(1);

      // 3. Verify receipt recorded in inbound.db
      const inDb = openInboundDb(inPath);
      try {
        const receipt = inDb.prepare('SELECT * FROM delivered WHERE message_out_id = ?').get(outMsg.id) as any;
        expect(receipt).toBeDefined();
        expect(receipt.status).toBe('delivered');
        expect(receipt.platform_message_id).toBe('77112');
      } finally {
        inDb.close();
      }
    });
  });
});

