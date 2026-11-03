/**
 * TypeScript type definitions and contracts for the Dual-DB Mailbox IPC.
 */

export type InboundKind = 'message' | 'task' | 'cron' | 'system' | 'response';
export type MessageStatus = 'pending' | 'processing' | 'completed' | 'failed' | 'ignored';
export type OutboundKind = 'text' | 'card' | 'question';
export type ProcessingStatus = 'processing' | 'completed' | 'failed' | 'skipped';
export type DestinationType = 'channel' | 'agent';

/** Row structure of messages_in in inbound.db */
export interface MessageInRow {
  id: string;
  seq: number; // Host-allocated EVEN number (2, 4, 6...)
  kind: InboundKind;
  timestamp: string;
  status: MessageStatus;
  process_after: string | null;
  recurrence: string | null;
  series_id: string | null;
  tries: number;
  trigger: number; // 1 or 0
  platform_id: string | null;
  channel_type: string | null;
  thread_id: string | null;
  content: string;
  source_session_id: string | null;
  on_wake: number; // 1 or 0
}

/** Row structure of delivered in inbound.db */
export interface DeliveredRow {
  message_out_id: string;
  platform_message_id: string | null;
  status: string;
  delivered_at: string;
}

/** Row structure of destinations in inbound.db */
export interface DestinationRow {
  name: string;
  display_name: string | null;
  type: DestinationType;
  channel_type: string | null;
  platform_id: string | null;
  agent_group_id: string | null;
}

/** Row structure of session_routing in inbound.db */
export interface SessionRoutingRow {
  id: 1;
  channel_type: string | null;
  platform_id: string | null;
  thread_id: string | null;
}

/** Row structure of messages_out in outbound.db */
export interface MessageOutRow {
  id: string;
  seq: number; // Runner-allocated ODD number (1, 3, 5...)
  in_reply_to: string | null;
  timestamp: string;
  deliver_after: string | null;
  recurrence: string | null;
  kind: OutboundKind;
  platform_id: string | null;
  channel_type: string | null;
  thread_id: string | null;
  content: string;
}

/** Row structure of processing_ack in outbound.db */
export interface ProcessingAckRow {
  message_id: string;
  status: ProcessingStatus;
  status_changed: string;
}

/** Row structure of session_state in outbound.db */
export interface SessionStateRow {
  key: string;
  value: string;
  updated_at: string;
}

/** Row structure of container_state in outbound.db */
export interface ContainerStateRow {
  id: 1;
  current_tool: string | null;
  tool_declared_timeout_ms: number | null;
  tool_started_at: string | null;
  updated_at: string;
}

/** Input payload for writing an inbound message (seq is auto-allocated) */
export interface InboundWrite {
  id?: string;
  kind?: InboundKind;
  timestamp?: string;
  status?: MessageStatus;
  process_after?: string | null;
  recurrence?: string | null;
  series_id?: string | null;
  tries?: number;
  trigger?: number;
  platform_id?: string | null;
  channel_type?: string | null;
  thread_id?: string | null;
  content: string;
  source_session_id?: string | null;
  on_wake?: number;
}

/** Input payload for writing an outbound message (seq is auto-allocated) */
export interface OutboundWrite {
  id?: string;
  in_reply_to?: string | null;
  timestamp?: string;
  deliver_after?: string | null;
  recurrence?: string | null;
  kind?: OutboundKind;
  platform_id?: string | null;
  channel_type?: string | null;
  thread_id?: string | null;
  content: string;
}
