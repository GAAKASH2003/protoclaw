/**
 * src/channels/whatsapp.ts
 * Official Meta WhatsApp Business Cloud API Adapter for ProtoClaw.
 * 
 * Supports:
 * - Outbound delivery via Meta Graph API (POST /v21.0/{phone_number_id}/messages)
 * - Inbound Webhook verification (GET /webhook with hub.challenge)
 * - Inbound message handling (POST /webhook) parsed into InboundEvent
 * - Built-in native HTTP server (zero external dependencies)
 */

import http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import type { ChannelAdapter, DeliveryResult, OutboundDeliverMessage } from './types.js';
import type { InboundEvent } from '../types.js';
import { routeInbound } from '../router.js';

export interface WhatsAppChannelOptions {
  /** Meta WhatsApp System User or Temporary Access Token */
  accessToken?: string;
  /** Phone Number ID from Meta Developer Portal */
  phoneNumberId?: string;
  /** Verification token configured in Meta App Webhook settings */
  verifyToken?: string;
  /** API Base URL (defaults to Meta Graph API v21.0) */
  apiBaseUrl?: string;
}

export interface WhatsAppWebhookOptions {
  port?: number;
  db: DatabaseSync;
  onWake?: (sessionId: string) => void;
  onEventRouted?: (event: InboundEvent) => void;
}

export class WhatsAppChannelAdapter implements ChannelAdapter {
  readonly channelType = 'whatsapp';
  private accessToken: string;
  private phoneNumberId: string;
  private verifyToken: string;
  private apiBaseUrl: string;
  public readonly deliveredHistory: OutboundDeliverMessage[] = [];

  constructor(options: WhatsAppChannelOptions = {}) {
    this.accessToken =
      options.accessToken !== undefined
        ? options.accessToken
        : (typeof process !== 'undefined' ? process.env.WHATSAPP_TOKEN || '' : '');
    this.phoneNumberId =
      options.phoneNumberId !== undefined
        ? options.phoneNumberId
        : (typeof process !== 'undefined' ? process.env.WHATSAPP_PHONE_NUMBER_ID || '' : '');
    this.verifyToken =
      options.verifyToken !== undefined
        ? options.verifyToken
        : (typeof process !== 'undefined' ? process.env.WHATSAPP_VERIFY_TOKEN || 'protoclaw_secret_123' : 'protoclaw_secret_123');
    this.apiBaseUrl = (options.apiBaseUrl || 'https://graph.facebook.com/v21.0').replace(/\/+$/, '');
  }

