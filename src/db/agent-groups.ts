import { DatabaseSync } from 'node:sqlite';
import type { AgentGroupRow, CreateAgentGroupInput } from './types.js';

export function createAgentGroup(db: DatabaseSync, input: CreateAgentGroupInput): AgentGroupRow {
  const createdAt = input.created_at ?? new Date().toISOString();
  const provider = input.agent_provider ?? null;
  const stmt = db.prepare(`
    INSERT INTO agent_groups (id, name, folder, agent_provider, created_at)
    VALUES (?, ?, ?, ?, ?);
  `);
  stmt.run(input.id, input.name, input.folder, provider, createdAt);
  return {
    id: input.id,
    name: input.name,
    folder: input.folder,
    agent_provider: provider,
    created_at: createdAt
  };
}

export function getAgentGroup(db: DatabaseSync, id: string): AgentGroupRow | null {
  const stmt = db.prepare('SELECT * FROM agent_groups WHERE id = ?;');
  const row = stmt.get(id);
  return (row as unknown as AgentGroupRow) ?? null;
}

export function listAgentGroups(db: DatabaseSync): AgentGroupRow[] {
  const stmt = db.prepare('SELECT * FROM agent_groups ORDER BY created_at ASC;');
  return stmt.all() as unknown as AgentGroupRow[];
}

export function deleteAgentGroup(db: DatabaseSync, id: string): void {
  db.prepare('DELETE FROM agent_groups WHERE id = ?;').run(id);
}


