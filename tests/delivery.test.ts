import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import { deliverSessionMessages, startDeliveryLoop } from '../src/delivery.js';
import { CliChannelAdapter } from '../src/channels/cli.js';
import { registerChannelAdapter, clearChannelAdapters } from '../src/channels/registry.js';
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

describe('Phase 5 - Step 4: Host Delivery Engine', () => {
  const agentGroupId = 'test-agent';
  let sessionIndex = 0;
  let currentSessionId: string;
  let currentSessionDir: string;

  beforeEach(() => {
    sessionIndex++;
    currentSessionId = `test-delivery-${Date.now()}-${sessionIndex}`;
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

  it('delivers pending outbound messages to the registered channel adapter and records receipt in inbound.db', async () => {
    const inPath = inboundDbPath(agentGroupId, currentSessionId);
    const outPath = outboundDbPath(agentGroupId, currentSessionId);

    // Register silent CLI channel adapter
    const cliAdapter = new CliChannelAdapter({ silent: true });
    registerChannelAdapter(cliAdapter);

    // 1. Write outbound response (Runner simulated)
    const outDb = openOutboundDb(outPath, false);
    let outMsg;
    try {
      outMsg = writeMessageOut(outDb, {
        content: 'Hello from Agent Runner!',
        kind: 'text',
        channel_type: 'cli',
        platform_id: 'terminal',
        thread_id: 'th-1'
      });
    } finally {
      outDb.close();
    }

    // 2. Run Delivery Engine cycle (Host execution)
    const result = await deliverSessionMessages(agentGroupId, currentSessionId);

    expect(result.delivered).toBe(1);
    expect(cliAdapter.deliveredHistory.length).toBe(1);
    expect(cliAdapter.deliveredHistory[0].id).toBe(outMsg.id);
    expect(cliAdapter.deliveredHistory[0].content).toBe('Hello from Agent Runner!');
    expect(cliAdapter.deliveredHistory[0].channel_type).toBe('cli');

    // 3. Verify delivery receipt recorded in host-owned inbound.db
    const inDb = openInboundDb(inPath);
    try {
      const receipt = inDb.prepare('SELECT * FROM delivered WHERE message_out_id = ?').get(outMsg.id) as any;
      expect(receipt).toBeDefined();
      expect(receipt.message_out_id).toBe(outMsg.id);
      expect(receipt.status).toBe('delivered');
      expect(receipt.platform_message_id).toContain('cli-');
      expect(receipt.delivered_at).toBeTruthy();
    } finally {
      inDb.close();
    }
  });

  it('is idempotent: never re-delivers already delivered messages', async () => {
    const outPath = outboundDbPath(agentGroupId, currentSessionId);

    const cliAdapter = new CliChannelAdapter({ silent: true });
    registerChannelAdapter(cliAdapter);

    // Write outbound message
    const outDb = openOutboundDb(outPath, false);
    try {
      writeMessageOut(outDb, { content: 'Single Delivery Guarantee', channel_type: 'cli' });
    } finally {
      outDb.close();
    }

    // First cycle: delivered
    const firstCycle = await deliverSessionMessages(agentGroupId, currentSessionId);
    expect(firstCycle.delivered).toBe(1);
    expect(cliAdapter.deliveredHistory.length).toBe(1);

    // Second cycle: should find 0 undelivered messages
    const secondCycle = await deliverSessionMessages(agentGroupId, currentSessionId);
    expect(secondCycle.delivered).toBe(0);
    expect(cliAdapter.deliveredHistory.length).toBe(1);
  });

  it('delivers multiple consecutive messages in strict sequence order', async () => {
    const inPath = inboundDbPath(agentGroupId, currentSessionId);
    const outPath = outboundDbPath(agentGroupId, currentSessionId);

    const cliAdapter = new CliChannelAdapter({ silent: true });
    registerChannelAdapter(cliAdapter);

    const outDb = openOutboundDb(outPath, false);
    let m1, m2, m3;
    try {
      m1 = writeMessageOut(outDb, { content: 'First message', channel_type: 'cli' });
      m2 = writeMessageOut(outDb, { content: 'Second message', channel_type: 'cli' });
      m3 = writeMessageOut(outDb, { content: 'Third message', channel_type: 'cli' });
    } finally {
      outDb.close();
    }

    const result = await deliverSessionMessages(agentGroupId, currentSessionId);

    expect(result.delivered).toBe(3);
    expect(cliAdapter.deliveredHistory.length).toBe(3);
    expect(cliAdapter.deliveredHistory.map((m) => m.content)).toEqual([
      'First message',
      'Second message',
      'Third message'
    ]);
    expect(cliAdapter.deliveredHistory.map((m) => m.seq)).toEqual([1, 3, 5]);

    // Verify all 3 receipts exist in inbound.db
    const inDb = openInboundDb(inPath);
    try {
      const countRow = inDb.prepare('SELECT COUNT(*) as c FROM delivered').get() as any;
      expect(countRow.c).toBe(3);
    } finally {
      inDb.close();
    }
  });

  it('skips messages gracefully when no adapter is registered for their channel_type', async () => {
    const inPath = inboundDbPath(agentGroupId, currentSessionId);
    const outPath = outboundDbPath(agentGroupId, currentSessionId);

    // No adapter registered for 'discord'
    const outDb = openOutboundDb(outPath, false);
    try {
      writeMessageOut(outDb, { content: 'Discord post', channel_type: 'discord' });
    } finally {
      outDb.close();
    }

    const result = await deliverSessionMessages(agentGroupId, currentSessionId);

    expect(result.delivered).toBe(0);

    // Verify it is NOT marked as delivered in inbound.db (so it can be retried once adapter connects)
    const inDb = openInboundDb(inPath);
    try {
      const countRow = inDb.prepare('SELECT COUNT(*) as c FROM delivered').get() as any;
      expect(countRow.c).toBe(0);
    } finally {
      inDb.close();
    }
  });

  it('startDeliveryLoop runs continuously and stops on AbortSignal', async () => {
    const controller = new AbortController();
    const outPath = outboundDbPath(agentGroupId, currentSessionId);

    const cliAdapter = new CliChannelAdapter({ silent: true });
    registerChannelAdapter(cliAdapter);

    // Start background delivery loop
    const loopPromise = startDeliveryLoop({
      agentGroupId,
      sessionId: currentSessionId,
      intervalMs: 25,
      signal: controller.signal
    });

    // Write outbound message shortly after loop starts
    const outDb = openOutboundDb(outPath, false);
    try {
      writeMessageOut(outDb, { content: 'Async Delivered Message', channel_type: 'cli' });
    } finally {
      outDb.close();
    }

    // Wait a brief moment for loop tick to pick it up
    await new Promise((resolve) => setTimeout(resolve, 80));

    // Abort loop and await termination
    controller.abort();
    await loopPromise;

    expect(cliAdapter.deliveredHistory.length).toBe(1);
    expect(cliAdapter.deliveredHistory[0].content).toBe('Async Delivered Message');
  });
});

