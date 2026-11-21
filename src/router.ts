import { DatabaseSync } from 'node:sqlite';
import { ensureUser, isOwner, isAdmin } from './db/users.js';
import { ensureMessagingGroup, getMessagingGroup } from './db/messaging-groups.js';
import { findWiringsForMessagingGroup, wireAgentToMessagingGroup } from './db/wirings.js';
import { getAgentGroup } from './db/agent-groups.js';
import { resolveOrCreateSession, inboundDbPath } from './session-manager.js';
import { openInboundDb, writeMessageIn } from './mailbox/session-db.js';
import type { InboundEvent, RouteResult } from './types.js';
import type { MessagingGroupAgentRow, SessionMode } from './db/types.js';
import { wakeContainer } from './container-runner.js';
import { 
  CONTAINER_RUNNER, 
  CONTAINER_IMAGE, 
  CONTAINER_IDLE_TIMEOUT_MS 
} from './config.js';
export type WakeCallback = (sessionId: string, agentGroupId: string) => Promise<void> | void;


export function evaluateEngage(
  wiring: MessagingGroupAgentRow,
  text: string,
  isMention: boolean = false
): boolean {
  if (wiring.engage_mode === 'mention' || wiring.engage_mode === 'mention-sticky') {
    return isMention;
  }
  if (wiring.engage_mode === 'pattern') {
    if (!wiring.engage_pattern) return false;
    try {
      const regex = new RegExp(wiring.engage_pattern, 'i');
      return regex.test(text);
    } catch {
      return false;
    }
  }
  return false;
}

export async function routeInbound(
    event: InboundEvent,
    db: DatabaseSync,
    onWake?: WakeCallback
): Promise<RouteResult[]> {
    const user = ensureUser(db, {
        id: event.sender.id,
        kind: event.channelType,
        display_name: event.sender.displayName ?? null
    });
    const messagingGroup = ensureMessagingGroup(db, {
        id: `${event.channelType}:${event.platformId}`,
        channel_type: event.channelType,
        platform_id: event.platformId,
        unknown_sender_policy: 'public'
    });

    const isAuthorized = isOwner(db, user.id) || isAdmin(db, user.id);
    if (!isAuthorized && messagingGroup.unknown_sender_policy === 'strict') {
        return [{
        agentGroupId: '',
        sessionId: '',
        messageId: '',
        status: 'denied',
        reason: 'Unknown sender blocked by strict policy'
        }];
   }
    let wirings = findWiringsForMessagingGroup(db, messagingGroup.id);
    if (wirings.length === 0) {
      // Auto-wire new channels to default 'assistant' if it exists
      const defaultAgent = getAgentGroup(db, 'assistant');
      if (defaultAgent) {
        wireAgentToMessagingGroup(db, {
          messaging_group_id: messagingGroup.id,
          agent_group_id: defaultAgent.id,
          engage_mode: 'pattern',
          engage_pattern: '.',
          session_mode: 'shared'
        });
        wirings = findWiringsForMessagingGroup(db, messagingGroup.id);
      } else {
        return [];
      }
    }
    const results: RouteResult[] = [];
    for (const wiring of wirings) {
        const isEngaged = evaluateEngage(wiring, event.text, event.isMention);
        if (!isEngaged) {
        continue;
        }
        // 5. Resolve or create session
        const { session } = await resolveOrCreateSession(
        db,
        wiring.agent_group_id,
        messagingGroup.id,
        event.threadId ?? null,
        wiring.session_mode as SessionMode,
        { channelType: event.channelType, platformId: event.platformId }
        );
        // 6. Write message into inbound.db (with EVEN sequence number)
        const inDb = openInboundDb(inboundDbPath(wiring.agent_group_id, session.id));
        let msgId = '';
        try {
        const msgRow = writeMessageIn(inDb, {
            channel_type: event.channelType,
            platform_id: event.platformId,
            thread_id: event.threadId ?? null,
            content: event.text,
            trigger: 1
        });
        msgId = msgRow.id;
    } 
    finally {
        inDb.close();
    }

    if(onWake){
      await onWake(session.id, wiring.agent_group_id);
    } 
    else if (CONTAINER_RUNNER) {
      await wakeContainer(wiring.agent_group_id, session.id, {
        imageName: CONTAINER_IMAGE,
        idleTimeoutMs: CONTAINER_IDLE_TIMEOUT_MS
      });
    }
    results.push({
        agentGroupId: wiring.agent_group_id,
        sessionId: session.id,
        messageId: msgId,
        status: 'routed'
        });
    }
    
    return results;

}