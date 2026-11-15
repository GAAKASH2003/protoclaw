import { 
  openInboundDb, 
  openOutboundDb, 
  readPendingInboundMessages, 
  updateProcessingAck, 
  writeMessageOut 
} from '../mailbox/session-db.js';

import { inboundDbPath, outboundDbPath, heartbeatPath } from '../session-manager.js';
import { touchHeartbeat } from './heartbeat.js';
import type { AgentProvider, ProviderContext } from './providers/types.js';
import { loadSessionHistory } from './history.js';

export interface PollCycleConfig {
    agentGroupId: string;
    sessionId: string;
    provider: AgentProvider;
    systemPrompt?: string;
    context?: ProviderContext;
}

export interface PollLoopConfig extends PollCycleConfig {
    intervalMs?: number;
    signal?: AbortSignal;
}

// Prevents concurrent poll cycles on the same session from racing or duplicating work
const activePollSessions = new Set<string>();

export async function runPollCycle(
    config: PollCycleConfig
): Promise<{ processed: number }> {
    const sessionKey = `${config.agentGroupId}:${config.sessionId}`;
    if (activePollSessions.has(sessionKey)) {
        return { processed: 0 };
    }
    activePollSessions.add(sessionKey);

    const inPath = inboundDbPath(config.agentGroupId, config.sessionId);
    const outPath = outboundDbPath(config.agentGroupId, config.sessionId);
    const hbPath = heartbeatPath(config.agentGroupId, config.sessionId);
    const inDb = openInboundDb(inPath);
    let processedCount = 0;

    try {
        const pendingMessages = readPendingInboundMessages(inDb);
        if (pendingMessages.length === 0) {
            return { processed: 0 };
        }
        const outDb = openOutboundDb(outPath, false);
        try {
            touchHeartbeat(hbPath);
            for (const msg of pendingMessages) {
                // Immediately transition to 'processing' in inbound.db so parallel ticks cannot re-claim it
                inDb.prepare("UPDATE messages_in SET status = 'processing' WHERE id = ?").run(msg.id);
                updateProcessingAck(outDb, msg.id, 'processing');
                const history = loadSessionHistory(inDb, outDb, {currentMessageId: msg.id,maxTurns: 20});
                let replyText: string;
                try {
                   replyText = await config.provider.query(msg.content, {
                     systemPrompt: config.systemPrompt,
                     history,
                     ...config.context
                   }); 
                } catch (error) {
                    updateProcessingAck(outDb, msg.id, 'failed');
                    inDb.prepare("UPDATE messages_in SET status = 'failed' WHERE id = ?").run(msg.id);
                    throw error;     
                }

                writeMessageOut(outDb, {
                    in_reply_to: msg.id,
                    content: replyText,
                    kind: 'text',
                    channel_type: msg.channel_type,
                    platform_id: msg.platform_id,
                    thread_id: msg.thread_id
                });

                updateProcessingAck(outDb, msg.id, 'completed');
                inDb.prepare("UPDATE messages_in SET status = 'completed' WHERE id = ?").run(msg.id);
                touchHeartbeat(hbPath);
                processedCount++;
            }
        } 
        finally {
            outDb.close();
        }
    } 
    finally {
        inDb.close();
        activePollSessions.delete(sessionKey);
    }
    return { processed: processedCount };
}

export async function startPollLoop(config: PollLoopConfig): Promise<void> {
  const interval = config.intervalMs ?? 500;
  while (!config.signal?.aborted) {
    try {
      await runPollCycle(config);
    } catch (err) {
      console.error(`[poll-loop] Error in session ${config.sessionId}:`, err);
    }
    if (config.signal?.aborted) break;
    // Wait intervalMs before next poll
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}
