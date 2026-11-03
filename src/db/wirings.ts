import { DatabaseSync } from 'node:sqlite';
import type { 
  CreateWiringInput, 
  MessagingGroupAgentRow, 
  EngageMode, 
  SessionMode, 
  SenderScope, 
  IgnoredMessagePolicy 
} from './types.js';


export function wireAgentToMessagingGroup(
  db: DatabaseSync, 
  input: CreateWiringInput
): MessagingGroupAgentRow {
  const id = input.id ?? `wire-${input.messaging_group_id}-${input.agent_group_id}`;
  const createdAt = input.created_at ?? new Date().toISOString();
  const engageMode: EngageMode = input.engage_mode ?? 'mention';
  const engagePattern = input.engage_pattern ?? null;
  const senderScope: SenderScope = input.sender_scope ?? 'all';
  const ignoredPolicy: IgnoredMessagePolicy = input.ignored_message_policy ?? 'drop';
  const sessionMode: SessionMode = input.session_mode ?? 'shared';
  const priority = input.priority ?? 0;
  const threads = input.threads ?? null;
  const stmt = db.prepare(`
    INSERT INTO messaging_group_agents (
      id, messaging_group_id, agent_group_id, engage_mode, engage_pattern,
      sender_scope, ignored_message_policy, session_mode, priority, threads, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(messaging_group_id, agent_group_id) DO UPDATE SET
      engage_mode = excluded.engage_mode,
      engage_pattern = excluded.engage_pattern,
      sender_scope = excluded.sender_scope,
      ignored_message_policy = excluded.ignored_message_policy,
      session_mode = excluded.session_mode,
      priority = excluded.priority,
      threads = excluded.threads;
  `);
  stmt.run(
    id, input.messaging_group_id, input.agent_group_id, engageMode, engagePattern,
    senderScope, ignoredPolicy, sessionMode, priority, threads, createdAt
  );
  return {
    id,
    messaging_group_id: input.messaging_group_id,
    agent_group_id: input.agent_group_id,
    engage_mode: engageMode,
    engage_pattern: engagePattern,
    sender_scope: senderScope,
    ignored_message_policy: ignoredPolicy,
    session_mode: sessionMode,
    priority,
    threads,
    created_at: createdAt
  };
}

export function findWiringsForMessagingGroup(
  db: DatabaseSync, 
  messagingGroupId: string
): MessagingGroupAgentRow[] {
  const stmt = db.prepare(`
    SELECT * FROM messaging_group_agents 
    WHERE messaging_group_id = ? 
    ORDER BY priority DESC, created_at ASC;
  `);
  return stmt.all(messagingGroupId) as unknown as MessagingGroupAgentRow[];
}

export function findWiringsForAgent(
  db: DatabaseSync, 
  agentGroupId: string
): MessagingGroupAgentRow[] {
  const stmt = db.prepare(`
    SELECT * FROM messaging_group_agents 
    WHERE agent_group_id = ? 
    ORDER BY priority DESC;
  `);
  return stmt.all(agentGroupId) as unknown as MessagingGroupAgentRow[];
}


export function unwire(
  db: DatabaseSync, 
  messagingGroupId: string, 
  agentGroupId: string
): void {
  db.prepare(`
    DELETE FROM messaging_group_agents 
    WHERE messaging_group_id = ? AND agent_group_id = ?;
  `).run(messagingGroupId, agentGroupId);
}