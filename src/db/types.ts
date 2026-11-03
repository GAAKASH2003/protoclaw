/**
 * TypeScript types and domain contracts for ProtoClaw's central database (protoclaw.db).
 */

export type EngageMode = 'pattern' | 'mention' | 'mention-sticky';
export type SessionMode = 'shared' | 'per-thread' | 'agent-shared';
export type UserRoleType = 'owner' | 'admin';
export type UnknownSenderPolicy = 'strict' | 'request_approval' | 'public';
export type SenderScope = 'all' | 'known';
export type IgnoredMessagePolicy = 'drop' | 'accumulate';
export type SessionStatus = 'active' | 'archived';
export type ContainerStatus = 'running' | 'stopped';
export type RouteResult ='routed'|'ignored'|'denied';
/** Row structure of agent_groups table */
export interface AgentGroupRow {
  id: string;
  name: string;
  folder: string;
  agent_provider: string | null;
  created_at: string;
}

/** Row structure of messaging_groups table */
export interface MessagingGroupRow {
  id: string;
  channel_type: string;
  platform_id: string;
  instance: string;
  name: string | null;
  is_group: number; // 1 or 0
  unknown_sender_policy: UnknownSenderPolicy;
  created_at: string;
  denied_at: string | null;
}

/** Row structure of messaging_group_agents (wiring table) */
export interface MessagingGroupAgentRow {
  id: string;
  messaging_group_id: string;
  agent_group_id: string;
  engage_mode: EngageMode;
  engage_pattern: string | null;
  sender_scope: SenderScope;
  ignored_message_policy: IgnoredMessagePolicy;
  session_mode: SessionMode;
  priority: number;
  threads: number | null;
  created_at: string;
}

/** Row structure of users table */
export interface UserRow {
  id: string;
  kind: string;
  display_name: string | null;
  created_at: string;
}

/** Row structure of user_roles table */
export interface UserRoleRow {
  user_id: string;
  role: UserRoleType;
  agent_group_id: string | null; // null = global grant, string = scoped grant
  granted_by: string | null;
  granted_at: string;
}

/** Row structure of agent_group_members table */
export interface AgentGroupMemberRow {
  user_id: string;
  agent_group_id: string;
  added_by: string | null;
  added_at: string;
}

/** Row structure of user_dms table */
export interface UserDmRow {
  user_id: string;
  channel_type: string;
  messaging_group_id: string;
  resolved_at: string;
}

/** Row structure of sessions table */
export interface SessionRow {
  id: string;
  agent_group_id: string;
  messaging_group_id: string | null;
  thread_id: string | null;
  agent_provider: string | null;
  status: SessionStatus;
  container_status: ContainerStatus;
  last_active: string | null;
  created_at: string;
}

/** Input for creating an agent group */
export interface CreateAgentGroupInput {
  id: string;
  name: string;
  folder: string;
  agent_provider?: string | null;
  created_at?: string;
}

/** Input for creating/ensuring a messaging group */
export interface CreateMessagingGroupInput {
  id: string;
  channel_type: string;
  platform_id: string;
  instance?: string;
  name?: string | null;
  is_group?: boolean | number;
  unknown_sender_policy?: UnknownSenderPolicy;
  created_at?: string;
}

/** Input for wiring a messaging group to an agent group */
export interface CreateWiringInput {
  id?: string;
  messaging_group_id: string;
  agent_group_id: string;
  engage_mode?: EngageMode;
  engage_pattern?: string | null;
  sender_scope?: SenderScope;
  ignored_message_policy?: IgnoredMessagePolicy;
  session_mode?: SessionMode;
  priority?: number;
  threads?: number | null;
  created_at?: string;
}

/** Input for registering a user */
export interface CreateUserInput {
  id: string;
  kind: string;
  display_name?: string | null;
  created_at?: string;
}

/** Input for granting a role */
export interface GrantRoleInput {
  user_id: string;
  role: UserRoleType;
  agent_group_id?: string | null;
  granted_by?: string | null;
  granted_at?: string;
}

/** Input for creating a session */
export interface CreateSessionInput {
  id?: string;
  agent_group_id: string;
  messaging_group_id?: string | null;
  thread_id?: string | null;
  agent_provider?: string | null;
  status?: SessionStatus;
  container_status?: ContainerStatus;
  last_active?: string | null;
  created_at?: string;
}

export interface InboundEvent{
  channelType: string;
  platformId: string;
  threadId?:string|null;
  sender:{
    id:string;
    displayName?: string;
  };
  text: string;
  isMention?:boolean;
  timestamp?:string;
}

