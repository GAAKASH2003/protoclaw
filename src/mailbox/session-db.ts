import { DatabaseSync } from 'node:sqlite';
import { INBOUND_SCHEMA, OUTBOUND_SCHEMA } from './schema.js';
import { nextEvenSeq, nextOddSeq } from './parity.js';
import type { 
  InboundWrite, 
  MessageInRow, 
  OutboundWrite, 
  MessageOutRow, 
  ProcessingStatus 
} from './types.js';

/** Applies the schema to a database file. Idempotent. */
export function ensureSchema(dbPath: string, schemaType: 'inbound' | 'outbound'): void {
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = DELETE;');
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec(schemaType === 'inbound' ? INBOUND_SCHEMA : OUTBOUND_SCHEMA);
  db.close();
}

/** Open host-owned inbound.db (read-write) */
export function openInboundDb(dbPath: string): DatabaseSync {
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = DELETE;');
  db.exec('PRAGMA busy_timeout = 5000;');
  return db;
}

/** Open runner-owned outbound.db (host opens readonly by default) */
export function openOutboundDb(dbPath: string, readOnly = true): DatabaseSync {
  const db = new DatabaseSync(dbPath, { readOnly });
  db.exec('PRAGMA busy_timeout = 5000;');
  return db;
}

/** Writes an inbound message into inbound.db assigning the next EVEN sequence number */
export function writeMessageIn(db: DatabaseSync, write: InboundWrite): MessageInRow {
  const maxRow = db.prepare('SELECT COALESCE(MAX(seq), 0) AS max_seq FROM messages_in;').get() as { max_seq: number };
  const seq = nextEvenSeq(maxRow.max_seq);

  const id = write.id ?? `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const timestamp = write.timestamp ?? new Date().toISOString();
  const kind = write.kind ?? 'message';
  const status = write.status ?? 'pending';
  const trigger = write.trigger ?? 1;
  const tries = write.tries ?? 0;
  const on_wake = write.on_wake ?? 0;

  const stmt = db.prepare(`
    INSERT INTO messages_in (
      id, seq, kind, timestamp, status, process_after, recurrence, series_id,
      tries, trigger, platform_id, channel_type, thread_id, content, source_session_id, on_wake
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    );
  `);

  stmt.run(
    id, seq, kind, timestamp, status, write.process_after ?? null, write.recurrence ?? null,
    write.series_id ?? null, tries, trigger, write.platform_id ?? null, write.channel_type ?? null,
    write.thread_id ?? null, write.content, write.source_session_id ?? null, on_wake
  );

  return {
    id, seq, kind, timestamp, status, process_after: write.process_after ?? null,
    recurrence: write.recurrence ?? null, series_id: write.series_id ?? null, tries,
    trigger, platform_id: write.platform_id ?? null, channel_type: write.channel_type ?? null,
    thread_id: write.thread_id ?? null, content: write.content,
    source_session_id: write.source_session_id ?? null, on_wake
  };
}

/** Writes an outbound response into outbound.db assigning the next ODD sequence number */
export function writeMessageOut(db: DatabaseSync, write: OutboundWrite): MessageOutRow {
  const maxRow = db.prepare('SELECT COALESCE(MAX(seq), 0) AS max_seq FROM messages_out;').get() as { max_seq: number };
  const seq = nextOddSeq(maxRow.max_seq);

  const id = write.id ?? `out-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const timestamp = write.timestamp ?? new Date().toISOString();
  const kind = write.kind ?? 'text';

  const stmt = db.prepare(`
    INSERT INTO messages_out (
      id, seq, in_reply_to, timestamp, deliver_after, recurrence, kind,
      platform_id, channel_type, thread_id, content
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    );
  `);

  stmt.run(
    id, seq, write.in_reply_to ?? null, timestamp, write.deliver_after ?? null,
    write.recurrence ?? null, kind, write.platform_id ?? null, write.channel_type ?? null,
    write.thread_id ?? null, write.content
  );

  return {
    id, seq, in_reply_to: write.in_reply_to ?? null, timestamp, deliver_after: write.deliver_after ?? null,
    recurrence: write.recurrence ?? null, kind, platform_id: write.platform_id ?? null,
    channel_type: write.channel_type ?? null, thread_id: write.thread_id ?? null, content: write.content
  };
}

export function updateProcessingAck(
  db: DatabaseSync, 
  messageId: string, 
  status: ProcessingStatus
): void {
  const now = new Date().toISOString();
  const stmt = db.prepare(`
    INSERT INTO processing_ack (message_id, status, status_changed)
    VALUES (?, ?, ?)
    ON CONFLICT(message_id) DO UPDATE SET
      status = excluded.status,
      status_changed = excluded.status_changed;
  `);
  stmt.run(messageId, status, now);
}

export function readPendingInboundMessages(
  db: DatabaseSync, 
  limit = 10
): MessageInRow[] {
  const stmt = db.prepare(`
    SELECT * FROM messages_in
    WHERE status = 'pending'
      AND (process_after IS NULL OR process_after <= CURRENT_TIMESTAMP)
    ORDER BY seq ASC
    LIMIT ?;
  `);
  return stmt.all(limit) as unknown as MessageInRow[];
}

export function markDelivered(
  db: DatabaseSync, 
  messageOutId: string, 
  platformMessageId: string | null = null
): void {
  const now = new Date().toISOString();
  const stmt = db.prepare(`
    INSERT INTO delivered (message_out_id, platform_message_id, status, delivered_at)
    VALUES (?, ?, 'delivered', ?)
    ON CONFLICT(message_out_id) DO UPDATE SET
      platform_message_id = excluded.platform_message_id,
      status = 'delivered',
      delivered_at = excluded.delivered_at;
  `);
  stmt.run(messageOutId, platformMessageId, now);
}

const MID_WRITE_ERRORS = new Set(['SQLITE_READONLY_ROLLBACK', 'SQLITE_CORRUPT']);

export function readWithRetry<T>(fn: () => T, deadlineMs = 1000): T {
  const deadline = Date.now() + deadlineMs;
  let delay = 10;
  for (;;) {
    try {
      return fn();
    } catch (error: any) {
      const code = error?.code;
      if (typeof code === 'string' && MID_WRITE_ERRORS.has(code) && Date.now() < deadline) {
        // Sleep synchronously for a few milliseconds to let the host commit settle
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);
        delay = Math.min(delay * 2, 100);
        continue;
      }
      throw error;
    }
  }
}

