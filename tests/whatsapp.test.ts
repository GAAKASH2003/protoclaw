import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import { WhatsAppChannelAdapter } from '../src/channels/whatsapp.js';
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

describe('WhatsApp Cloud API Channel Adapter', () => {
  const agentGroupId = 'test-agent';
  let sessionIndex = 0;
  let currentSessionId: string;
  let currentSessionDir: string;

  beforeEach(() => {
    sessionIndex++;
    currentSessionId = `test-wa-${Date.now()}-${sessionIndex}`;
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
      } catch {}
    }
  });

  describe('Outbound Delivery', () => {
    it('throws when WHATSAPP_TOKEN is missing', async () => {
      const oldToken = process.env.WHATSAPP_TOKEN;
      delete process.env.WHATSAPP_TOKEN;

      const adapter = new WhatsAppChannelAdapter({ accessToken: '', phoneNumberId: '12345' });

      await expect(
        adapter.deliver({
          id: 'out-1',
          seq: 1,
          timestamp: new Date().toISOString(),
          kind: 'text',
          platform_id: '15551234567',
          content: 'Hello'
        })
      ).rejects.toThrow('WHATSAPP_TOKEN is missing');

      if (oldToken) process.env.WHATSAPP_TOKEN = oldToken;
    });

    it('throws when WHATSAPP_PHONE_NUMBER_ID is missing', async () => {
      const oldId = process.env.WHATSAPP_PHONE_NUMBER_ID;
      delete process.env.WHATSAPP_PHONE_NUMBER_ID;

      const adapter = new WhatsAppChannelAdapter({ accessToken: 'valid-token', phoneNumberId: '' });

      await expect(
        adapter.deliver({
          id: 'out-1',
          seq: 1,
          timestamp: new Date().toISOString(),
          kind: 'text',
          platform_id: '15551234567',
          content: 'Hello'
        })
      ).rejects.toThrow('WHATSAPP_PHONE_NUMBER_ID is missing');

      if (oldId) process.env.WHATSAPP_PHONE_NUMBER_ID = oldId;
    });

    it('sends text message via Meta Graph API and parses message ID', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          messaging_product: 'whatsapp',
          contacts: [{ input: '15551234567', wa_id: '15551234567' }],
          messages: [{ id: 'wamid.HBgLMTE1...' }]
        })
      });
      vi.stubGlobal('fetch', mockFetch);

      const adapter = new WhatsAppChannelAdapter({
        accessToken: 'test-meta-token',
        phoneNumberId: '987654321'
      });

      const res = await adapter.deliver({
        id: 'out-1',
        seq: 1,
        timestamp: new Date().toISOString(),
        kind: 'text',
        channel_type: 'whatsapp',
        platform_id: '+1 (555) 123-4567', // formatted phone number
        content: 'Hello from ProtoClaw!'
      });

      expect(res.platformMessageId).toBe('wamid.HBgLMTE1...');
      expect(adapter.deliveredHistory.length).toBe(1);
      expect(mockFetch).toHaveBeenCalledTimes(1);

      const [calledUrl, calledOptions] = mockFetch.mock.calls[0];
      expect(calledUrl).toBe('https://graph.facebook.com/v21.0/987654321/messages');
      expect(calledOptions.headers['Authorization']).toBe('Bearer test-meta-token');

      const body = JSON.parse(calledOptions.body);
      expect(body).toEqual({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: '15551234567', // cleaned digits
        type: 'text',
        text: {
          preview_url: false,
          body: 'Hello from ProtoClaw!'
        }
      });
    });

    it('handles Meta API error responses cleanly', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        statusText: 'Bad Request',
        text: async () => JSON.stringify({
          error: {
            message: 'Recipient phone number not in allowed list',
            type: 'OAuthException',
            code: 131030
          }
        })
      }));

      const adapter = new WhatsAppChannelAdapter({
        accessToken: 'token',
        phoneNumberId: 'phone-id'
      });

      await expect(
        adapter.deliver({
          id: 'out-1',
          seq: 1,
          timestamp: new Date().toISOString(),
          kind: 'text',
          platform_id: '15559999999',
          content: 'Hi'
        })
      ).rejects.toThrow('Recipient phone number not in allowed list (OAuthException)');
    });
  });

  describe('Webhook Verification Handshake', () => {
    const adapter = new WhatsAppChannelAdapter({
      verifyToken: 'my_custom_secret'
    });

    it('returns challenge when verify_token matches', () => {
      const query = new URLSearchParams({
        'hub.mode': 'subscribe',
        'hub.verify_token': 'my_custom_secret',
        'hub.challenge': '1158201444'
      });

      const res = adapter.verifyWebhook(query);
      expect(res.status).toBe(200);
      expect(res.body).toBe('1158201444');
    });

    it('returns 403 when verify_token is incorrect', () => {
      const query = new URLSearchParams({
        'hub.mode': 'subscribe',
        'hub.verify_token': 'wrong_secret',
        'hub.challenge': '1158201444'
      });

      const res = adapter.verifyWebhook(query);
      expect(res.status).toBe(403);
      expect(res.body).toContain('Forbidden');
    });
  });

  describe('Inbound Payload Parsing', () => {
    const adapter = new WhatsAppChannelAdapter({
      verifyToken: 'my_secret'
    });

    it('converts Meta WhatsApp incoming message payload to InboundEvent', () => {
      const metaPayload = {
        object: 'whatsapp_business_account',
        entry: [
          {
            id: 'WHATSAPP_BUSINESS_ACCOUNT_ID',
            changes: [
              {
                value: {
                  messaging_product: 'whatsapp',
                  metadata: {
                    display_phone_number: '15550000000',
                    phone_number_id: '1049281729'
                  },
                  contacts: [
                    {
                      profile: { name: 'Alice Smith' },
                      wa_id: '15551234567'
                    }
                  ],
                  messages: [
                    {
                      from: '15551234567',
                      id: 'wamid.HBgL...',
                      timestamp: '1700000000',
                      text: { body: 'Can you summarize this?' },
                      type: 'text'
                    }
                  ]
                },
                field: 'messages'
              }
            ]
          }
        ]
      };

      const event = adapter.formatInboundPayload(metaPayload);

      expect(event).toBeDefined();
      expect(event?.channelType).toBe('whatsapp');
      expect(event?.platformId).toBe('15551234567');
      expect(event?.sender.id).toBe('whatsapp:15551234567');
      expect(event?.sender.displayName).toBe('Alice Smith');
      expect(event?.text).toBe('Can you summarize this?');
      expect(event?.isMention).toBe(true);
    });

    it('ignores delivery status and read receipt updates', () => {
      const statusPayload = {
        entry: [
          {
            changes: [
              {
                value: {
                  statuses: [{ id: 'wamid.HB...', status: 'delivered' }]
                }
              }
            ]
          }
        ]
      };

      expect(adapter.formatInboundPayload(statusPayload)).toBeNull();
    });
  });

  describe('Integration with Delivery Engine', () => {
    it('dispatches whatsapp messages and updates delivered table in inbound.db', async () => {
      const inPath = inboundDbPath(agentGroupId, currentSessionId);
      const outPath = outboundDbPath(agentGroupId, currentSessionId);

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          messages: [{ id: 'wamid.test-12345' }]
        })
      });
      vi.stubGlobal('fetch', mockFetch);

      const adapter = new WhatsAppChannelAdapter({
        accessToken: 'test-token',
        phoneNumberId: 'phone-123'
      });
      registerChannelAdapter(adapter);

      // 1. Write an outbound message targeted to whatsapp
      const outDb = openOutboundDb(outPath, false);
      let outMsg;
      try {
        outMsg = writeMessageOut(outDb, {
          content: 'Hello WhatsApp User',
          channel_type: 'whatsapp',
          platform_id: '15559876543'
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
        expect(receipt.platform_message_id).toBe('wamid.test-12345');
      } finally {
        inDb.close();
      }
    });
  });
});

