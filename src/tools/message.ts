/**
 * src/tools/message.ts
 * Cross-Channel & Inter-Agent `send_message` Tool for ProtoClaw.
 * 
 * Enables autonomous agents to:
 * 1. Dispatch messages to external chat channels (Telegram, Discord, WhatsApp, CLI).
 * 2. Send inter-agent messages to peer agents in other agent groups.
 * 
 * Invariants:
 * - Single-Writer Rule: Runner writes exclusively to its own `outbound.db`.
 * - Host Delivery Engine reads `outbound.db` and dispatches to the physical network.
 * - Sequence Parity: Dispatched outbound messages receive strictly odd sequence numbers.
 */

import type { DatabaseSync } from 'node:sqlite';
import type { DestinationEntry } from '../mailbox/destinations.js';
import type { ToolDefinition } from './workspace.js';
import { writeMessageOut } from '../mailbox/session-db.js';

export const SEND_MESSAGE_TOOL: ToolDefinition = {
  name: 'send_message',
  description: 'Sends a message to a named destination (external channel or peer agent).',
  parameters: {
    type: 'object',
    properties: {
      to: {
        type: 'string',
        description: 'Destination name (must match one of the available addressable destinations).'
      },
      content: {
        type: 'string',
        description: 'Text content to send.'
      }
    },
    required: ['to', 'content']
  }
};

export interface MessageToolContext {
  destinations?: DestinationEntry[];
  outDb?: DatabaseSync;
  inReplyTo?: string;
  onAgentMessage?: (targetAgentGroupId: string, content: string) => Promise<void> | void;
}

export interface SendMessageResult {
  success: boolean;
  destination: string;
  type: 'channel' | 'agent';
  message: string;
  messageId?: string;
}

/**
 * Validates destination target and dispatches the message according to destination type.
 */
export async function executeSendMessage(
  args: Record<string, any>,
  context?: MessageToolContext
): Promise<SendMessageResult> {
  const to = args.to || args.destination;
  const content = args.content || args.text || args.message;

  if (typeof to !== 'string' || !to.trim()) {
    throw new Error('send_message requires a string "to" argument specifying the target destination.');
  }

  if (typeof content !== 'string' || !content.trim()) {
    throw new Error('send_message requires a non-empty string "content" argument.');
  }

  const destinations = context?.destinations || [];
  const dest = destinations.find(
    (d) => d.name.toLowerCase() === to.trim().toLowerCase()
  );

  if (!dest) {
    const valid = destinations.map((d) => `"${d.name}"`).join(', ') || 'none';
    throw new Error(`Unknown destination: "${to}". Available destinations: ${valid}.`);
  }

  if (dest.type === 'channel') {
    if (!context?.outDb) {
      throw new Error(
        `Cannot send to channel "${dest.name}": outbound database not available in execution context.`
      );
    }

    const outRow = writeMessageOut(context.outDb, {
      in_reply_to: context.inReplyTo,
      content: content.trim(),
      kind: 'text',
      channel_type: dest.channelType,
      platform_id: dest.platformId
    });

    return {
      success: true,
      destination: dest.name,
      type: 'channel',
      message: `Message dispatched to channel "${dest.name}" (${dest.channelType ?? 'generic'}).`,
      messageId: outRow.id
    };
  }

  if (dest.type === 'agent') {
    const targetAgent = dest.agentGroupId || dest.name;
    if (context?.onAgentMessage) {
      await context.onAgentMessage(targetAgent, content.trim());
    }

    return {
      success: true,
      destination: dest.name,
      type: 'agent',
      message: `Message routed to peer agent "${dest.name}" (${targetAgent}).`
    };
  }

  throw new Error(`Unsupported destination type: ${(dest as any).type}`);
}
