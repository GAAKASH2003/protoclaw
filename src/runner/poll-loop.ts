import path from 'node:path';
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
import { ensureGroupWorkspace, composeProjectInstructions } from '../project-doc-compose.js';
import { WORKSPACE_TOOLS_DOCUMENTATION } from '../tools/workspace.js';
import { executeAgentWithTools } from './tool-loop.js';
import { readDestinations, formatDestinationsDocumentation } from '../mailbox/destinations.js';

export interface PollCycleConfig {
    agentGroupId: string;
    sessionId: string;
    provider: AgentProvider;
    systemPrompt?: string;
    context?: ProviderContext;
    sessionDir?: string;
    workspaceDir?: string;
    maxToolSteps?: number;
    onToolCall?: (call: { name: string; args: any; result: any; error?: string }) => void;
    onAgentMessage?: (targetAgentGroupId: string, content: string) => Promise<void> | void;
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

    const inPath = config.sessionDir
        ? path.join(config.sessionDir, 'inbound.db')
        : inboundDbPath(config.agentGroupId, config.sessionId);
    const outPath = config.sessionDir
        ? path.join(config.sessionDir, 'outbound.db')
        : outboundDbPath(config.agentGroupId, config.sessionId);
    const hbPath = config.sessionDir
        ? path.join(config.sessionDir, '.heartbeat')
        : heartbeatPath(config.agentGroupId, config.sessionId);
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

            // Ensure workspace directory & standing instructions exist
            const paths = ensureGroupWorkspace(config.agentGroupId);
            const workspaceDir = config.workspaceDir || paths.workspaceDir;
            const baseSystemPrompt = config.systemPrompt || composeProjectInstructions(config.agentGroupId, {
                toolsDocumentation: WORKSPACE_TOOLS_DOCUMENTATION
            });

            // Read addressable destinations from inbound.db
            const destinations = readDestinations(inDb);
            const systemPrompt = destinations.length > 0
                ? `${baseSystemPrompt}\n\n${formatDestinationsDocumentation(destinations)}`
                : baseSystemPrompt;

            for (const msg of pendingMessages) {
                // Immediately transition to 'processing' in inbound.db so parallel ticks cannot re-claim it
                inDb.prepare("UPDATE messages_in SET status = 'processing' WHERE id = ?").run(msg.id);
                updateProcessingAck(outDb, msg.id, 'processing');
                const history = loadSessionHistory(inDb, outDb, { currentMessageId: msg.id, maxTurns: 20 });
                let replyText: string;
                try {
                   const toolLoopResult = await executeAgentWithTools({
                     workspaceDir,
                     provider: config.provider,
                     userPrompt: msg.content,
                     systemPrompt,
                     history,
                     maxSteps: config.maxToolSteps ?? 5,
                     context: config.context,
                     onToolCall: config.onToolCall,
                     toolContext: {
                       destinations,
                       outDb,
                       inReplyTo: msg.id,
                       onAgentMessage: config.onAgentMessage
                     }
                   });
                   replyText = toolLoopResult.finalText;
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
