import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { routeInbound } from '../src/router.js';
import { 
  wakeContainer, 
  activeContainers, 
  type ContainerRuntimeDriver 
} from '../src/container-runner.js';
import { runPollCycle } from '../src/runner/poll-loop.js';
import { deliverSessionMessages } from '../src/delivery.js';
import { MockEchoProvider } from '../src/runner/providers/index.js';
import { registerChannelAdapter } from '../src/channels/registry.js';
import { 
  openInboundDb, 
  openOutboundDb, 
  readPendingInboundMessages 
} from '../src/mailbox/session-db.js';
import { inboundDbPath, outboundDbPath, sessionDir } from '../src/session-manager.js';
import { SCHEMA } from '../src/db/schema.js';
import { createAgentGroup } from '../src/db/agent-groups.js';
import { ensureMessagingGroup } from '../src/db/messaging-groups.js';
import { wireAgentToMessagingGroup } from '../src/db/wirings.js';
import { ensureUser, grantRole } from '../src/db/users.js';
import type { InboundEvent } from '../src/types.js';
import type { ContainerSpec } from '../src/container-runtime.js';

describe('Phase 7 - Step 4: Router Integration & Container E2E Round-Trip', () => {
  let centralDb: DatabaseSync;
  let mockDriver: ContainerRuntimeDriver;
  let spawnedSpecs: ContainerSpec[] = [];
  const agentGroupId = 'assistant';
  let createdSessionDirs: string[] = [];

  beforeEach(() => {
    spawnedSpecs = [];
    activeContainers.clear();

    mockDriver = {
      run: vi.fn().mockImplementation(async (spec: ContainerSpec) => {
        spawnedSpecs.push(spec);
        return `mock-cid-${spec.containerName}`;
      }),
      stop: vi.fn().mockResolvedValue(undefined),
      ps: vi.fn().mockResolvedValue([]),
      isDaemonRunning: vi.fn().mockResolvedValue(true)
    };

    centralDb = new DatabaseSync(':memory:');
    centralDb.exec('PRAGMA foreign_keys = ON;');
    centralDb.exec(SCHEMA);

    // Seed agent group, user, role, messaging group and wiring
    createAgentGroup(centralDb, { id: 'assistant', name: 'General Assistant', folder: 'assistant' });
    ensureUser(centralDb, { id: 'cli-user', kind: 'cli', display_name: 'Local User' });
    grantRole(centralDb, { user_id: 'cli-user', role: 'owner' });

    const chat = ensureMessagingGroup(centralDb, {
      id: 'cli:terminal-1',
      channel_type: 'cli',
      platform_id: 'terminal-1',
      unknown_sender_policy: 'public'
    });

    wireAgentToMessagingGroup(centralDb, {
      messaging_group_id: chat.id,
      agent_group_id: 'assistant',
      engage_mode: 'pattern',
      engage_pattern: '.'
    });
  });

  afterEach(() => {
    centralDb.close();
    activeContainers.clear();

    for (const dir of createdSessionDirs) {
      if (fs.existsSync(dir)) {
        try {
          fs.rmSync(dir, { recursive: true, force: true });
        } catch {}
      }
    }
    createdSessionDirs = [];
  });

  it('routes inbound event, fires onWake with sessionId and agentGroupId, and invokes wakeContainer', async () => {
    const event: InboundEvent = {
      channelType: 'cli',
      platformId: 'terminal-1',
      text: 'Hello from Step 4 Router integration',
      sender: { id: 'cli-user', displayName: 'Local User' }
    };

    const wakeCallback = vi.fn().mockImplementation(async (sessionId: string, group: string) => {
      await wakeContainer(group, sessionId, { driver: mockDriver });
    });

    const results = await routeInbound(event, centralDb, wakeCallback);

    expect(results.length).toBe(1);
    expect(results[0].status).toBe('routed');
    expect(results[0].agentGroupId).toBe('assistant');
    const sessionId = results[0].sessionId;
    createdSessionDirs.push(sessionDir(agentGroupId, sessionId));

    // Verify onWake was called with (sessionId, agentGroupId)
    expect(wakeCallback).toHaveBeenCalledWith(sessionId, 'assistant');

    // Verify wakeContainer was triggered and passed to driver
    expect(mockDriver.run).toHaveBeenCalledTimes(1);
    expect(spawnedSpecs.length).toBe(1);
    expect(spawnedSpecs[0].containerName).toBe(`protoclaw-assistant-${sessionId}`);
    expect(spawnedSpecs[0].sessionId).toBe(sessionId);
    expect(spawnedSpecs[0].agentGroupId).toBe('assistant');

    // Verify message landed in inbound.db with EVEN sequence parity (seq: 2)
    const inDb = openInboundDb(inboundDbPath(agentGroupId, sessionId));
    try {
      const pending = readPendingInboundMessages(inDb);
      expect(pending.length).toBe(1);
      expect(pending[0].seq).toBe(2);
      expect(pending[0].content).toBe('Hello from Step 4 Router integration');
    } finally {
      inDb.close();
    }
  });

  it('completes the full end-to-end round trip: Router -> wakeContainer -> Runner Poll Loop -> Delivery Engine', async () => {
    // Register test CLI adapter to verify host delivery
    const deliveredOutbound: string[] = [];
    registerChannelAdapter({
      channelType: 'cli',
      async deliver(message) {
        deliveredOutbound.push(message.content);
        return { platformMessageId: `cli-ack-${Date.now()}` };
      }
    });

    const event: InboundEvent = {
      channelType: 'cli',
      platformId: 'terminal-1',
      text: 'Calculate 25 + 75',
      sender: { id: 'cli-user', displayName: 'Local User' }
    };

    // 1. Host Ingress: Router routes and wakes container
    const results = await routeInbound(event, centralDb, async (sessionId, group) => {
      await wakeContainer(group, sessionId, { driver: mockDriver });
    });

    expect(results[0].status).toBe('routed');
    const sessionId = results[0].sessionId;
    createdSessionDirs.push(sessionDir(agentGroupId, sessionId));

    // 2. Container Execution: The runner poll loop runs inside the session
    const mockProvider = new MockEchoProvider({ prefix: 'Result: ' });
    const pollResult = await runPollCycle({
      agentGroupId,
      sessionId,
      provider: mockProvider
    });

    expect(pollResult.processed).toBe(1);

    // Verify outbound reply exists in outbound.db with ODD sequence parity (seq: 1)
    const outDb = openOutboundDb(outboundDbPath(agentGroupId, sessionId), true);
    try {
      const outRows = outDb.prepare('SELECT seq, content FROM messages_out;').all() as any[];
      expect(outRows.length).toBe(1);
      expect(outRows[0].seq).toBe(1); // Odd sequence number
      expect(outRows[0].content).toBe('Result: Calculate 25 + 75');
    } finally {
      outDb.close();
    }

    // 3. Host Delivery: Host delivery engine picks up outbound.db and marks delivered in inbound.db
    const deliveryResult = await deliverSessionMessages(agentGroupId, sessionId);
    expect(deliveryResult.delivered).toBe(1);
    expect(deliveredOutbound).toContain('Result: Calculate 25 + 75');

    // 4. Invariant Check: Delivered table in inbound.db holds the record (Single-Writer rule!)
    const inDb = openInboundDb(inboundDbPath(agentGroupId, sessionId));
    try {
      const deliveredRows = inDb.prepare('SELECT * FROM delivered;').all() as any[];
      expect(deliveredRows.length).toBe(1);
      expect(deliveredRows[0].status).toBe('delivered');
    } finally {
      inDb.close();
    }
  });
});
