import path from 'node:path';
import fs from 'node:fs';
import { SESSIONS_DIR } from './config.js';
import { ensureSchema, openInboundDb } from './mailbox/session-db.js';
import { DatabaseSync } from 'node:sqlite';
import { 
  findSessionForAgent, 
  findSessionByAgentGroup, 
  createSession 
} from './db/sessions.js';
import type { SessionRow, SessionMode } from './db/types.js';


export function sessionsBaseDir(): string {
  return SESSIONS_DIR;
}

export function sessionDir(agentGroupId: string, sessionId: string): string {
  return path.join(sessionsBaseDir(), agentGroupId, sessionId);
}

export function inboundDbPath(agentGroupId: string, sessionId: string): string {
  return path.join(sessionDir(agentGroupId, sessionId), 'inbound.db');
}

export function outboundDbPath(agentGroupId: string, sessionId: string): string {
  return path.join(sessionDir(agentGroupId, sessionId), 'outbound.db');
}

const sessionCreationLocks = new Map<string, Promise<void>>();

function sessionCreationKey(
    agentGroupId: string,
    messagingGroupId:string|null,
    threadId:string|null,
    sessionMode: SessionMode,
):string{
    if(sessionMode=='agent-shared'){
        return `agent:${agentGroupId}`;
    }
    const thread=sessionMode==='shared'?'':(threadId ?? '');
  return `route:${agentGroupId}:${messagingGroupId ?? ''}:${thread}`;
}


export async function withSessionCreationLock<T>(
  key: string, 
  fn: () => Promise<T>
): Promise<T> {
  const previous = sessionCreationLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  
  const tail = previous.then(() => current);
  sessionCreationLocks.set(key, tail);
  
  await previous; 
  try {
    return await fn();
  } finally {
    release(); 
    if (sessionCreationLocks.get(key) === tail) {
      sessionCreationLocks.delete(key);
    }
  }
}


export function provisionSessionStorage(
  agentGroupId: string,
  sessionId: string,
  routing?: { channelType: string | null; platformId: string | null; threadId: string | null }
): void {
  const dir = sessionDir(agentGroupId, sessionId);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const inPath = inboundDbPath(agentGroupId, sessionId);
  const outPath = outboundDbPath(agentGroupId, sessionId);

  // Apply Phase 1 schemas with journal_mode = DELETE
  ensureSchema(inPath, 'inbound');
  ensureSchema(outPath, 'outbound');

  // Populate session_routing in inbound.db so runner knows where default replies go
  if (routing) {
    const inDb = openInboundDb(inPath);
    try {
      inDb.prepare(`
        INSERT INTO session_routing (id, channel_type, platform_id, thread_id)
        VALUES (1, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          channel_type = excluded.channel_type,
          platform_id = excluded.platform_id,
          thread_id = excluded.thread_id;
      `).run(routing.channelType, routing.platformId, routing.threadId);
    } finally {
      inDb.close();
    }
  }
}



export async function resolveOrCreateSession(
  db: DatabaseSync,
  agentGroupId: string,
  messagingGroupId: string | null,
  threadId: string | null,
  sessionMode: SessionMode,
  routing?: { channelType: string | null; platformId: string | null }
): Promise<{ session: SessionRow; created: boolean }> {
  const key = sessionCreationKey(agentGroupId, messagingGroupId, threadId, sessionMode);

  return withSessionCreationLock(key, async () => {
    // 1. Check if session already exists based on session_mode
    if (sessionMode === 'agent-shared') {
      const existing = findSessionByAgentGroup(db, agentGroupId);
      if (existing) return { session: existing, created: false };
    } else if (messagingGroupId) {
      const lookupThreadId = sessionMode === 'shared' ? null : threadId;
      const existing = findSessionForAgent(db, agentGroupId, messagingGroupId, lookupThreadId);
      if (existing) return { session: existing, created: false };
    }

    // 2. Create session record in Central DB
    const lookupThreadId = sessionMode === 'per-thread' ? threadId : null;
    const newSession = createSession(db, {
      agent_group_id: agentGroupId,
      messaging_group_id: messagingGroupId,
      thread_id: lookupThreadId
    });

    // 3. Provision physical directories and mailbox databases on disk
    provisionSessionStorage(agentGroupId, newSession.id, {
      channelType: routing?.channelType ?? null,
      platformId: routing?.platformId ?? null,
      threadId: lookupThreadId
    });

    return { session: newSession, created: true };
  });
}


export function heartbeatPath(agentGroupId: string, sessionId: string): string {
  return path.join(sessionDir(agentGroupId, sessionId), '.heartbeat');
}