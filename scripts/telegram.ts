/**
 * scripts/telegram.ts
 * Standalone Telegram Bot Runner for ProtoClaw.
 * 
 * Usage:
 *   pnpm run telegram
 * 
 * Requires:
 *   TELEGRAM_BOT_TOKEN in .env (get one from @BotFather on Telegram)
 *   GEMINI_API_KEY in .env (or OPENROUTER_API_KEY)
 */

import kleur from 'kleur';
import { getCentralDb, closeCentralDb } from '../src/db/connection.js';
import { createAgentGroup, getAgentGroup } from '../src/db/agent-groups.js';
import { ensureMessagingGroup } from '../src/db/messaging-groups.js';
import { wireAgentToMessagingGroup } from '../src/db/wirings.js';
import { createDefaultProvider } from '../src/runner/providers/index.js';
import { runPollCycle } from '../src/runner/poll-loop.js';
import { deliverSessionMessages } from '../src/delivery.js';
import { TelegramChannelAdapter } from '../src/channels/telegram.js';
import { CliChannelAdapter } from '../src/channels/cli.js';
import { registerChannelAdapter } from '../src/channels/registry.js';
import { resolveOrCreateSession } from '../src/session-manager.js';

async function main() {
  console.log(kleur.cyan().bold('═══════════════════════════════════════════════════════════'));
  console.log(kleur.cyan().bold('           ✈️ ProtoClaw - Telegram Bot Runner             '));
  console.log(kleur.cyan().bold('═══════════════════════════════════════════════════════════'));

  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.error(
      kleur.red('❌ Error: TELEGRAM_BOT_TOKEN is missing.\n') +
        kleur.yellow('Please set TELEGRAM_BOT_TOKEN in your protoclaw/.env file.\n') +
        kleur.gray('You can get a free token by messaging @BotFather on Telegram.')
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

  // 2. Register Telegram and fallback CLI channel adapters
  const telegramAdapter = new TelegramChannelAdapter({
    botToken: token,
    botUsername: process.env.TELEGRAM_BOT_USERNAME
  });
  registerChannelAdapter(telegramAdapter);

  // Register silent CLI adapter so any legacy CLI messages in the session are gracefully delivered
  registerChannelAdapter(new CliChannelAdapter({ silent: true }));
  console.log(kleur.green('✓ Telegram Channel Adapter registered.'));

  // 3. Ensure Telegram messaging group & wiring
  ensureMessagingGroup(db, {
    id: 'telegram:shared',
    channel_type: 'telegram',
    platform_id: 'shared',
    unknown_sender_policy: 'public'
  });

  wireAgentToMessagingGroup(db, {
    messaging_group_id: 'telegram:shared',
    agent_group_id: 'assistant',
    engage_mode: 'pattern',
    engage_pattern: '.',
    session_mode: 'shared'
  });

  const { session } = await resolveOrCreateSession(
    db,
    'assistant',
    'telegram:shared',
    null,
    'shared',
    { channelType: 'telegram', platformId: 'shared' }
  );

  console.log(kleur.gray(`✓ Active Session: ${session.id}`));

  const activeSessions = new Set<string>();
  activeSessions.add(session.id);

  const controller = new AbortController();

  // Handle graceful shutdown
  const shutdown = () => {
    console.log(kleur.yellow('\nShutting down Telegram bot runner...'));
    controller.abort();
    closeCentralDb();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // 4. Background Poll & Delivery Loop over all active sessions
  const loopInterval = 500;
  (async () => {
    while (!controller.signal.aborted) {
      for (const sessId of activeSessions) {
        try {
          const res = await runPollCycle({
            agentGroupId: 'assistant',
            sessionId: sessId,
            provider,
            systemPrompt: 'You are ProtoClaw, a helpful and intelligent AI assistant.'
          });

          if (res.processed > 0) {
            await deliverSessionMessages('assistant', sessId);
          }
        } catch (err) {
          // Keep loop running on transient errors
        }
      }
      if (controller.signal.aborted) break;
      await new Promise((r) => setTimeout(r, loopInterval));
    }
  })();

  console.log(kleur.green('✓ Host Delivery Engine & Runner Loop active.'));
  console.log(kleur.cyan('\n🚀 Listening for Telegram messages (long polling)...'));
  console.log(kleur.gray('Send a message to your bot on Telegram! Press Ctrl+C to stop.\n'));

  // 5. Start Telegram Inbound Polling
  await telegramAdapter.startPolling({
    db,
    signal: controller.signal,
    onEventRouted: (event) => {
      console.log(
        kleur.blue(`[Telegram Inbound] `) +
          kleur.bold(`${event.sender.displayName}: `) +
          event.text
      );
    },
    onWake: (sessId) => {
      activeSessions.add(sessId);
      // Run poll cycle & delivery immediately on wake
      runPollCycle({
        agentGroupId: 'assistant',
        sessionId: sessId,
        provider,
        systemPrompt: 'You are ProtoClaw, a helpful and intelligent AI assistant.'
      })
        .then(() => deliverSessionMessages('assistant', sessId))
        .catch((e) => console.error(kleur.red('[runner error]'), e));
    }
  });
}

main().catch((err) => {
  console.error(kleur.red('Fatal error:'), err);
  closeCentralDb();
  process.exit(1);
});
