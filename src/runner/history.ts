

import type { DatabaseSync } from 'node:sqlite';
import type { ChatMessage } from './providers/types.js';

export interface HistoryOptions {
  /** The message currently being processed (must be excluded from history) */
  currentMessageId?: string;
  /** Maximum number of previous message pairs (turns) to retain (default: 20) */
  maxTurns?: number;
}

interface InboundHistoryRow {
  id: string;
  seq: number;
  content: string;
  timestamp: string;
}

interface OutboundHistoryRow {
  id: string;
  seq: number;
  in_reply_to: string | null;
  content: string;
  timestamp: string;
}


export function loadSessionHistory(
  inDb: DatabaseSync,
  outDb: DatabaseSync,
  options: HistoryOptions = {}
): ChatMessage[] {
  const maxTurns = options.maxTurns ?? 20;

  // 1. Fetch completed user messages from inbound.db
  const inStmt = inDb.prepare(`
    SELECT id, seq, content, timestamp
    FROM messages_in
    WHERE status IN ('completed', 'processing')
    ORDER BY seq ASC
  `);
  const allInRows = inStmt.all() as unknown as InboundHistoryRow[];

  // Exclude the current incoming prompt so it is not duplicated in history
  const userMessages = allInRows.filter(
    (row) => !options.currentMessageId || row.id !== options.currentMessageId
  );

  if (userMessages.length === 0) {
    return [];
  }

  // 2. Fetch all assistant responses from outbound.db
  const outStmt = outDb.prepare(`
    SELECT id, seq, in_reply_to, content, timestamp
    FROM messages_out
    ORDER BY seq ASC
  `);
  const assistantMessages = outStmt.all() as unknown as OutboundHistoryRow[];

  // Group assistant replies by the inbound message ID they replied to
  const repliesByInboundId = new Map<string, OutboundHistoryRow[]>();
  for (const outMsg of assistantMessages) {
    if (outMsg.in_reply_to) {
      const existing = repliesByInboundId.get(outMsg.in_reply_to) || [];
      existing.push(outMsg);
      repliesByInboundId.set(outMsg.in_reply_to, existing);
    }
  }

  // 3. Interleave User questions and Assistant replies into conversation turns
  const history: ChatMessage[] = [];

  for (const userMsg of userMessages) {
    // Add the user's question
    history.push({
      role: 'user',
      content: userMsg.content
    });

    // Add any assistant response(s) that answered this question
    const replies = repliesByInboundId.get(userMsg.id);
    if (replies) {
      for (const reply of replies) {
        history.push({
          role: 'assistant',
          content: reply.content
        });
      }
    }
  }

  // 4. Apply Sliding Window (keep at most maxTurns * 2 messages)
  const maxMessages = maxTurns * 2;
  let prunedHistory = history;

  if (prunedHistory.length > maxMessages) {
    prunedHistory = prunedHistory.slice(-maxMessages);

    // If pruning cut in the middle of a turn leaving an orphaned assistant reply first,
    // drop it so conversation history always begins with a user turn
    if (prunedHistory.length > 0 && prunedHistory[0].role === 'assistant') {
      prunedHistory = prunedHistory.slice(1);
    }
  }

  return prunedHistory;
}
