import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { initCentralDb } from '../src/db/connection.js';
import { ensureUser, getUser, grantRole, revokeRole, isOwner, isAdmin } from '../src/db/users.js';
import { createAgentGroup, getAgentGroup, deleteAgentGroup } from '../src/db/agent-groups.js';
import { ensureMessagingGroup, getMessagingGroup } from '../src/db/messaging-groups.js';
import { wireAgentToMessagingGroup, findWiringsForMessagingGroup, unwire } from '../src/db/wirings.js';
import { 
  createSession, 
  getSession, 
  findSessionForAgent, 
  findSessionByAgentGroup, 
  updateSessionStatus, 
  touchSessionActivity 
} from '../src/db/sessions.js';

describe('Phase 2: Central Database & Entity Model', () => {
  let tempDir: string;
  let dbPath: string;
  let db: DatabaseSync;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'protoclaw-central-db-test-'));
    dbPath = path.join(tempDir, 'protoclaw.db');
    db = initCentralDb(dbPath);
  });

  afterEach(() => {
    db.close();
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe('1. Database Connection & Pragmas', () => {
    it('enforces foreign keys and WAL journal mode', () => {
      const fk = db.prepare('PRAGMA foreign_keys;').get() as { foreign_keys: number };
      const journal = db.prepare('PRAGMA journal_mode;').get() as { journal_mode: string };

      expect(fk.foreign_keys).toBe(1);
      expect(journal.journal_mode.toLowerCase()).toBe('wal');
    });

    it('initializes schema idempotently without error', () => {
      const secondDb = initCentralDb(dbPath);
      expect(secondDb).toBeDefined();
      secondDb.close();
    });
  });

  describe('2. Users & Permission Hierarchy (Invariant 5)', () => {
    it('manages users and enforces owner/admin hierarchy', () => {
      // 0. Ensure target agent group exists for foreign key constraint
      createAgentGroup(db, { id: 'coder', name: 'Coder Agent', folder: 'coder' });

      // 1. Create users
      const owner = ensureUser(db, { id: 'cli:owner', kind: 'cli', display_name: 'Super Owner' });
      const bob = ensureUser(db, { id: 'tg:bob', kind: 'telegram', display_name: 'Bob Admin' });
      const guest = ensureUser(db, { id: 'tg:guest', kind: 'telegram', display_name: 'Guest User' });

      expect(getUser(db, 'cli:owner')?.display_name).toBe('Super Owner');

      // 2. Grant roles
      grantRole(db, { user_id: owner.id, role: 'owner' });
      grantRole(db, { user_id: bob.id, role: 'admin', agent_group_id: 'coder' }); // scoped admin

      // 3. Test Owner hierarchy (owner is automatically admin everywhere)
      expect(isOwner(db, owner.id)).toBe(true);
      expect(isAdmin(db, owner.id)).toBe(true);
      expect(isAdmin(db, owner.id, 'coder')).toBe(true);
      expect(isAdmin(db, owner.id, 'finance')).toBe(true);

      // 4. Test Scoped Admin hierarchy
      expect(isOwner(db, bob.id)).toBe(false);
      expect(isAdmin(db, bob.id)).toBe(false); // not global admin
      expect(isAdmin(db, bob.id, 'coder')).toBe(true); // admin for 'coder'
      expect(isAdmin(db, bob.id, 'finance')).toBe(false); // denied for 'finance'

      // 5. Test Guest
      expect(isOwner(db, guest.id)).toBe(false);
      expect(isAdmin(db, guest.id)).toBe(false);

      // 6. Role revocation
      revokeRole(db, bob.id, 'admin', 'coder');
      expect(isAdmin(db, bob.id, 'coder')).toBe(false);
    });
  });

  describe('3. Foreign Key Cascading Integrity', () => {
    it('automatically cascades and deletes wirings when an agent group is deleted', () => {
      // Create agent and chat
      const agent = createAgentGroup(db, { id: 'temp-agent', name: 'Temp', folder: 'temp' });
      const chat = ensureMessagingGroup(db, { 
        id: 'cli:test', 
        channel_type: 'cli', 
        platform_id: 'test' 
      });

      // Wire them
      wireAgentToMessagingGroup(db, {
        messaging_group_id: chat.id,
        agent_group_id: agent.id
      });

      expect(findWiringsForMessagingGroup(db, chat.id).length).toBe(1);

      // Delete agent group -> Foreign key CASCADE must remove the wiring row
      deleteAgentGroup(db, agent.id);
      expect(getAgentGroup(db, agent.id)).toBeNull();
      expect(findWiringsForMessagingGroup(db, chat.id).length).toBe(0);
    });
  });

  describe('4. Wirings & Priority Routing', () => {
    it('returns wirings ordered by priority descending', () => {
      createAgentGroup(db, { id: 'default', name: 'Default', folder: 'default' });
      createAgentGroup(db, { id: 'specialist', name: 'Specialist', folder: 'specialist' });
      const chat = ensureMessagingGroup(db, { 
        id: 'tg:dev', 
        channel_type: 'telegram', 
        platform_id: '-100' 
      });

      wireAgentToMessagingGroup(db, {
        messaging_group_id: chat.id,
        agent_group_id: 'default',
        priority: 1
      });

      wireAgentToMessagingGroup(db, {
        messaging_group_id: chat.id,
        agent_group_id: 'specialist',
        priority: 10,
        engage_mode: 'pattern',
        engage_pattern: '^!spec'
      });

      const wirings = findWiringsForMessagingGroup(db, chat.id);
      expect(wirings.length).toBe(2);
      expect(wirings[0].agent_group_id).toBe('specialist'); // priority 10 first
      expect(wirings[1].agent_group_id).toBe('default');    // priority 1 second

      // Unwire
      unwire(db, chat.id, 'specialist');
      expect(findWiringsForMessagingGroup(db, chat.id).length).toBe(1);
    });
  });

  describe('5. The 3 Session Modes', () => {
    beforeEach(() => {
      createAgentGroup(db, { id: 'coder', name: 'Coder', folder: 'coder' });
      ensureMessagingGroup(db, { id: 'tg:general', channel_type: 'telegram', platform_id: '1' });
    });

    it('handles shared session mode (single session for chat)', () => {
      const sess = createSession(db, {
        agent_group_id: 'coder',
        messaging_group_id: 'tg:general',
        thread_id: null
      });

      const found = findSessionForAgent(db, 'coder', 'tg:general', null);
      expect(found).not.toBeNull();
      expect(found?.id).toBe(sess.id);
    });

    it('handles per-thread session mode (isolated session per thread)', () => {
      const thread1 = createSession(db, {
        agent_group_id: 'coder',
        messaging_group_id: 'tg:general',
        thread_id: 'topic-101'
      });

      const thread2 = createSession(db, {
        agent_group_id: 'coder',
        messaging_group_id: 'tg:general',
        thread_id: 'topic-102'
      });

      expect(thread1.id).not.toBe(thread2.id);

      const found1 = findSessionForAgent(db, 'coder', 'tg:general', 'topic-101');
      const found2 = findSessionForAgent(db, 'coder', 'tg:general', 'topic-102');

      expect(found1?.id).toBe(thread1.id);
      expect(found2?.id).toBe(thread2.id);
    });

    it('handles agent-shared session mode (global session across all chats)', () => {
      const globalSess = createSession(db, {
        agent_group_id: 'coder',
        messaging_group_id: null,
        thread_id: null
      });

      const found = findSessionByAgentGroup(db, 'coder');
      expect(found?.id).toBe(globalSess.id);
    });

    it('updates session status and touches activity timestamp', () => {
      const sess = createSession(db, { agent_group_id: 'coder' });

      updateSessionStatus(db, sess.id, 'active', 'running');
      expect(getSession(db, sess.id)?.container_status).toBe('running');

      touchSessionActivity(db, sess.id);
      expect(getSession(db, sess.id)?.last_active).not.toBeNull();
    });
  });
});
