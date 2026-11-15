import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import { DiscordChannelAdapter } from '../src/channels/discord.js';
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

describe('Discord Channel Adapter', () => {
  const agentGroupId = 'test-agent';
  let sessionIndex = 0;
  let currentSessionId: string;
  let currentSessionDir: string;

  beforeEach(() => {
    sessionIndex++;
    currentSessionId = `test-discord-${Date.now()}-${sessionIndex}`;
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
    it('throws when DISCORD_BOT_TOKEN is missing', async () => {
      const oldToken = process.env.DISCORD_BOT_TOKEN;
      delete process.env.DISCORD_BOT_TOKEN;

      const adapter = new DiscordChannelAdapter({ botToken: '' });

      await expect(
        adapter.deliver({
          id: 'out-1',
          seq: 1,
          timestamp: new Date().toISOString(),
          kind: 'text',
          platform_id: '123456789012345678',
          content: 'Hello Discord'
        })
      ).rejects.toThrow('DISCORD_BOT_TOKEN is missing');

      if (oldToken) process.env.DISCORD_BOT_TOKEN = oldToken;
    });

    it('throws when platform_id (channel_id) is missing and no defaultChannelId is set', async () => {
      const adapter = new DiscordChannelAdapter({ botToken: 'mock-discord-token' });

      await expect(
        adapter.deliver({
          id: 'out-1',
          seq: 1,
          timestamp: new Date().toISOString(),
          kind: 'text',
          platform_id: null,
          content: 'Hello'
        })
      ).rejects.toThrow('No platform_id (Discord channel_id) specified');
    });

    it('sends message via Discord REST API v10 and returns platform message ID', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          id: '112233445566778899',
          channel_id: '987654321012345678',
          content: 'Hello from ProtoClaw!'
        })
      });
      vi.stubGlobal('fetch', mockFetch);

      const adapter = new DiscordChannelAdapter({
        botToken: 'mock-bot-token-xyz',
        defaultChannelId: '987654321012345678'
      });

      const res = await adapter.deliver({
        id: 'msg-1',
        seq: 1,
        timestamp: new Date().toISOString(),
        kind: 'text',
        platform_id: '987654321012345678',
        content: 'Hello from ProtoClaw!'
      });

      expect(res.platformMessageId).toBe('112233445566778899');
      expect(mockFetch).toHaveBeenCalledTimes(1);

      const [calledUrl, calledOptions] = mockFetch.mock.calls[0];
      expect(calledUrl).toBe('https://discord.com/api/v10/channels/987654321012345678/messages');
      expect(calledOptions.headers['Authorization']).toBe('Bot mock-bot-token-xyz');
      expect(calledOptions.headers['Content-Type']).toBe('application/json');

      const body = JSON.parse(calledOptions.body);
      expect(body.content).toBe('Hello from ProtoClaw!');
    });

    it('handles Discord API error responses cleanly', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 403,
        statusText: 'Forbidden',
        text: async () => JSON.stringify({ message: 'Missing Permissions', code: 50013 })
      });
      vi.stubGlobal('fetch', mockFetch);

      const adapter = new DiscordChannelAdapter({ botToken: 'test-token' });

      await expect(
        adapter.deliver({
          id: 'msg-err',
          seq: 1,
          timestamp: new Date().toISOString(),
          kind: 'text',
          platform_id: '987654321012345678',
          content: 'Should fail'
        })
      ).rejects.toThrow('Discord API error (HTTP 403): Missing Permissions (code 50013)');
    });

    it('chunks messages exceeding 2000 characters and delivers each chunk', async () => {
      let callCount = 0;
      const mockFetch = vi.fn().mockImplementation(async () => {
        callCount++;
        return {
          ok: true,
          json: async () => ({
            id: `chunk-id-${callCount}`,
            channel_id: '987654321012345678'
          })
        };
      });
      vi.stubGlobal('fetch', mockFetch);

      const adapter = new DiscordChannelAdapter({ botToken: 'test-token' });

      // Create a 3500-character message
      const longMessage = 'A'.repeat(1800) + '\n' + 'B'.repeat(1700);

      const res = await adapter.deliver({
        id: 'msg-long',
        seq: 1,
        timestamp: new Date().toISOString(),
        kind: 'text',
        platform_id: '987654321012345678',
        content: longMessage
      });

      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(res.platformMessageId).toBe('chunk-id-2');
    });
  });

  describe('Message Chunking & Utility', () => {
    const adapter = new DiscordChannelAdapter();

    it('keeps messages within 2000 characters intact', () => {
      const short = 'Short text within limit';
      expect(adapter.chunkContent(short)).toEqual([short]);
    });

    it('splits message cleanly at newlines when possible', () => {
      const part1 = 'Paragraph 1\n';
      const part2 = 'Paragraph 2';
      const text = part1 + part2;
      const chunks = adapter.chunkContent(text, 15);
      expect(chunks.length).toBe(2);
      expect(chunks[0]).toBe('Paragraph 1');
      expect(chunks[1]).toBe('Paragraph 2');
    });
  });

  describe('Inbound Message Parsing', () => {
    const adapter = new DiscordChannelAdapter({
      botUserId: '999888777'
    });

    it('converts Discord MESSAGE_CREATE payload to InboundEvent', () => {
      const event = adapter.parseMessage({
        id: '123456789',
        channel_id: 'channel-456',
        author: {
          id: 'user-789',
          username: 'janedoe',
          global_name: 'Jane Doe',
          bot: false
        },
        content: 'Hello bot!',
        timestamp: '2026-11-14T10:00:00.000Z'
      });

      expect(event).not.toBeNull();
      expect(event?.channelType).toBe('discord');
      expect(event?.platformId).toBe('channel-456');
      expect(event?.sender.id).toBe('discord:user-789');
      expect(event?.sender.displayName).toBe('Jane Doe');
      expect(event?.text).toBe('Hello bot!');
      expect(event?.isMention).toBe(false);
    });

    it('ignores messages sent by other bots', () => {
      const event = adapter.parseMessage({
        id: '123456789',
        channel_id: 'channel-456',
        author: {
          id: 'bot-999',
          username: 'another-bot',
          bot: true
        },
        content: 'Automated notification'
      });

      expect(event).toBeNull();
    });

    it('detects user mentions of the bot', () => {
      const event = adapter.parseMessage({
        id: '123456789',
        channel_id: 'channel-456',
        author: {
          id: 'user-789',
          username: 'janedoe'
        },
        content: '<@999888777> What is Dual-DB Mailbox IPC?'
      });

      expect(event).not.toBeNull();
      expect(event?.isMention).toBe(true);
    });

    it('ignores empty message contents', () => {
      const event = adapter.parseMessage({
        id: '123456789',
        channel_id: 'channel-456',
        author: {
          id: 'user-789',
          username: 'janedoe'
        },
        content: '    '
      });

      expect(event).toBeNull();
    });
  });

  describe('Integration with Delivery Engine', () => {
    it('dispatches discord messages and updates delivered table in inbound.db', async () => {
      const inPath = inboundDbPath(agentGroupId, currentSessionId);
      const outPath = outboundDbPath(agentGroupId, currentSessionId);

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ id: 'discord-msg-999' })
      });
      vi.stubGlobal('fetch', mockFetch);

      const adapter = new DiscordChannelAdapter({ botToken: 'mock-discord-token' });
      registerChannelAdapter(adapter);

      // Write outbound response
      const outDb = openOutboundDb(outPath, false);
      let outMsg;
      try {
        outMsg = writeMessageOut(outDb, {
          content: 'Hello Discord from ProtoClaw!',
          channel_type: 'discord',
          platform_id: '998877665544332211'
        });
      } finally {
        outDb.close();
      }

      // Run Host delivery engine
      const result = await deliverSessionMessages(agentGroupId, currentSessionId);

      expect(result.delivered).toBe(1);
      expect(adapter.deliveredHistory.length).toBe(1);
      expect(adapter.deliveredHistory[0].id).toBe(outMsg.id);

      // Verify delivery receipt in host-owned inbound.db
      const inDb = openInboundDb(inPath);
      try {
        const receipt = inDb.prepare('SELECT * FROM delivered WHERE message_out_id = ?').get(outMsg.id) as any;
        expect(receipt).toBeDefined();
        expect(receipt.status).toBe('delivered');
        expect(receipt.platform_message_id).toBe('discord-msg-999');
      } finally {
        inDb.close();
      }
    });
  });
});
