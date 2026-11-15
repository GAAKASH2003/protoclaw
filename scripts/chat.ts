/**
 * Interactive Terminal Chat & Dual-DB Mailbox Test Script for ProtoClaw.
 * 
 * Usage:
 *   pnpm run chat                    # Launches interactive chat REPL
 *   pnpm run chat "What is 2 + 2?"   # Runs single query and exits
 */

import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import kleur from 'kleur';

import { getCentralDb, closeCentralDb } from '../src/db/connection.js';
import { ensureUser, grantRole, isOwner } from '../src/db/users.js';
import { createAgentGroup, getAgentGroup } from '../src/db/agent-groups.js';
import { ensureMessagingGroup } from '../src/db/messaging-groups.js';
import { wireAgentToMessagingGroup } from '../src/db/wirings.js';
import { routeInbound } from '../src/router.js';
import { runPollCycle } from '../src/runner/poll-loop.js';
import { createDefaultProvider } from '../src/runner/providers/index.js';
import { openInboundDb, openOutboundDb } from '../src/mailbox/session-db.js';
import { inboundDbPath, outboundDbPath } from '../src/session-manager.js';
import { deliverSessionMessages } from '../src/delivery.js';
import { CliChannelAdapter } from '../src/channels/cli.js';
import { registerChannelAdapter } from '../src/channels/registry.js';

let cliAdapter: CliChannelAdapter;

async function bootstrapCentralDb() {
  const db = getCentralDb();

  // Register CLI Channel Adapter with the delivery registry
  cliAdapter = new CliChannelAdapter({
    prefix: kleur.green().bold('\nProtoClaw:\n')
  });
  registerChannelAdapter(cliAdapter);

  // 1. Ensure user cli:local with owner role
  ensureUser(db, {
    id: 'cli:local',
    kind: 'cli',
    display_name: 'Local User'
  });
  if (!isOwner(db, 'cli:local')) {
    grantRole(db, {
      user_id: 'cli:local',
      role: 'owner',
      agent_group_id: null
    });
  }

  // 2. Ensure assistant agent group
  if (!getAgentGroup(db, 'assistant')) {
    createAgentGroup(db, {
      id: 'assistant',
      name: 'ProtoClaw Assistant',
      folder: 'assistant',
      agent_provider: 'gemini'
    });
  }

  // 3. Ensure messaging group for CLI
  ensureMessagingGroup(db, {
    id: 'cli:main',
    channel_type: 'cli',
    platform_id: 'main'
  });

  // 4. Wire CLI channel to assistant agent group (always engaged, shared session)
  wireAgentToMessagingGroup(db, {
    messaging_group_id: 'cli:main',
    agent_group_id: 'assistant',
    engage_mode: 'pattern',
    engage_pattern: '.',
    session_mode: 'shared'
  });

  return db;
}

