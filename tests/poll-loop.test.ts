import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { runPollCycle, startPollLoop } from '../src/runner/poll-loop.js';
import { MockEchoProvider, OpenRouterProvider } from '../src/runner/providers/index.js';
import { isHeartbeatFresh } from '../src/runner/heartbeat.js';
import { 
  provisionSessionStorage, 
  sessionDir, 
  inboundDbPath, 
  outboundDbPath, 
  heartbeatPath 
} from '../src/session-manager.js';
import { 
  openInboundDb, 
  openOutboundDb, 
  writeMessageIn 
} from '../src/mailbox/session-db.js';

describe('Phase 4: Agent Runner & Poll Loop', () => {
  const agentGroupId = 'test-agent';
  let sessionIndex = 0;
  let currentSessionId: string;
  let currentSessionDir: string;

  beforeEach(() => {
    sessionIndex++;
    currentSessionId = `test-session-${Date.now()}-${sessionIndex}`;
    currentSessionDir = sessionDir(agentGroupId, currentSessionId);
    provisionSessionStorage(agentGroupId, currentSessionId);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (fs.existsSync(currentSessionDir)) {
      try {
        fs.rmSync(currentSessionDir, { recursive: true, force: true });
      } catch {
        // Ignore transient lock cleanup during test teardown
      }
    }
  });

  afterAll(() => {
    const testGroupDir = path.resolve(process.cwd(), 'groups', agentGroupId);
    if (fs.existsSync(testGroupDir)) {
      try {
        fs.rmSync(testGroupDir, { recursive: true, force: true });
      } catch {}
    }
  });

  describe('runPollCycle', () => {
    it('returns { processed: 0 } when there are no pending inbound messages', async () => {
      const mockProvider = new MockEchoProvider();
      const result = await runPollCycle({
        agentGroupId,
        sessionId: currentSessionId,
        provider: mockProvider
      });

      expect(result.processed).toBe(0);
      expect(mockProvider.calls.length).toBe(0);
    });

    it('processes a pending message, writes odd-seq reply, updates processing_ack and touches heartbeat', async () => {
      const inPath = inboundDbPath(agentGroupId, currentSessionId);
      const outPath = outboundDbPath(agentGroupId, currentSessionId);
      const hbPath = heartbeatPath(agentGroupId, currentSessionId);

      // Write test inbound message
      const inDb = openInboundDb(inPath);
      let inMsg;
      try {
        inMsg = writeMessageIn(inDb, {
          content: 'Hello ProtoClaw Runner',
          kind: 'message',
          channel_type: 'cli',
          platform_id: 'terminal',
          thread_id: 't-1'
        });
      } finally {
        inDb.close();
      }

      const mockProvider = new MockEchoProvider();
      const result = await runPollCycle({
        agentGroupId,
        sessionId: currentSessionId,
        provider: mockProvider
      });

      expect(result.processed).toBe(1);
      expect(mockProvider.calls.length).toBe(1);
      expect(mockProvider.calls[0].prompt).toBe('Hello ProtoClaw Runner');

      // Verify outbound message
      const outDb = openOutboundDb(outPath, false);
      try {
        const outRows = outDb.prepare('SELECT * FROM messages_out ORDER BY seq ASC').all() as any[];
        expect(outRows.length).toBe(1);
        expect(outRows[0].seq).toBe(1); // First odd sequence number!
        expect(outRows[0].in_reply_to).toBe(inMsg.id);
        expect(outRows[0].content).toBe('Echo: Hello ProtoClaw Runner');
        expect(outRows[0].channel_type).toBe('cli');
        expect(outRows[0].platform_id).toBe('terminal');
        expect(outRows[0].thread_id).toBe('t-1');

        // Verify processing_ack using message_id
        const ackRows = outDb.prepare('SELECT * FROM processing_ack WHERE message_id = ?').all(inMsg.id) as any[];
        expect(ackRows.length).toBe(1);
        expect(ackRows[0].status).toBe('completed');
      } finally {
        outDb.close();
      }

      // Verify inbound message status was updated to 'completed'
      const inDbVerify = openInboundDb(inPath);
      try {
        const inRow = inDbVerify.prepare('SELECT status FROM messages_in WHERE id = ?').get(inMsg.id) as any;
        expect(inRow.status).toBe('completed');
      } finally {
        inDbVerify.close();
      }

      // Verify heartbeat is fresh
      expect(isHeartbeatFresh(hbPath)).toBe(true);
    });

    it('maintains strict odd sequence parity across multiple consecutive messages', async () => {
      const inPath = inboundDbPath(agentGroupId, currentSessionId);
      const outPath = outboundDbPath(agentGroupId, currentSessionId);

      const inDb = openInboundDb(inPath);
      let msg1, msg2, msg3;
      try {
        msg1 = writeMessageIn(inDb, { content: 'Message 1' });
        msg2 = writeMessageIn(inDb, { content: 'Message 2' });
        msg3 = writeMessageIn(inDb, { content: 'Message 3' });
      } finally {
        inDb.close();
      }

      const result = await runPollCycle({
        agentGroupId,
        sessionId: currentSessionId,
        provider: new MockEchoProvider()
      });

      expect(result.processed).toBe(3);

      const outDb = openOutboundDb(outPath, false);
      try {
        const outRows = outDb.prepare('SELECT seq, in_reply_to, content FROM messages_out ORDER BY seq ASC').all() as any[];
        expect(outRows.length).toBe(3);
        // Strictly odd sequences: 1, 3, 5
        expect(outRows.map(r => r.seq)).toEqual([1, 3, 5]);
        expect(outRows[0].in_reply_to).toBe(msg1.id);
        expect(outRows[1].in_reply_to).toBe(msg2.id);
        expect(outRows[2].in_reply_to).toBe(msg3.id);
      } finally {
        outDb.close();
      }
    });

    it('works seamlessly with OpenRouterProvider', async () => {
      const inPath = inboundDbPath(agentGroupId, currentSessionId);
      const outPath = outboundDbPath(agentGroupId, currentSessionId);

      const inDb = openInboundDb(inPath);
      try {
        writeMessageIn(inDb, { content: 'What is the capital of France?' });
      } finally {
        inDb.close();
      }

      // Mock native fetch for OpenRouter
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                role: 'assistant',
                content: 'The capital of France is Paris.'
              }
            }
          ]
        })
      });
      vi.stubGlobal('fetch', mockFetch);

      const openRouterProvider = new OpenRouterProvider({
        apiKey: 'test-openrouter-key',
        model: 'gemini-2.5-flash'
      });

      const result = await runPollCycle({
        agentGroupId,
        sessionId: currentSessionId,
        provider: openRouterProvider,
        systemPrompt: 'You are a helpful geography tutor.'
      });

      expect(result.processed).toBe(1);
      expect(mockFetch).toHaveBeenCalledTimes(1);

      const outDb = openOutboundDb(outPath, false);
      try {
        const outRow = outDb.prepare('SELECT content, seq FROM messages_out LIMIT 1').get() as any;
        expect(outRow.seq).toBe(1);
        expect(outRow.content).toBe('The capital of France is Paris.');
      } finally {
        outDb.close();
      }
    });

    it('marks processing_ack as failed when provider throws an error', async () => {
      const inPath = inboundDbPath(agentGroupId, currentSessionId);
      const outPath = outboundDbPath(agentGroupId, currentSessionId);

      const inDb = openInboundDb(inPath);
      let failedMsg;
      try {
        failedMsg = writeMessageIn(inDb, { content: 'Crash this query' });
      } finally {
        inDb.close();
      }

      const faultyProvider = {
        name: 'faulty',
        query: vi.fn().mockRejectedValue(new Error('LLM Provider Outage'))
      };

      await expect(
        runPollCycle({
          agentGroupId,
          sessionId: currentSessionId,
          provider: faultyProvider
        })
      ).rejects.toThrow('LLM Provider Outage');

      const outDb = openOutboundDb(outPath, false);
      try {
        const ackRow = outDb.prepare('SELECT status FROM processing_ack WHERE message_id = ?').get(failedMsg.id) as any;
        const outCount = outDb.prepare('SELECT COUNT(*) as c FROM messages_out').get() as any;
        expect(ackRow.status).toBe('failed');
        expect(outCount.c).toBe(0);
      } finally {
        outDb.close();
      }
    });
  });

  describe('startPollLoop', () => {
    it('runs continuously in background and stops cleanly upon AbortSignal', async () => {
      const controller = new AbortController();
      const inPath = inboundDbPath(agentGroupId, currentSessionId);
      const outPath = outboundDbPath(agentGroupId, currentSessionId);

      // Start loop in background
      const loopPromise = startPollLoop({
        agentGroupId,
        sessionId: currentSessionId,
        provider: new MockEchoProvider(),
        intervalMs: 30,
        signal: controller.signal
      });

      // Write a message shortly after starting
      const inDb = openInboundDb(inPath);
      try {
        writeMessageIn(inDb, { content: 'Async message' });
      } finally {
        inDb.close();
      }

      // Wait a moment for poll cycle to pick it up
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Stop loop
      controller.abort();
      await loopPromise;

      // Assert message was processed
      const outDb = openOutboundDb(outPath, false);
      try {
        const outRow = outDb.prepare('SELECT content FROM messages_out LIMIT 1').get() as any;
        expect(outRow?.content).toBe('Echo: Async message');
      } finally {
        outDb.close();
      }
    });
  });
});
