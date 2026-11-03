import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { initCentralDb } from '../src/db/connection.js';
import { createAgentGroup } from '../src/db/agent-groups.js';
import { ensureMessagingGroup } from '../src/db/messaging-groups.js';
import { wireAgentToMessagingGroup } from '../src/db/wirings.js';
import { ensureUser, grantRole } from '../src/db/users.js';
import { routeInbound, evaluateEngage } from '../src/router.js';
import { openInboundDb } from '../src/mailbox/session-db.js';
import { inboundDbPath, sessionDir } from '../src/session-manager.js';
import type { InboundEvent } from '../src/types.js';

describe('Phase 3: Inbound Message Router & Session Manager', () => {
  let tempDir: string;
  let dbPath: string;
  let centralDb: DatabaseSync;
  const createdSessions: Array<{ agentGroupId: string; sessionId: string }> = [];

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'protoclaw-router-test-'));
    dbPath = path.join(tempDir, 'protoclaw.db');
    centralDb = initCentralDb(dbPath);

    // Seed agent groups
    createAgentGroup(centralDb, { id: 'assistant', name: 'General Assistant', folder: 'assistant' });
    createAgentGroup(centralDb, { id: 'coder', name: 'Software Engineer', folder: 'coder' });
  });

  afterEach(() => {
    centralDb.close();
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
    // Clean up physical session folders created during testing
    for (const { agentGroupId, sessionId } of createdSessions) {
      const dir = sessionDir(agentGroupId, sessionId);
      if (fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
    createdSessions.length = 0;
  });

  describe('1. Engage Rule Evaluation', () => {
    it('evaluates regex patterns correctly', () => {
      const patternWiring = {
        id: 'w1',
        messaging_group_id: 'mg1',
        agent_group_id: 'coder',
        engage_mode: 'pattern' as const,
        engage_pattern: '^!code\\b',
        sender_scope: 'all' as const,
        ignored_message_policy: 'drop' as const,
        session_mode: 'shared' as const,
        priority: 0,
        threads: null,
        created_at: new Date().toISOString()
      };

      expect(evaluateEngage(patternWiring, '!code write a script')).toBe(true);
      expect(evaluateEngage(patternWiring, 'hello world')).toBe(false);
    });

    it('evaluates mentions correctly', () => {
      const mentionWiring = {
        id: 'w2',
        messaging_group_id: 'mg1',
        agent_group_id: 'assistant',
        engage_mode: 'mention' as const,
        engage_pattern: null,
        sender_scope: 'all' as const,
        ignored_message_policy: 'drop' as const,
        session_mode: 'shared' as const,
        priority: 0,
        threads: null,
        created_at: new Date().toISOString()
      };

      expect(evaluateEngage(mentionWiring, 'hey bot', true)).toBe(true);
      expect(evaluateEngage(mentionWiring, 'hey bot', false)).toBe(false);
    });
  });

  describe('2. Routing Pipeline & Security Gate', () => {
    it('blocks unknown senders when policy is strict', async () => {
      const chat = ensureMessagingGroup(centralDb, {
        id: 'tg:-100',
        channel_type: 'telegram',
        platform_id: '-100',
        unknown_sender_policy: 'strict'
      });

      wireAgentToMessagingGroup(centralDb, {
        messaging_group_id: chat.id,
        agent_group_id: 'assistant',
        engage_mode: 'pattern',
        engage_pattern: '.'
      });

      const event: InboundEvent = {
        channelType: 'telegram',
        platformId: '-100',
        sender: { id: 'tg:stranger', displayName: 'Stranger' },
        text: 'Hello!'
      };

      const results = await routeInbound(event, centralDb);
      expect(results.length).toBe(1);
      expect(results[0].status).toBe('denied');
    });

    it('routes successfully when sender is an owner', async () => {
      const chat = ensureMessagingGroup(centralDb, {
        id: 'tg:-200',
        channel_type: 'telegram',
        platform_id: '-200',
        unknown_sender_policy: 'strict'
      });

      wireAgentToMessagingGroup(centralDb, {
        messaging_group_id: chat.id,
        agent_group_id: 'coder',
        engage_mode: 'pattern',
        engage_pattern: '^!calc'
      });

      // Grant owner role
      ensureUser(centralDb, { id: 'tg:alice', kind: 'telegram', display_name: 'Alice' });
      grantRole(centralDb, { user_id: 'tg:alice', role: 'owner' });

      let wakeFired = false;
      const event: InboundEvent = {
        channelType: 'telegram',
        platformId: '-200',
        sender: { id: 'tg:alice', displayName: 'Alice' },
        text: '!calc 10 + 20'
      };

      const results = await routeInbound(event, centralDb, (sessId) => {
        wakeFired = true;
      });

      expect(results.length).toBe(1);
      expect(results[0].status).toBe('routed');
      expect(results[0].agentGroupId).toBe('coder');
      expect(wakeFired).toBe(true);
      createdSessions.push({ agentGroupId: 'coder', sessionId: results[0].sessionId });

      // Verify message was written into inbound.db with an EVEN sequence number
      const inPath = inboundDbPath('coder', results[0].sessionId);
      const inDb = openInboundDb(inPath);
      const row = inDb.prepare('SELECT * FROM messages_in WHERE id = ?').get(results[0].messageId) as any;
      expect(row.content).toBe('!calc 10 + 20');
      expect(row.seq % 2).toBe(0); // EVEN parity
      inDb.close();
    });
  });

  describe('3. Concurrency & Promise Mutex', () => {
    it('creates exactly one session when parallel messages arrive simultaneously', async () => {
      const chat = ensureMessagingGroup(centralDb, {
        id: 'cli:parallel',
        channel_type: 'cli',
        platform_id: 'parallel',
        unknown_sender_policy: 'public'
      });

      wireAgentToMessagingGroup(centralDb, {
        messaging_group_id: chat.id,
        agent_group_id: 'assistant',
        engage_mode: 'pattern',
        engage_pattern: '.',
        session_mode: 'shared'
      });

      // Fire 5 concurrent messages at the exact same millisecond
      const promises = [1, 2, 3, 4, 5].map((i) =>
        routeInbound(
          {
            channelType: 'cli',
            platformId: 'parallel',
            sender: { id: `cli:user${i}` },
            text: `Parallel message #${i}`
          },
          centralDb
        )
      );

      const allResults = await Promise.all(promises);

      // All 5 should route to the EXACT same session ID
      const sessionIds = allResults.map((r) => r[0].sessionId);
      const uniqueSessionIds = new Set(sessionIds);
      expect(uniqueSessionIds.size).toBe(1);

      const targetSessionId = sessionIds[0];
      createdSessions.push({ agentGroupId: 'assistant', sessionId: targetSessionId });

      // Verify all 5 messages are in inbound.db in even sequence parity
      const inDb = openInboundDb(inboundDbPath('assistant', targetSessionId));
      const messages = inDb.prepare('SELECT seq, content FROM messages_in ORDER BY seq ASC').all() as any[];

      expect(messages.length).toBe(5);
      expect(messages.map((m) => m.seq)).toEqual([2, 4, 6, 8, 10]); // Pure even sequence parity!
      inDb.close();
    });
  });
});

