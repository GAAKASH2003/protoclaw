

import { openInboundDb, openOutboundDb, markDelivered, readWithRetry } from './mailbox/session-db.js';
import { inboundDbPath, outboundDbPath } from './session-manager.js';
import { getChannelAdapter } from './channels/registry.js';
import type { OutboundDeliverMessage } from './channels/types.js';

export interface DeliveryCycleResult {
  delivered: number;
}

export interface DeliveryLoopConfig {
  agentGroupId: string;
  sessionId: string;
  intervalMs?: number;
  signal?: AbortSignal;
}

const warnedSkippedMessages = new Set<string>();
const inFlightMessageIds = new Set<string>();
const activeDeliverySessions = new Set<string>();

/**
 * Delivers all pending outbound messages for a given session.
 * Enforces in-flight deduplication to prevent duplicate platform dispatches.
 */
export async function deliverSessionMessages(
  agentGroupId: string,
  sessionId: string
): Promise<DeliveryCycleResult> {
  const sessionKey = `${agentGroupId}:${sessionId}`;
  if (activeDeliverySessions.has(sessionKey)) {
    return { delivered: 0 };
  }
  activeDeliverySessions.add(sessionKey);

  const inPath = inboundDbPath(agentGroupId, sessionId);
  const outPath = outboundDbPath(agentGroupId, sessionId);

  const inDb = openInboundDb(inPath);
  let deliveredCount = 0;

  try {
    // Open runner-owned outbound.db read-only
    const outDb = openOutboundDb(outPath, true);
    try {
      // 1. Fetch already delivered message IDs from host-owned inbound.db
      const deliveredRows = inDb.prepare('SELECT message_out_id FROM delivered').all() as { message_out_id: string }[];
      const deliveredSet = new Set(deliveredRows.map((r) => r.message_out_id));

      // 2. Read outbound messages (with retry loop for VirtioFS consistency)
      const outboundMessages = readWithRetry(() => {
        return outDb.prepare('SELECT * FROM messages_out ORDER BY seq ASC').all() as unknown as OutboundDeliverMessage[];
      });

      // 3. Filter for undelivered messages that are not already in-flight
      const pending = outboundMessages.filter((msg) => !deliveredSet.has(msg.id) && !inFlightMessageIds.has(msg.id));

      for (const msg of pending) {
        if (inFlightMessageIds.has(msg.id)) continue;
        inFlightMessageIds.add(msg.id);

        try {
          const channelType = msg.channel_type || 'cli';
          const adapter = getChannelAdapter(channelType);

          if (!adapter) {
            if (!warnedSkippedMessages.has(msg.id)) {
              warnedSkippedMessages.add(msg.id);
              console.warn(`[delivery] No adapter found for channel_type: '${channelType}'. Skipping msg: ${msg.id}`);
            }
            continue;
          }

          // 4. Dispatch through the channel adapter
          const result = await adapter.deliver(msg);

          // 5. Host records delivery receipt in inbound.db (Single-Writer rule!)
          markDelivered(inDb, msg.id, result?.platformMessageId ?? null);
          deliveredCount++;
        } finally {
          inFlightMessageIds.delete(msg.id);
        }
      }
    } finally {
      outDb.close();
    }
  } finally {
    inDb.close();
    activeDeliverySessions.delete(sessionKey);
  }

  return { delivered: deliveredCount };
}

/**
 * Continuously polls outbound mailboxes for a session until aborted.
 */
export async function startDeliveryLoop(config: DeliveryLoopConfig): Promise<void> {
  const interval = config.intervalMs ?? 500;

  while (!config.signal?.aborted) {
    try {
      await deliverSessionMessages(config.agentGroupId, config.sessionId);
    } catch (err) {
      console.error(`[delivery] Error during delivery in session ${config.sessionId}:`, err);
    }

    if (config.signal?.aborted) break;
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}