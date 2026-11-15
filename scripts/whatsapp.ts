/**
 * scripts/whatsapp.ts
 * Standalone WhatsApp Cloud API Bot Runner for ProtoClaw.
 * 
 * Usage:
 *   pnpm run whatsapp
 * 
 * Requires:
 *   WHATSAPP_TOKEN, WHATSAPP_PHONE_NUMBER_ID in .env
 */

import kleur from 'kleur';
import { getCentralDb, closeCentralDb } from '../src/db/connection.js';
import { createAgentGroup, getAgentGroup } from '../src/db/agent-groups.js';
import { ensureMessagingGroup } from '../src/db/messaging-groups.js';
import { wireAgentToMessagingGroup } from '../src/db/wirings.js';
import { createDefaultProvider } from '../src/runner/providers/index.js';
import { runPollCycle } from '../src/runner/poll-loop.js';
import { deliverSessionMessages } from '../src/delivery.js';
import { WhatsAppChannelAdapter } from '../src/channels/whatsapp.js';
import { registerChannelAdapter } from '../src/channels/registry.js';
import { resolveOrCreateSession } from '../src/session-manager.js';

async function main() {
  console.log(kleur.cyan().bold('═══════════════════════════════════════════════════════════'));
  console.log(kleur.cyan().bold('          💬 ProtoClaw - WhatsApp Cloud API Bot            '));
  console.log(kleur.cyan().bold('═══════════════════════════════════════════════════════════'));

  const token = process.env.WHATSAPP_TOKEN;
  const phoneId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const port = Number(process.env.WHATSAPP_WEBHOOK_PORT || 3000);
  const verifyToken = process.env.WHATSAPP_VERIFY_TOKEN || 'protoclaw_secret_123';

  if (!token || !phoneId) {
    console.error(
      kleur.red('❌ Error: WHATSAPP_TOKEN or WHATSAPP_PHONE_NUMBER_ID is missing.\n') +
        kleur.yellow('Please set them in your protoclaw/.env file.')
    );
    process.exit(1);
  }

  const db = getCentralDb();
  const provider = createDefaultProvider();
  console.log(kleur.green(`✓ Active AI Provider: ${provider.name}`));

  // 1. Ensure assistant agent group
  if (!getAgentGroup(db, 'assistant')) {
    createAgentGroup(db, {
      id: 'assistant',
      name: 'ProtoClaw Assistant',
      folder: 'assistant',
      agent_provider: provider.name
    });
  }

  // 2. Register WhatsApp Channel Adapter
  const whatsappAdapter = new WhatsAppChannelAdapter({
    accessToken: token,
    phoneNumberId: phoneId,
    verifyToken
  });
  registerChannelAdapter(whatsappAdapter);
  console.log(kleur.green('✓ WhatsApp Channel Adapter registered.'));

  // 3. Ensure WhatsApp default messaging group
  ensureMessagingGroup(db, {
    id: 'whatsapp:shared',
    channel_type: 'whatsapp',
    platform_id: 'shared',
    unknown_sender_policy: 'public'
  });

  wireAgentToMessagingGroup(db, {
    messaging_group_id: 'whatsapp:shared',
    agent_group_id: 'assistant',
    engage_mode: 'pattern',
    engage_pattern: '.',
    session_mode: 'shared'
  });

  const { session } = await resolveOrCreateSession(
    db,
    'assistant',
    'whatsapp:shared',
    null,
    'shared',
    { channelType: 'whatsapp', platformId: 'shared' }
  );

  console.log(kleur.gray(`✓ Active Session: ${session.id}`));

  const activeSessions = new Set<string>();
  activeSessions.add(session.id);

  const controller = new AbortController();

  // 4. Background Poll & Delivery Loop
  const loopInterval = 500;
  (async () => {
    while (!controller.signal.aborted) {
      for (const sessId of activeSessions) {
        try {
          const res = await runPollCycle({
            agentGroupId: 'assistant',
            sessionId: sessId,
            provider,
            systemPrompt: 'You are ProtoClaw, a helpful AI assistant reachable via WhatsApp.'
          });

          if (res.processed > 0) {
            await deliverSessionMessages('assistant', sessId);
          }
        } catch (err) {}
      }
      if (controller.signal.aborted) break;
      await new Promise((r) => setTimeout(r, loopInterval));
    }
  })();

  console.log(kleur.green('✓ Host Delivery Engine & Runner Loop active.'));

  // 5. Start HTTP Webhook Server
  const server = whatsappAdapter.startWebhookServer({
    port,
    db,
    onEventRouted: (event) => {
      console.log(
        kleur.blue(`[WhatsApp Inbound] `) +
          kleur.bold(`${event.sender.displayName} (${event.platformId}): `) +
          event.text
      );
    },
    onWake: (sessId) => {
      activeSessions.add(sessId);
      runPollCycle({
        agentGroupId: 'assistant',
        sessionId: sessId,
        provider,
        systemPrompt: 'You are ProtoClaw, a helpful AI assistant reachable via WhatsApp.'
      })
        .then(() => deliverSessionMessages('assistant', sessId))
        .catch((e) => console.error(kleur.red('[runner error]'), e));
    }
  });

  console.log(kleur.green(`✓ Webhook Server listening on port ${port}`));
  console.log(kleur.cyan(`\n🔗 Webhook endpoint: http://localhost:${port}/webhook`));
  console.log(kleur.gray(`  Verify Token: "${verifyToken}"`));
  console.log(kleur.gray('\nPress Ctrl+C to stop.\n'));

  const shutdown = () => {
    console.log(kleur.yellow('\nShutting down WhatsApp bot runner...'));
    controller.abort();
    server.close();
    closeCentralDb();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error(kleur.red('Fatal error:'), err);
  closeCentralDb();
  process.exit(1);
});

