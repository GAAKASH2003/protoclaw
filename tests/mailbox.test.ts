import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  ensureSchema,
  openInboundDb,
  openOutboundDb,
  writeMessageIn,
  writeMessageOut,
  updateProcessingAck,
  readPendingInboundMessages,
  markDelivered,
  readWithRetry
} from '../src/mailbox/session-db.js';
import {
  nextEvenSeq,
  nextOddSeq,
  isHostSeq,
  isRunnerSeq,
  originFromSeq
} from '../src/mailbox/parity.js';

describe('Phase 1: Dual-DB Mailbox IPC Engine', () => {
  let tempDir: string;
  let inboundPath: string;
  let outboundPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'protoclaw-mailbox-test-'));
    inboundPath = path.join(tempDir, 'inbound.db');
    outboundPath = path.join(tempDir, 'outbound.db');
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe('1. Schema Initialization', () => {
    it('initializes inbound and outbound schemas idempotently', () => {
      // First initialization
      ensureSchema(inboundPath, 'inbound');
      ensureSchema(outboundPath, 'outbound');

      expect(fs.existsSync(inboundPath)).toBe(true);
      expect(fs.existsSync(outboundPath)).toBe(true);

      // Re-running ensureSchema must be idempotent (no errors)
      expect(() => ensureSchema(inboundPath, 'inbound')).not.toThrow();
      expect(() => ensureSchema(outboundPath, 'outbound')).not.toThrow();
    });
  });

  describe('2. Sequence Number Parity Rule', () => {
    it('strictly assigns EVEN sequence numbers (2, 4, 6...) to host inbound messages', () => {
      ensureSchema(inboundPath, 'inbound');
      const db = openInboundDb(inboundPath);

      const msg1 = writeMessageIn(db, { content: 'User says hello' });
      const msg2 = writeMessageIn(db, { content: 'User asks question' });
      const msg3 = writeMessageIn(db, { content: 'User says bye' });

      expect(msg1.seq).toBe(2);
      expect(msg2.seq).toBe(4);
      expect(msg3.seq).toBe(6);

      expect(isHostSeq(msg1.seq)).toBe(true);
      expect(isRunnerSeq(msg1.seq)).toBe(false);
      expect(originFromSeq(msg2.seq)).toBe('host');

      db.close();
    });

    it('strictly assigns ODD sequence numbers (1, 3, 5...) to runner outbound messages', () => {
      ensureSchema(outboundPath, 'outbound');
      // Runner opens outbound in read-write mode (readOnly: false)
      const db = openOutboundDb(outboundPath, false);

      const out1 = writeMessageOut(db, { content: 'Agent greeting', in_reply_to: 'msg-1' });
      const out2 = writeMessageOut(db, { content: 'Agent answer', in_reply_to: 'msg-2' });
      const out3 = writeMessageOut(db, { content: 'Agent farewell', in_reply_to: 'msg-3' });

      expect(out1.seq).toBe(1);
      expect(out2.seq).toBe(3);
      expect(out3.seq).toBe(5);

      expect(isRunnerSeq(out1.seq)).toBe(true);
      expect(isHostSeq(out1.seq)).toBe(false);
      expect(originFromSeq(out2.seq)).toBe('runner');

      db.close();
    });

    it('handles parity allocator math directly with edge cases', () => {
      // Empty table cases (null / undefined / 0)
      expect(nextEvenSeq(null)).toBe(2);
      expect(nextEvenSeq(0)).toBe(2);
      expect(nextOddSeq(null)).toBe(1);
      expect(nextOddSeq(0)).toBe(1);

      // Even progression
      expect(nextEvenSeq(2)).toBe(4);
      expect(nextEvenSeq(4)).toBe(6);

      // Odd progression
      expect(nextOddSeq(1)).toBe(3);
      expect(nextOddSeq(3)).toBe(5);

      // Re-alignment if an odd number sneaks into host
      expect(nextEvenSeq(5)).toBe(6);
      // Re-alignment if an even number sneaks into runner
      expect(nextOddSeq(4)).toBe(5);
    });
  });

  describe('3. Processing Acknowledgements (processing_ack)', () => {
    it('tracks task progress idempotently via ON CONFLICT', () => {
      ensureSchema(outboundPath, 'outbound');
      const db = openOutboundDb(outboundPath, false);

      const messageId = 'msg-test-100';

      // 1. Mark as processing
      updateProcessingAck(db, messageId, 'processing');
      let row = db.prepare('SELECT * FROM processing_ack WHERE message_id = ?').get(messageId) as any;
      expect(row.status).toBe('processing');

      // 2. Mark as completed
      updateProcessingAck(db, messageId, 'completed');
      row = db.prepare('SELECT * FROM processing_ack WHERE message_id = ?').get(messageId) as any;
      expect(row.status).toBe('completed');

      // Ensure no duplicate rows were inserted
      const count = db.prepare('SELECT COUNT(*) as c FROM processing_ack WHERE message_id = ?').get(messageId) as any;
      expect(count.c).toBe(1);

      db.close();
    });
  });

  describe('4. Pending Message Query & Time Filtering', () => {
    it('filters out future-scheduled messages and orders by sequence', () => {
      ensureSchema(inboundPath, 'inbound');
      const db = openInboundDb(inboundPath);

      // Message A: Immediate (process_after is null)
      writeMessageIn(db, { id: 'msg-now-1', content: 'Do this now' });

      // Message B: Scheduled far in the future
      writeMessageIn(db, { 
        id: 'msg-future', 
        content: 'Do this next century', 
        process_after: '2099-01-01T00:00:00.000Z' 
      });

      // Message C: Immediate follow-up
      writeMessageIn(db, { id: 'msg-now-2', content: 'Do this now too' });

      const pending = readPendingInboundMessages(db);

      expect(pending.length).toBe(2);
      expect(pending[0].id).toBe('msg-now-1');
      expect(pending[0].seq).toBe(2);
      expect(pending[1].id).toBe('msg-now-2');
      expect(pending[1].seq).toBe(6);

      db.close();
    });
  });

  describe('5. Delivery Tracking', () => {
    it('records delivered messages into inbound.db', () => {
      ensureSchema(inboundPath, 'inbound');
      const db = openInboundDb(inboundPath);

      markDelivered(db, 'out-123', 'tg-msg-999');

      const row = db.prepare('SELECT * FROM delivered WHERE message_out_id = ?').get('out-123') as any;
      expect(row).toBeDefined();
      expect(row.platform_message_id).toBe('tg-msg-999');
      expect(row.status).toBe('delivered');

      db.close();
    });
  });

  describe('6. Concurrent Simulation (Single-Writer Rule)', () => {
    it('allows Host and Runner to read and write without lock contention', () => {
      ensureSchema(inboundPath, 'inbound');
      ensureSchema(outboundPath, 'outbound');

      // Process A (Host): writes inbound, reads outbound
      const hostInbound = openInboundDb(inboundPath);
      const hostOutbound = openOutboundDb(outboundPath, true); // readonly

      // Process B (Runner): reads inbound, writes outbound
      const runnerInbound = openInboundDb(inboundPath); // runner reads
      const runnerOutbound = openOutboundDb(outboundPath, false); // runner writes

      // Interleaved operations
      // 1. Host writes message
      const inMsg = writeMessageIn(hostInbound, { content: 'Calculate 2 + 2' });

      // 2. Runner reads pending message from inbound
      const pending = readWithRetry(() => readPendingInboundMessages(runnerInbound));
      expect(pending.length).toBe(1);
      expect(pending[0].id).toBe(inMsg.id);

      // 3. Runner writes ack and reply to outbound
      updateProcessingAck(runnerOutbound, inMsg.id, 'processing');
      const outMsg = writeMessageOut(runnerOutbound, {
        in_reply_to: inMsg.id,
        content: '4'
      });
      updateProcessingAck(runnerOutbound, inMsg.id, 'completed');

      // 4. Host reads outbound reply
      const hostSeenOut = hostOutbound.prepare('SELECT * FROM messages_out WHERE id = ?').get(outMsg.id) as any;
      expect(hostSeenOut.content).toBe('4');
      expect(hostSeenOut.seq).toBe(1);

      // Clean up connections
      hostInbound.close();
      hostOutbound.close();
      runnerInbound.close();
      runnerOutbound.close();
    });
  });
});
