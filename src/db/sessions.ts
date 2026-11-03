import { DatabaseSync } from 'node:sqlite';
import type { 
  CreateSessionInput, 
  SessionRow, 
  SessionStatus, 
  ContainerStatus 
} from './types.js';

/**
 * Creates a new session record in the central DB.
 */
export function createSession(db: DatabaseSync, input: CreateSessionInput): SessionRow {
  const id = input.id ?? `sess-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const messagingGroupId = input.messaging_group_id ?? null;
  const threadId = input.thread_id ?? null;
  const provider = input.agent_provider ?? null;
  const status: SessionStatus = input.status ?? 'active';
  const containerStatus: ContainerStatus = input.container_status ?? 'stopped';
  const lastActive = input.last_active ?? null;
  const createdAt = input.created_at ?? new Date().toISOString();

  const stmt = db.prepare(`
    INSERT INTO sessions (
      id, agent_group_id, messaging_group_id, thread_id, agent_provider,
      status, container_status, last_active, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);
  `);

  stmt.run(
    id, input.agent_group_id, messagingGroupId, threadId, provider,
    status, containerStatus, lastActive, createdAt
  );

  return {
    id,
    agent_group_id: input.agent_group_id,
    messaging_group_id: messagingGroupId,
    thread_id: threadId,
    agent_provider: provider,
    status,
    container_status: containerStatus,
    last_active: lastActive,
    created_at: createdAt
  };
}

/**
 * Retrieves a session by its unique ID.
 */
export function getSession(db: DatabaseSync, id: string): SessionRow | null {
  const stmt = db.prepare('SELECT * FROM sessions WHERE id = ?;');
  const row = stmt.get(id);
  return (row as unknown as SessionRow) ?? null;
}

/**
 * Finds an active session for an agent in a chat group + thread.
 * Used for 'shared' and 'per-thread' session modes.
 */
export function findSessionForAgent(
  db: DatabaseSync,
  agentGroupId: string,
  messagingGroupId: string,
  threadId: string | null = null
): SessionRow | null {
  if (threadId === null) {
    const stmt = db.prepare(`
      SELECT * FROM sessions 
      WHERE agent_group_id = ? AND messaging_group_id = ? AND thread_id IS NULL AND status = 'active'
      ORDER BY created_at DESC 
      LIMIT 1;
    `);
    const row = stmt.get(agentGroupId, messagingGroupId);
    return (row as unknown as SessionRow) ?? null;
  } else {
    const stmt = db.prepare(`
      SELECT * FROM sessions 
      WHERE agent_group_id = ? AND messaging_group_id = ? AND thread_id = ? AND status = 'active'
      ORDER BY created_at DESC 
      LIMIT 1;
    `);
    const row = stmt.get(agentGroupId, messagingGroupId, threadId);
    return (row as unknown as SessionRow) ?? null;
  }
}

/**
 * Finds the single persistent session for an agent group.
 * Used for 'agent-shared' session mode.
 */
export function findSessionByAgentGroup(
  db: DatabaseSync, 
  agentGroupId: string
): SessionRow | null {
  const stmt = db.prepare(`
    SELECT * FROM sessions 
    WHERE agent_group_id = ? AND status = 'active'
    ORDER BY created_at DESC 
    LIMIT 1;
  `);
  const row = stmt.get(agentGroupId);
  return (row as unknown as SessionRow) ?? null;
}

/**
 * Updates session status (e.g. active -> archived) and/or container status (e.g. stopped -> running).
 */
export function updateSessionStatus(
  db: DatabaseSync,
  id: string,
  status: SessionStatus,
  containerStatus?: ContainerStatus
): void {
  if (containerStatus !== undefined) {
    db.prepare(`
      UPDATE sessions 
      SET status = ?, container_status = ? 
      WHERE id = ?;
    `).run(status, containerStatus, id);
  } else {
    db.prepare(`
      UPDATE sessions 
      SET status = ? 
      WHERE id = ?;
    `).run(status, id);
  }
}

/**
 * Updates the last_active timestamp of a session.
 */
export function touchSessionActivity(db: DatabaseSync, id: string): void {
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE sessions 
    SET last_active = ? 
    WHERE id = ?;
  `).run(now, id);
}
