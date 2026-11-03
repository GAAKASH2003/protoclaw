import { DatabaseSync } from 'node:sqlite';
import { ensureUser, isOwner, isAdmin } from './db/users.js';
import { ensureMessagingGroup, getMessagingGroup } from './db/messaging-groups.js';
import { findWiringsForMessagingGroup } from './db/wirings.js';
import { resolveOrCreateSession, inboundDbPath } from './session-manager.js';
import { openInboundDb, writeMessageIn } from './mailbox/session-db.js';
import type { InboundEvent, RouteResult } from './types.js';
import type { MessagingGroupAgentRow, SessionMode } from './db/types.js';



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
    onWake?: (sessionId: string)=> void):Promise<RouteResult[]>{
    const user = ensureUser(db, {
        id: event.sender.id,
        kind: event.channelType,
        display_name: event.sender.displayName ?? null
    });
    const messagingGroup = ensureMessagingGroup(db, {
        id: `${event.channelType}:${event.platformId}`,
        channel_type: event.channelType,
        platform_id: event.platformId
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
    const wirings = findWiringsForMessagingGroup(db, messagingGroup.id);
    if (wirings.length === 0) {
        return [];
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

        // 7. Fire wake callback
    if (onWake) {
        onWake(session.id);
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