async function processQuestion(
  question: string,
  db: ReturnType<typeof getCentralDb>,
  provider: ReturnType<typeof createDefaultProvider>
): Promise<void> {
  const trimmed = question.trim();
  if (!trimmed) return;

  process.stdout.write(kleur.yellow('⏳ Routing into inbound.db and querying Gemini...\r'));

  // 1. Route message into inbound.db (Host writes, Even sequence number)
  const routes = await routeInbound(
    {
      channelType: 'cli',
      platformId: 'main',
      sender: {
        id: 'cli:local',
        displayName: 'Local User'
      },
      text: trimmed
    },
    db
  );

  if (routes.length === 0 || routes[0].status !== 'routed') {
    console.error(kleur.red(`\n❌ Routing failed: ${routes[0]?.reason ?? 'Unknown error'}`));
    return;
  }

  const route = routes[0];

  // 2. Run runner poll cycle (Runner executes, Odd sequence number)
  try {
    const cycleResult = await runPollCycle({
      agentGroupId: route.agentGroupId,
      sessionId: route.sessionId,
      provider,
      systemPrompt: 'You are ProtoClaw, an intelligent AI assistant built on Dual-DB Mailbox IPC architecture.'
    });

    if (cycleResult.processed === 0) {
      console.log(kleur.yellow('\n⚠ No messages were processed in this cycle.'));
      return;
    }
  } catch (err: any) {
    console.error(kleur.red(`\n❌ Runner execution error: ${err.message}`));
    return;
  }

  // Clear "Routing..." line
  process.stdout.write(' '.repeat(65) + '\r');

  // 3. Run Delivery Engine to dispatch output and update delivered table
  const deliveryResult = await deliverSessionMessages(route.agentGroupId, route.sessionId);

  // 4. Inspect IPC sequence numbers for trace output
  const inPath = inboundDbPath(route.agentGroupId, route.sessionId);
  const outPath = outboundDbPath(route.agentGroupId, route.sessionId);

  let inSeq = '?';
  const inDb = openInboundDb(inPath);
  try {
    const inRow = inDb.prepare('SELECT seq FROM messages_in WHERE id = ?').get(route.messageId) as any;
    if (inRow) inSeq = String(inRow.seq);
  } finally {
    inDb.close();
  }

  const lastOut = cliAdapter.deliveredHistory[cliAdapter.deliveredHistory.length - 1];
  if (lastOut) {
    console.log(
      kleur.dim(
        `  [Dual-DB Mailbox IPC] Inbound seq: ${inSeq} (Host) → Outbound seq: ${lastOut.seq} (Runner) | Delivered: ${deliveryResult.delivered}\n`
      )
    );
  }
}

async function main() {
  const db = await bootstrapCentralDb();
  const provider = createDefaultProvider();

  console.log(kleur.cyan().bold('═══════════════════════════════════════════════════════════'));
  console.log(kleur.cyan().bold('           🐾 ProtoClaw - Dual-DB Mailbox Chat             '));
  console.log(kleur.cyan().bold('═══════════════════════════════════════════════════════════'));

  if (provider.name === 'gemini') {
    const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
    console.log(kleur.green(`✓ Active Provider: Google AI Studio Gemini API`));
    console.log(kleur.gray(`  Model: ${model}`));
  } else if (provider.name === 'openrouter') {
    const model = process.env.OPENROUTER_MODEL || 'google/gemini-2.5-flash';
    console.log(kleur.green(`✓ Active Provider: OpenRouter`));
    console.log(kleur.gray(`  Model: ${model}`));
  } else {
    console.log(kleur.yellow(`⚠ Active Provider: MockEchoProvider (No GEMINI_API_KEY found)`));
    console.log(kleur.gray(`  Tip: Add GEMINI_API_KEY to protoclaw/.env to use real Gemini AI.`));
  }
  console.log(kleur.gray('───────────────────────────────────────────────────────────\n'));

  // If command line arguments were passed, process once and exit
  const args = process.argv.slice(2);
  if (args.length > 0) {
    const question = args.join(' ');
    console.log(kleur.blue().bold('You: ') + question);
    await processQuestion(question, db, provider);
    closeCentralDb();
    process.exit(0);
  }

  // Interactive REPL
  console.log(kleur.gray('Type your message below. Type "exit" or "quit" to leave.\n'));
  const rl = readline.createInterface({ input, output });

  try {
    while (true) {
      const line = await rl.question(kleur.blue().bold('You > '));
      const trimmed = line.trim();

      if (!trimmed) continue;
      if (trimmed.toLowerCase() === 'exit' || trimmed.toLowerCase() === 'quit') {
        console.log(kleur.cyan('\nGoodbye! 👋'));
        break;
      }

      await processQuestion(trimmed, db, provider);
    }
  } finally {
    rl.close();
    closeCentralDb();
  }
}

main().catch((err) => {
  console.error(kleur.red('Fatal error:'), err);
  closeCentralDb();
  process.exit(1);
});
