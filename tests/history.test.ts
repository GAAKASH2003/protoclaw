import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import { loadSessionHistory } from '../src/runner/history.js';
import { 
  provisionSessionStorage, 
  sessionDir, 
  inboundDbPath, 
  outboundDbPath 
} from '../src/session-manager.js';
import { 
  openInboundDb, 
  openOutboundDb, 
  writeMessageIn, 
  writeMessageOut 
} from '../src/mailbox/session-db.js';

describe('Phase 6: Multi-Turn Conversation History Reconstructor', () => {
  const agentGroupId = 'test-agent';
  let sessionIndex = 0;
  let currentSessionId: string;
  let currentSessionDir: string;

  beforeEach(() => {
    sessionIndex++;
    currentSessionId = `test-history-${Date.now()}-${sessionIndex}`;
    currentSessionDir = sessionDir(agentGroupId, currentSessionId);
    provisionSessionStorage(agentGroupId, currentSessionId);
  });

  afterEach(() => {
    if (fs.existsSync(currentSessionDir)) {
      try {
        fs.rmSync(currentSessionDir, { recursive: true, force: true });
      } catch {}
    }
  });

  it('returns empty array when session has no previous messages', () => {
    const inDb = openInboundDb(inboundDbPath(agentGroupId, currentSessionId));
    const outDb = openOutboundDb(outboundDbPath(agentGroupId, currentSessionId));

    try {
      const history = loadSessionHistory(inDb, outDb);
      expect(history).toEqual([]);
    } finally {
      inDb.close();
      outDb.close();
    }
  });

  it('correctly stitches a single user question and assistant reply', () => {
    const inDb = openInboundDb(inboundDbPath(agentGroupId, currentSessionId));
    const outDb = openOutboundDb(outboundDbPath(agentGroupId, currentSessionId), false);

    try {
      // 1. Write user question (Host: even seq 2)
      const userMsg = writeMessageIn(inDb, {
        content: 'Hello, what is your name?',
        kind: 'message',
        trigger: 1
      });
      // Mark as completed
      inDb.prepare("UPDATE messages_in SET status = 'completed' WHERE id = ?").run(userMsg.id);

      // 2. Write assistant reply (Runner: odd seq 1)
      writeMessageOut(outDb, {
        content: 'I am ProtoClaw.',
        in_reply_to: userMsg.id,
        kind: 'text'
      });

      const history = loadSessionHistory(inDb, outDb);

      expect(history).toEqual([
        { role: 'user', content: 'Hello, what is your name?' },
        { role: 'assistant', content: 'I am ProtoClaw.' }
      ]);
    } finally {
      inDb.close();
      outDb.close();
    }
  });

  it('excludes the current active message from history', () => {
    const inDb = openInboundDb(inboundDbPath(agentGroupId, currentSessionId));
    const outDb = openOutboundDb(outboundDbPath(agentGroupId, currentSessionId), false);

    try {
      // Turn 1
      const turn1 = writeMessageIn(inDb, { content: 'My favorite color is green', kind: 'message', trigger: 1 });
      inDb.prepare("UPDATE messages_in SET status = 'completed' WHERE id = ?").run(turn1.id);
      writeMessageOut(outDb, { content: 'Got it, green.', in_reply_to: turn1.id, kind: 'text' });

      // Turn 2 (active query currently being evaluated)
      const turn2 = writeMessageIn(inDb, { content: 'What is my favorite color?', kind: 'message', trigger: 1 });
      inDb.prepare("UPDATE messages_in SET status = 'processing' WHERE id = ?").run(turn2.id);

      // Load history passing currentMessageId = turn2.id
      const history = loadSessionHistory(inDb, outDb, { currentMessageId: turn2.id });

      // History should only contain Turn 1, NOT Turn 2!
      expect(history).toEqual([
        { role: 'user', content: 'My favorite color is green' },
        { role: 'assistant', content: 'Got it, green.' }
      ]);
    } finally {
      inDb.close();
      outDb.close();
    }
  });

  it('interleaves multi-turn dialogue in strict chronological sequence', () => {
    const inDb = openInboundDb(inboundDbPath(agentGroupId, currentSessionId));
    const outDb = openOutboundDb(outboundDbPath(agentGroupId, currentSessionId), false);

    try {
      // Turn 1: seq 2 & seq 1
      const q1 = writeMessageIn(inDb, { content: 'Turn 1 Question', kind: 'message', trigger: 1 });
      inDb.prepare("UPDATE messages_in SET status = 'completed' WHERE id = ?").run(q1.id);
      writeMessageOut(outDb, { content: 'Turn 1 Answer', in_reply_to: q1.id, kind: 'text' });

      // Turn 2: seq 4 & seq 3
      const q2 = writeMessageIn(inDb, { content: 'Turn 2 Question', kind: 'message', trigger: 1 });
      inDb.prepare("UPDATE messages_in SET status = 'completed' WHERE id = ?").run(q2.id);
      writeMessageOut(outDb, { content: 'Turn 2 Answer', in_reply_to: q2.id, kind: 'text' });

      // Turn 3: seq 6 & seq 5
      const q3 = writeMessageIn(inDb, { content: 'Turn 3 Question', kind: 'message', trigger: 1 });
      inDb.prepare("UPDATE messages_in SET status = 'completed' WHERE id = ?").run(q3.id);
      writeMessageOut(outDb, { content: 'Turn 3 Answer', in_reply_to: q3.id, kind: 'text' });

      const history = loadSessionHistory(inDb, outDb);

      expect(history).toEqual([
        { role: 'user', content: 'Turn 1 Question' },
        { role: 'assistant', content: 'Turn 1 Answer' },
        { role: 'user', content: 'Turn 2 Question' },
        { role: 'assistant', content: 'Turn 2 Answer' },
        { role: 'user', content: 'Turn 3 Question' },
        { role: 'assistant', content: 'Turn 3 Answer' }
      ]);
    } finally {
      inDb.close();
      outDb.close();
    }
  });

  it('applies sliding window maxTurns and keeps conversation beginning with user', () => {
    const inDb = openInboundDb(inboundDbPath(agentGroupId, currentSessionId));
    const outDb = openOutboundDb(outboundDbPath(agentGroupId, currentSessionId), false);

    try {
      // Create 4 turns
      for (let i = 1; i <= 4; i++) {
        const q = writeMessageIn(inDb, { content: `Question ${i}`, kind: 'message', trigger: 1 });
        inDb.prepare("UPDATE messages_in SET status = 'completed' WHERE id = ?").run(q.id);
        writeMessageOut(outDb, { content: `Answer ${i}`, in_reply_to: q.id, kind: 'text' });
      }

      // Keep only last 2 turns (4 messages)
      const history = loadSessionHistory(inDb, outDb, { maxTurns: 2 });

      expect(history.length).toBe(4);
      expect(history[0]).toEqual({ role: 'user', content: 'Question 3' });
      expect(history[1]).toEqual({ role: 'assistant', content: 'Answer 3' });
      expect(history[2]).toEqual({ role: 'user', content: 'Question 4' });
      expect(history[3]).toEqual({ role: 'assistant', content: 'Answer 4' });
    } finally {
      inDb.close();
      outDb.close();
    }
  });
});
