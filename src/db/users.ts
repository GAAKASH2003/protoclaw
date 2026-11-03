import { DatabaseSync } from "node:sqlite";

import type { 
  CreateUserInput, 
  GrantRoleInput, 
  UserRoleRow, 
  UserRow, 
  UserRoleType 
} from './types.js';

export function ensureUser(db: DatabaseSync, input: CreateUserInput): UserRow {
  const existing = getUser(db, input.id);
  if (existing) {
    return existing;
  }
  const createdAt = input.created_at ?? new Date().toISOString();
  const displayName = input.display_name ?? null;
  const stmt = db.prepare(`
    INSERT INTO users (id, kind, display_name, created_at)
    VALUES (?, ?, ?, ?);
  `);
  stmt.run(input.id, input.kind, displayName, createdAt);
  return {
    id: input.id,
    kind: input.kind,
    display_name: displayName,
    created_at: createdAt
  };
}

export function getUser(db: DatabaseSync, id: string): UserRow | null {
  const stmt = db.prepare('SELECT * FROM users WHERE id = ?;');
  const row = stmt.get(id);
  return (row as unknown as UserRow) ?? null;
};

export function grantRole(db: DatabaseSync, input: GrantRoleInput): UserRoleRow {
  const targetAgentGroup = input.role === 'owner' ? null : (input.agent_group_id ?? null);
  const grantedAt = input.granted_at ?? new Date().toISOString();
  const grantedBy = input.granted_by ?? null;
  const stmt = db.prepare(`
    INSERT INTO user_roles (user_id, role, agent_group_id, granted_by, granted_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(user_id, role, agent_group_id) DO UPDATE SET
      granted_by = excluded.granted_by,
      granted_at = excluded.granted_at;
  `);
  stmt.run(input.user_id, input.role, targetAgentGroup, grantedBy, grantedAt);
  return {
    user_id: input.user_id,
    role: input.role,
    agent_group_id: targetAgentGroup,
    granted_by: grantedBy,
    granted_at: grantedAt
  };
}

export function revokeRole(
  db: DatabaseSync, 
  userId: string, 
  role: UserRoleType, 
  agentGroupId: string | null = null
): void {
  const targetAgentGroup = role === 'owner' ? null : agentGroupId;
  
  if (targetAgentGroup === null) {
    db.prepare(`
      DELETE FROM user_roles 
      WHERE user_id = ? AND role = ? AND agent_group_id IS NULL;
    `).run(userId, role);
  } else {
    db.prepare(`
      DELETE FROM user_roles 
      WHERE user_id = ? AND role = ? AND agent_group_id = ?;
    `).run(userId, role, targetAgentGroup);
  }
}

export function isOwner(db: DatabaseSync, userId: string): boolean {
  const stmt = db.prepare(`
    SELECT 1 FROM user_roles 
    WHERE user_id = ? AND role = 'owner' AND agent_group_id IS NULL;
  `);
  return stmt.get(userId) !== undefined;
}


export function isAdmin(db: DatabaseSync, userId: string, agentGroupId?: string): boolean {
  // 1. Owner is automatically admin everywhere
  if (isOwner(db, userId)) {
    return true;
  }
  // 2. Global admin has admin rights across all workspaces
  const globalAdminStmt = db.prepare(`
    SELECT 1 FROM user_roles 
    WHERE user_id = ? AND role = 'admin' AND agent_group_id IS NULL;
  `);
  if (globalAdminStmt.get(userId) !== undefined) {
    return true;
  }
  // 3. Scoped admin rights
  if (agentGroupId) {
    const scopedAdminStmt = db.prepare(`
      SELECT 1 FROM user_roles 
      WHERE user_id = ? AND role = 'admin' AND agent_group_id = ?;
    `);
    if (scopedAdminStmt.get(userId, agentGroupId) !== undefined) {
      return true;
    }
  }
  return false;
}


