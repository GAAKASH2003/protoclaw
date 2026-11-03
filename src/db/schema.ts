/**
 * SQL DDL definition for ProtoClaw's central relational database (protoclaw.db).
 *
 * Invariants:
 *  - Central DB is host-owned and accessed strictly in WAL mode with Foreign Keys enabled.
 *  - Workspaces (agent_groups) are neutral sandboxes; privilege lives on users (user_roles).
 *  - Many-to-many relationships between chats (messaging_groups) and agents (agent_groups)
 *    are governed by messaging_group_agents with explicit engage and session modes.
 */

export const SCHEMA = `
-- Agent workspaces: folder path, instructions, and provider configuration.
CREATE TABLE IF NOT EXISTS agent_groups (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  folder         TEXT NOT NULL UNIQUE,
  agent_provider TEXT,
  created_at     TEXT NOT NULL
);

-- External platform channels, chat groups, and DMs.
CREATE TABLE IF NOT EXISTS messaging_groups (
  id                    TEXT PRIMARY KEY,
  channel_type          TEXT NOT NULL,
  platform_id           TEXT NOT NULL,
  instance              TEXT NOT NULL,
  name                  TEXT,
  is_group              INTEGER DEFAULT 0,
  unknown_sender_policy TEXT NOT NULL DEFAULT 'strict',
  created_at            TEXT NOT NULL,
  denied_at             TEXT,
  UNIQUE(channel_type, platform_id, instance)
);

-- Wirings: links messaging groups to agent groups with engage and session rules.
CREATE TABLE IF NOT EXISTS messaging_group_agents (
  id                     TEXT PRIMARY KEY,
  messaging_group_id     TEXT NOT NULL REFERENCES messaging_groups(id) ON DELETE CASCADE,
  agent_group_id         TEXT NOT NULL REFERENCES agent_groups(id) ON DELETE CASCADE,
  engage_mode            TEXT NOT NULL DEFAULT 'mention',
  engage_pattern         TEXT,
  sender_scope           TEXT NOT NULL DEFAULT 'all',
  ignored_message_policy TEXT NOT NULL DEFAULT 'drop',
  session_mode           TEXT DEFAULT 'shared',
  priority               INTEGER DEFAULT 0,
  threads                INTEGER,
  created_at             TEXT NOT NULL,
  UNIQUE(messaging_group_id, agent_group_id)
);

-- Namespaced users across messaging platforms (e.g. 'cli:local', 'tg:12345678').
CREATE TABLE IF NOT EXISTS users (
  id           TEXT PRIMARY KEY,
  kind         TEXT NOT NULL,
  display_name TEXT,
  created_at   TEXT NOT NULL
);

-- User-level privileges: owner (global) and admin (global or scoped to an agent group).
CREATE TABLE IF NOT EXISTS user_roles (
  user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role           TEXT NOT NULL,
  agent_group_id TEXT REFERENCES agent_groups(id) ON DELETE CASCADE,
  granted_by     TEXT REFERENCES users(id),
  granted_at     TEXT NOT NULL,
  PRIMARY KEY (user_id, role, agent_group_id)
);
CREATE INDEX IF NOT EXISTS idx_user_roles_scope ON user_roles(agent_group_id, role);

-- Access list membership for non-admin users when sender_scope = 'known'.
CREATE TABLE IF NOT EXISTS agent_group_members (
  user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  agent_group_id TEXT NOT NULL REFERENCES agent_groups(id) ON DELETE CASCADE,
  added_by       TEXT REFERENCES users(id),
  added_at       TEXT NOT NULL,
  PRIMARY KEY (user_id, agent_group_id)
);

-- Cached 1-on-1 direct message channels for initiating proactive notifications.
CREATE TABLE IF NOT EXISTS user_dms (
  user_id            TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel_type       TEXT NOT NULL,
  messaging_group_id TEXT NOT NULL REFERENCES messaging_groups(id) ON DELETE CASCADE,
  resolved_at        TEXT NOT NULL,
  PRIMARY KEY (user_id, channel_type)
);

-- Active and historical sessions (maps to data/sessions/<agent_group_id>/<session_id>/).
CREATE TABLE IF NOT EXISTS sessions (
  id                 TEXT PRIMARY KEY,
  agent_group_id     TEXT NOT NULL REFERENCES agent_groups(id) ON DELETE CASCADE,
  messaging_group_id TEXT REFERENCES messaging_groups(id) ON DELETE SET NULL,
  thread_id          TEXT,
  agent_provider     TEXT,
  status             TEXT DEFAULT 'active',
  container_status   TEXT DEFAULT 'stopped',
  last_active        TEXT,
  created_at         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_agent_group ON sessions(agent_group_id);
CREATE INDEX IF NOT EXISTS idx_sessions_lookup ON sessions(messaging_group_id, thread_id);
`;
