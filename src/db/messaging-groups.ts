import { DatabaseSync } from 'node:sqlite';
import type { 
  CreateMessagingGroupInput, 
  MessagingGroupRow, 
  UnknownSenderPolicy 
} from './types.js';


export function ensureMessagingGroup(
  db: DatabaseSync, 
  input: CreateMessagingGroupInput
): MessagingGroupRow {
  const instance = input.instance ?? input.channel_type;
  // 1. Check if already exists
  const existingStmt = db.prepare(`
    SELECT * FROM messaging_groups 
    WHERE id = ? OR (channel_type = ? AND platform_id = ? AND instance = ?);
  `);
  const existing = existingStmt.get(input.id, input.channel_type, input.platform_id, instance);
  if (existing) {
    return existing as unknown as MessagingGroupRow;
  }
  // 2. Insert new chat group
  const createdAt = input.created_at ?? new Date().toISOString();
  const name = input.name ?? null;
  const isGroup = typeof input.is_group === 'boolean' ? (input.is_group ? 1 : 0) : (input.is_group ?? 0);
  const policy: UnknownSenderPolicy = input.unknown_sender_policy ?? 'strict';
  const stmt = db.prepare(`
    INSERT INTO messaging_groups (
      id, channel_type, platform_id, instance, name, is_group, unknown_sender_policy, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?);
  `);
  stmt.run(input.id, input.channel_type, input.platform_id, instance, name, isGroup, policy, createdAt);
  return {
    id: input.id,
    channel_type: input.channel_type,
    platform_id: input.platform_id,
    instance,
    name,
    is_group: isGroup,
    unknown_sender_policy: policy,
    created_at: createdAt,
    denied_at: null
  };
}


export function getMessagingGroup(db: DatabaseSync, id: string): MessagingGroupRow | null {
  const stmt = db.prepare('SELECT * FROM messaging_groups WHERE id = ?;');
  const row = stmt.get(id);
  return (row as unknown as MessagingGroupRow) ?? null;
}

export function updateUnknownSenderPolicy(
  db: DatabaseSync, 
  id: string, 
  policy: UnknownSenderPolicy
): void {
  db.prepare(`
    UPDATE messaging_groups 
    SET unknown_sender_policy = ? 
    WHERE id = ?;
  `).run(policy, id);
}

export function listMessagingGroups(db: DatabaseSync): MessagingGroupRow[] {
  const stmt = db.prepare('SELECT * FROM messaging_groups ORDER BY created_at ASC;');
  return stmt.all() as unknown as MessagingGroupRow[];
}


