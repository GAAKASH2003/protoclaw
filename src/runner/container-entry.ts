import path from 'node:path';
import fs from 'node:fs';
import { startPollLoop } from './poll-loop.js';
import {
    GeminiProvider,
    OpenRouterProvider,
    MockEchoProvider
} from './providers/index.js';
import type { AgentProvider } from './providers/types.js';

const sessionId = process.env.SESSION_ID || "ses1";
const agentGroupId = process.env.AGENT_GROUP_ID || "ses2";
if (!sessionId || !agentGroupId) {
  console.error('[container-entry] Fatal: Missing required SESSION_ID or AGENT_GROUP_ID environment variables.');
  process.exit(1);
}
const sessionDir = process.env.SESSION_DIR || '/workspace/session';
const workspaceDir = process.env.WORKSPACE_DIR || '/workspace/project';

function resolveProvider(): AgentProvider {
  if (process.env.GEMINI_API_KEY) {
    return new GeminiProvider({
      apiKey: process.env.GEMINI_API_KEY,
      model: process.env.GEMINI_MODEL || 'gemini-2.5-flash'
    });
  }
  if (process.env.OPENROUTER_API_KEY) {
    return new OpenRouterProvider({
      apiKey: process.env.OPENROUTER_API_KEY,
      model: process.env.OPENROUTER_MODEL || 'google/gemini-2.5-flash'
    });  
  }
  return new MockEchoProvider({ prefix: `[Container ${agentGroupId}] ` });
}

const abortController = new AbortController();
function handleShutdown(signal: string) {
  console.log(`[container-entry] Received ${signal}. Gracefully stopping poll loop...`);
  abortController.abort();
}
process.on('SIGTERM', () => handleShutdown('SIGTERM'));
process.on('SIGINT', () => handleShutdown('SIGINT'));

async function main() {
  console.log(`[container-entry] Booting ProtoClaw Runner container for session ${sessionId} (${agentGroupId})...`);
  const provider = resolveProvider();
  await startPollLoop({
    agentGroupId,
    sessionId,
    sessionDir,
    workspaceDir,
    provider,
    intervalMs: 500,
    signal: abortController.signal
  });   
}

main().catch((err) => {
  console.error('[container-entry] Fatal runner error:', err);
  process.exit(1);
});