  /**
   * 1. Outbound Delivery: Sends message to recipient phone via Meta Graph API
   */
  async deliver(message: OutboundDeliverMessage): Promise<DeliveryResult> {
    const rawToken = this.accessToken || (typeof process !== 'undefined' ? process.env.WHATSAPP_TOKEN || '' : '');
    const rawPhoneId = this.phoneNumberId || (typeof process !== 'undefined' ? process.env.WHATSAPP_PHONE_NUMBER_ID || '' : '');
    const token = rawToken.trim().replace(/^["']|["']$/g, '');
    const phoneId = rawPhoneId.trim().replace(/^["']|["']$/g, '');

    if (!token) {
      throw new Error('WhatsAppChannelAdapter: WHATSAPP_TOKEN is missing.');
    }
    if (!phoneId) {
      throw new Error('WhatsAppChannelAdapter: WHATSAPP_PHONE_NUMBER_ID is missing.');
    }

    const recipientPhone = message.platform_id;
    if (!recipientPhone) {
      throw new Error(`WhatsAppChannelAdapter: No platform_id (phone number) provided for message ${message.id}.`);
    }

    const url = `${this.apiBaseUrl}/${phoneId}/messages`;
    const payload = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: recipientPhone.replace(/\D/g, ''), // Strip non-digit characters (+, spaces, hyphens)
      type: 'text',
      text: {
        preview_url: false,
        body: message.content
      }
    };

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
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
        if (parsed.error) {
          const code = parsed.error.code ? `[Code ${parsed.error.code}] ` : '';
          const sub = parsed.error.error_subcode ? `[Subcode ${parsed.error.error_subcode}] ` : '';
          desc = `${code}${sub}${parsed.error.message || 'Unknown error'} (${parsed.error.type || 'OAuthException'})`;
          if (res.status === 401 || parsed.error.code === 190) {
            desc += ` -> Hint: Meta temporary tokens expire after 24 hours. Please refresh WHATSAPP_TOKEN in .env.`;
          } else if (parsed.error.code === 131030) {
            desc += ` -> Hint: In Meta Development Mode, you must add the recipient's phone number to the allowed list in Meta Developer Portal (WhatsApp > API Setup > 'To' phone number list). Dummy test numbers like 16315551181 cannot receive WhatsApp messages.`;
          }
        }
      } catch {}
      throw new Error(`Meta WhatsApp API error (HTTP ${res.status}): ${desc || res.statusText}`);
    }

    const data = (await res.json()) as {
      messages?: Array<{ id: string }>;
    };

    const platformMessageId = data.messages?.[0]?.id || `wamid-${Date.now()}`;
    this.deliveredHistory.push(message);

    return { platformMessageId };
  }

  /**
   * 2. Inbound Webhook Handshake: Meta GET /webhook verification
   */
  verifyWebhook(query: URLSearchParams): { status: number; body: string } {
    const mode = query.get('hub.mode');
    const token = query.get('hub.verify_token');
    const challenge = query.get('hub.challenge');

    if (mode === 'subscribe' && token === this.verifyToken) {
      return { status: 200, body: challenge || '' };
    }
    return { status: 403, body: 'Forbidden: verification token mismatch' };
  }

  /**
   * 3. Inbound Payload Parser: Converts Meta Webhook JSON to ProtoClaw InboundEvent
   */
  formatInboundPayload(body: any): InboundEvent | null {
    const entry = body?.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;
    const message = value?.messages?.[0];

    // Ignore delivery receipts / read receipts / non-text updates
    if (!message || message.type !== 'text' || !message.text?.body) {
      return null;
    }

    const senderPhone = message.from; // e.g. "15551234567"
    const contactName = value.contacts?.[0]?.profile?.name || 'WhatsApp User';
    const text = message.text.body.trim();

    return {
      channelType: 'whatsapp',
      platformId: senderPhone,
      sender: {
        id: `whatsapp:${senderPhone}`,
        displayName: contactName
      },
      text,
      isMention: true, // Direct 1-on-1 messages are always active
      timestamp: new Date(Number(message.timestamp) * 1000).toISOString()
    };
  }

  /**
   * 4. Native HTTP Webhook Server (GET & POST)
   */
  startWebhookServer(options: WhatsAppWebhookOptions): http.Server {
    const port = options.port ?? 3000;

    const server = http.createServer(async (req: IncomingMessage, res: ServerResponse) => {
      const parsedUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

      // Route: GET /webhook (Meta Verification Handshake)
      if (req.method === 'GET' && parsedUrl.pathname === '/webhook') {
        const result = this.verifyWebhook(parsedUrl.searchParams);
        res.writeHead(result.status, { 'Content-Type': 'text/plain' });
        res.end(result.body);
        return;
      }

      // Route: POST /webhook (Incoming WhatsApp Messages)
      if (req.method === 'POST' && parsedUrl.pathname === '/webhook') {
        let bodyData = '';
        req.on('data', (chunk) => {
          bodyData += chunk.toString();
        });

        req.on('end', async () => {
          // Immediately acknowledge 200 OK to Meta so it does not retry
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'ok' }));

          try {
            const json = JSON.parse(bodyData);
            const inboundEvent = this.formatInboundPayload(json);

            if (inboundEvent) {
              await routeInbound(inboundEvent, options.db, options.onWake);
              options.onEventRouted?.(inboundEvent);
            }
          } catch (err) {
            console.error('[whatsapp webhook error]', err);
          }
        });
        return;
      }

      // Default 404
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
    });

    server.listen(port);
    return server;
  }

  clearHistory(): void {
    this.deliveredHistory.length = 0;
  }
}
