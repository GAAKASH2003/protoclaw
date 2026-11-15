/**
 * scripts/discord.ts
 * Standalone Discord Bot Runner for ProtoClaw.
 * 
 * Usage:
 *   pnpm run discord
 * 
 * Requires:
 *   DISCORD_BOT_TOKEN in .env (from Discord Developer Portal)
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
import { DiscordChannelAdapter } from '../src/channels/discord.js';
import { CliChannelAdapter } from '../src/channels/cli.js';
import { registerChannelAdapter } from '../src/channels/registry.js';
import { resolveOrCreateSession } from '../src/session-manager.js';

async function main() {
  console.log(kleur.cyan().bold('═══════════════════════════════════════════════════════════'));
  console.log(kleur.cyan().bold('             🎮 ProtoClaw - Discord Bot Runner             '));
  console.log(kleur.cyan().bold('═══════════════════════════════════════════════════════════'));

  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) {
    console.error(
      kleur.red('❌ Error: DISCORD_BOT_TOKEN is missing.\n') +
        kleur.yellow('Please set DISCORD_BOT_TOKEN in your protoclaw/.env file.\n') +
        kleur.gray('You can create a bot token at https://discord.com/developers/applications')
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

  // 2. Register Discord and fallback silent CLI channel adapters
  const discordAdapter = new DiscordChannelAdapter({
    botToken: token,
    botUserId: process.env.DISCORD_CLIENT_ID
  });
  registerChannelAdapter(discordAdapter);
  registerChannelAdapter(new CliChannelAdapter({ silent: true }));
  console.log(kleur.green('✓ Discord Channel Adapter registered.'));

  // 3. Ensure Discord messaging group & wiring
  ensureMessagingGroup(db, {
    id: 'discord:shared',
    channel_type: 'discord',
    platform_id: 'shared',
    unknown_sender_policy: 'public'
  });

  wireAgentToMessagingGroup(db, {
    messaging_group_id: 'discord:shared',
    agent_group_id: 'assistant',
    engage_mode: 'pattern',
    engage_pattern: '.',
    session_mode: 'shared'
  });

  const { session } = await resolveOrCreateSession(
    db,
    'assistant',
    'discord:shared',
    null,
    'shared',
    { channelType: 'discord', platformId: 'shared' }
  );

  console.log(kleur.gray(`✓ Active Session: ${session.id}`));

  const activeSessions = new Set<string>();
  activeSessions.add(session.id);

  const controller = new AbortController();

  // Handle graceful shutdown
  const shutdown = () => {
    console.log(kleur.yellow('\nShutting down Discord bot runner...'));
    controller.abort();
    closeCentralDb();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // 4. Background Delivery & Processing Loop
  const loopInterval = 500;
  (async () => {
    while (!controller.signal.aborted) {
      for (const sessId of activeSessions) {
        try {
          const res = await runPollCycle({
            agentGroupId: 'assistant',
            sessionId: sessId,
            provider,
            systemPrompt: 'You are ProtoClaw, an intelligent and helpful AI assistant on Discord.'
          });

          if (res.processed > 0) {
            await deliverSessionMessages('assistant', sessId);
          }
        } catch (err: any) {
          // Keep loop running on transient errors
        }
      }

      if (controller.signal.aborted) break;
      await new Promise((resolve) => setTimeout(resolve, loopInterval));
    }
  })();

  console.log(kleur.green('✓ Host Delivery Engine & Runner Loop active (500ms ticks).'));

  // 5. Connect Gateway WebSocket for real-time Discord messages
  console.log(kleur.yellow('Connecting to Discord Gateway WebSocket...'));

  discordAdapter.connectGateway({
    db,
    token,
    signal: controller.signal,
    onEventRouted: (event) => {
      console.log(
        kleur.blue(`[Discord Inbound] `) +
          kleur.bold(`${event.sender.displayName} (channel ${event.platformId}): `) +
          event.text
      );
    },
    onWake: (sessId) => {
      activeSessions.add(sessId);
      // Process and deliver immediately on wake
      runPollCycle({
        agentGroupId: 'assistant',
        sessionId: sessId,
        provider,
        systemPrompt: 'You are ProtoBot, an intelligent and helpful AI assistant on Discord.'
      })
        .then(() => deliverSessionMessages('assistant', sessId))
        .catch((err) => console.error(kleur.red('[wake cycle error]:'), err));
    }
  });

  console.log(kleur.green('✓ Connected to Discord Gateway. Listening for messages!'));
  console.log(kleur.gray('\nPress Ctrl+C to stop.\n'));
}

main().catch((err) => {
  console.error(kleur.red('Fatal error:'), err);
  closeCentralDb();
  process.exit(1);
});
