import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { 
  syncDestinations, 
  readDestinations, 
  findDestinationByName, 
  formatDestinationsDocumentation,
  resolveDestinationsFromCentralDb,
  type DestinationEntry 
} from '../src/mailbox/destinations.js';
import { executeSendMessage, SEND_MESSAGE_TOOL } from '../src/tools/message.js';
import { executeWorkspaceTool } from '../src/tools/workspace.js';
import { runPollCycle } from '../src/runner/poll-loop.js';
import type { AgentProvider } from '../src/runner/providers/types.js';
import { 
  provisionSessionStorage, 
  sessionDir, 
  inboundDbPath, 
  outboundDbPath 
} from '../src/session-manager.js';
import { 
  openInboundDb, 
  openOutboundDb, 
  writeMessageIn,
  ensureSchema 
} from '../src/mailbox/session-db.js';

describe('Phase 8 - Step 4: Destination Routing & send_message Tool', () => {
  const testWorkspaceDir = path.resolve(process.cwd(), 'temp-destinations-workspace');
  let testDbFile: string;

  beforeEach(() => {
    if (!fs.existsSync(testWorkspaceDir)) {
      fs.mkdirSync(testWorkspaceDir, { recursive: true });
    }
    testDbFile = path.resolve(process.cwd(), `temp-inbound-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    ensureSchema(testDbFile, 'inbound');
  });

  afterEach(() => {
    if (fs.existsSync(testWorkspaceDir)) {
      try {
        fs.rmSync(testWorkspaceDir, { recursive: true, force: true });
      } catch {}
    }
    if (fs.existsSync(testDbFile)) {
      try {
        fs.rmSync(testDbFile, { force: true });
      } catch {}
    }
  });

  describe('Destination Mailbox Operations', () => {
    it('syncs, reads, and finds destinations in inbound.db', () => {
      const inDb = openInboundDb(testDbFile);
      try {
        const entries: DestinationEntry[] = [
          {
            name: 'alerts',
            displayName: 'Ops Telegram Alerts',
            type: 'channel',
            channelType: 'telegram',
            platformId: 'tg-12345'
          },
          {
            name: 'researcher',
            displayName: 'Specialist Research Agent',
            type: 'agent',
            agentGroupId: 'research-agent'
          }
        ];

        syncDestinations(inDb, entries);

        const loaded = readDestinations(inDb);
        expect(loaded.length).toBe(2);
        expect(loaded[0].name).toBe('alerts');
        expect(loaded[0].type).toBe('channel');
        expect(loaded[0].channelType).toBe('telegram');
        expect(loaded[0].platformId).toBe('tg-12345');

        expect(loaded[1].name).toBe('researcher');
        expect(loaded[1].type).toBe('agent');
        expect(loaded[1].agentGroupId).toBe('research-agent');

        // Case-insensitive lookup
        const found = findDestinationByName(inDb, 'ALERTS');
        expect(found).toBeDefined();
        expect(found?.name).toBe('alerts');
        expect(found?.platformId).toBe('tg-12345');

        expect(findDestinationByName(inDb, 'non-existent')).toBeUndefined();
      } finally {
        inDb.close();
      }
    });

    it('formats addressable destinations as Markdown for system prompt', () => {
      const entries: DestinationEntry[] = [
        {
          name: 'ops-alerts',
          displayName: 'Ops Alerts Room',
          type: 'channel',
          channelType: 'telegram',
          platformId: 'chat-99'
        },
        {
          name: 'coder',
          displayName: 'Backend Code Writer',
          type: 'agent',
          agentGroupId: 'coder-group'
        }
      ];

      const doc = formatDestinationsDocumentation(entries);
      expect(doc).toContain('## Addressable Destinations');
      expect(doc).toContain('`ops-alerts` (channel: telegram, platform_id: chat-99) — Ops Alerts Room');
      expect(doc).toContain('`coder` (agent: coder-group) — Peer Agent: Backend Code Writer');
      expect(doc).toContain('send_message');
    });

    it('resolves destinations dynamically from central relational database', () => {
      const centralDb = new DatabaseSync(':memory:');
      centralDb.exec(`
        CREATE TABLE messaging_groups (
          id TEXT PRIMARY KEY,
          channel_type TEXT NOT NULL,
          platform_id TEXT NOT NULL,
          name TEXT
        );
        CREATE TABLE agent_groups (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL
        );
      `);

      centralDb.prepare(`
        INSERT INTO messaging_groups (id, channel_type, platform_id, name)
        VALUES ('mg-1', 'discord', 'channel-456', 'Discord General');
      `).run();

      centralDb.prepare(`
        INSERT INTO agent_groups (id, name)
        VALUES ('assistant', 'Main Assistant'), ('researcher', 'Research Specialist');
      `).run();

      const destinations = resolveDestinationsFromCentralDb(centralDb, 'assistant');
      expect(destinations.length).toBe(2);

      const channelDest = destinations.find((d) => d.type === 'channel');
      expect(channelDest).toBeDefined();
      expect(channelDest?.channelType).toBe('discord');
      expect(channelDest?.platformId).toBe('channel-456');

      // Peer agent excludes self ('assistant')
      const agentDest = destinations.find((d) => d.type === 'agent');
      expect(agentDest).toBeDefined();
      expect(agentDest?.name).toBe('researcher');
      expect(agentDest?.agentGroupId).toBe('researcher');

      centralDb.close();
    });
  });

  describe('executeSendMessage Tool', () => {
    let outDbFile: string;

    beforeEach(() => {
      outDbFile = path.resolve(process.cwd(), `temp-outbound-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
      ensureSchema(outDbFile, 'outbound');
    });

    afterEach(() => {
      if (fs.existsSync(outDbFile)) {
        try {
          fs.rmSync(outDbFile, { force: true });
        } catch {}
      }
    });

    it('dispatches to an external channel via outbound.db', async () => {
      const outDb = openOutboundDb(outDbFile, false);
      const destinations: DestinationEntry[] = [
        {
          name: 'telegram-alerts',
          displayName: 'Telegram Alerts',
          type: 'channel',
          channelType: 'telegram',
          platformId: 'chat-111'
        }
      ];

      try {
        const result = await executeSendMessage(
          { to: 'telegram-alerts', content: 'Server health check passed.' },
          { destinations, outDb, inReplyTo: 'msg-in-1' }
        );

        expect(result.success).toBe(true);
        expect(result.destination).toBe('telegram-alerts');
        expect(result.type).toBe('channel');

        // Verify message was written to outbound.db with odd sequence parity
        const outRows = outDb.prepare('SELECT * FROM messages_out;').all() as any[];
        expect(outRows.length).toBe(1);
        expect(outRows[0].seq).toBe(1);
        expect(outRows[0].in_reply_to).toBe('msg-in-1');
        expect(outRows[0].content).toBe('Server health check passed.');
        expect(outRows[0].channel_type).toBe('telegram');
        expect(outRows[0].platform_id).toBe('chat-111');
      } finally {
        outDb.close();
      }
    });

    it('routes to a peer agent via onAgentMessage callback', async () => {
      const onAgentMessage = vi.fn().mockResolvedValue(undefined);
      const destinations: DestinationEntry[] = [
        {
          name: 'researcher',
          displayName: 'Research Agent',
          type: 'agent',
          agentGroupId: 'research-agent'
        }
      ];

      const result = await executeSendMessage(
        { to: 'researcher', content: 'Please summarize recent papers on LLM agents.' },
        { destinations, onAgentMessage }
      );

      expect(result.success).toBe(true);
      expect(result.destination).toBe('researcher');
      expect(result.type).toBe('agent');
      expect(onAgentMessage).toHaveBeenCalledWith(
        'research-agent',
        'Please summarize recent papers on LLM agents.'
      );
    });

    it('throws clear error on unknown destination with available suggestions', async () => {
      const destinations: DestinationEntry[] = [
        { name: 'alerts', type: 'channel', channelType: 'cli' }
      ];

      await expect(
        executeSendMessage({ to: 'unknown-dest', content: 'Hello' }, { destinations })
      ).rejects.toThrow('Unknown destination: "unknown-dest". Available destinations: "alerts".');
    });

    it('executes send_message through unified executeWorkspaceTool dispatcher', async () => {
      const outDb = openOutboundDb(outDbFile, false);
      const destinations: DestinationEntry[] = [
        { name: 'cli-main', type: 'channel', channelType: 'cli', platformId: 'term' }
      ];

      try {
        const result = await executeWorkspaceTool(
          testWorkspaceDir,
          'send_message',
          { to: 'cli-main', content: 'Broadcast via dispatcher' },
          { destinations, outDb }
        );

        expect(result.success).toBe(true);
        expect(result.destination).toBe('cli-main');

        const outRows = outDb.prepare('SELECT * FROM messages_out;').all() as any[];
        expect(outRows.length).toBe(1);
        expect(outRows[0].content).toBe('Broadcast via dispatcher');
      } finally {
        outDb.close();
      }
    });
  });

  describe('Integration with Poll Loop', () => {
    const agentGroupId = 'send-msg-agent';
    let currentSessionId: string;
    let currentSessionDir: string;

    beforeEach(() => {
      currentSessionId = `test-send-msg-${Date.now()}`;
      currentSessionDir = sessionDir(agentGroupId, currentSessionId);
      provisionSessionStorage(agentGroupId, currentSessionId);
    });

    afterEach(() => {
      if (fs.existsSync(currentSessionDir)) {
        try {
          fs.rmSync(currentSessionDir, { recursive: true, force: true });
        } catch {}
      }
      const groupDir = path.resolve(process.cwd(), 'groups', agentGroupId);
      if (fs.existsSync(groupDir)) {
        try {
          fs.rmSync(groupDir, { recursive: true, force: true });
        } catch {}
      }
    });

    it('agent sends a notification mid-turn via send_message and returns final answer', async () => {
      const inPath = inboundDbPath(agentGroupId, currentSessionId);
      const outPath = outboundDbPath(agentGroupId, currentSessionId);

      // Pre-populate inbound.db with destination 'ops-channel'
      const inDb = openInboundDb(inPath);
      let inMsg;
      try {
        syncDestinations(inDb, [
          {
            name: 'ops-channel',
            displayName: 'Operations Slack/Discord Room',
            type: 'channel',
            channelType: 'discord',
            platformId: 'channel-999'
          }
        ]);

        inMsg = writeMessageIn(inDb, {
          content: 'Notify ops that deployment is starting, then reply to me.',
          kind: 'message',
          channel_type: 'cli',
          platform_id: 'terminal-1',
          thread_id: 'th-1'
        });
      } finally {
        inDb.close();
      }

      let step = 0;
      const notifyingAgent: AgentProvider = {
        name: 'notifying-agent',
        query: vi.fn().mockImplementation(async (prompt: string, context) => {
          step++;
          if (step === 1) {
            // Verify destination documentation was automatically injected into system prompt
            expect(context?.systemPrompt).toContain('ops-channel');
            expect(context?.systemPrompt).toContain('## Addressable Destinations');

            // Agent calls send_message tool
            return `\`\`\`tool_call\n{"name": "send_message", "args": {"to": "ops-channel", "content": "Alert: Deployment is starting now!"}}\n\`\`\``;
          }
          // Step 2: Agent gives final response to user
          expect(prompt).toContain('[Tool Output for send_message]');
          return 'I have notified the ops channel and the deployment is underway.';
        })
      };

      const result = await runPollCycle({
        agentGroupId,
        sessionId: currentSessionId,
        provider: notifyingAgent
      });

      expect(result.processed).toBe(1);

      // Verify outbound messages in outbound.db:
      // 1. First message: odd-seq mid-turn notification to discord channel-999
      // 2. Second message: odd-seq final reply to cli terminal-1
      const outDb = openOutboundDb(outPath, false);
      try {
        const outRows = outDb.prepare('SELECT seq, channel_type, platform_id, content FROM messages_out ORDER BY seq ASC;').all() as any[];
        expect(outRows.length).toBe(2);

        // First message: send_message tool dispatch (seq: 1)
        expect(outRows[0].seq).toBe(1);
        expect(outRows[0].channel_type).toBe('discord');
        expect(outRows[0].platform_id).toBe('channel-999');
        expect(outRows[0].content).toBe('Alert: Deployment is starting now!');

        // Second message: final response to the user's CLI session (seq: 3)
        expect(outRows[1].seq).toBe(3);
        expect(outRows[1].channel_type).toBe('cli');
        expect(outRows[1].platform_id).toBe('terminal-1');
        expect(outRows[1].content).toBe('I have notified the ops channel and the deployment is underway.');
      } finally {
        outDb.close();
      }
    });
  });
});
