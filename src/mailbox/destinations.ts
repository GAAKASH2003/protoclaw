/**
 * src/mailbox/destinations.ts
 * Destination catalog and synchronization for ProtoClaw Dual-DB Mailbox IPC.
 * 
 * Manages the `destinations` table in `inbound.db`:
 * - External channels: WhatsApp, Telegram, Discord, CLI.
 * - Peer agents: autonomous agents in other agent groups.
 */

import type { DatabaseSync } from 'node:sqlite';

export interface DestinationEntry {
  name: string;
  displayName?: string;
  type: 'channel' | 'agent';
  channelType?: string;
  platformId?: string;
  agentGroupId?: string;
}

/**
 * Idempotently updates or replaces the destination entries in a session's inbound.db.
 * Written exclusively by the Host (Single-Writer rule for inbound.db).
 */
export function syncDestinations(
  inDb: DatabaseSync,
  destinations: DestinationEntry[]
): void {
  inDb.exec('DELETE FROM destinations;');
  
  const stmt = inDb.prepare(`
    INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
    VALUES (?, ?, ?, ?, ?, ?);
  `);

  for (const d of destinations) {
    stmt.run(
      d.name,
      d.displayName ?? d.name,
      d.type,
      d.channelType ?? null,
      d.platformId ?? null,
      d.agentGroupId ?? null
    );
  }
}

/**
 * Reads all available destinations from a session's inbound.db.
 * May be called safely by either Host or Runner (read-only for Runner).
 */
export function readDestinations(inDb: DatabaseSync): DestinationEntry[] {
  const rows = inDb.prepare('SELECT * FROM destinations ORDER BY name ASC;').all() as any[];
  return rows.map((r) => ({
    name: r.name,
    displayName: r.display_name ?? r.name,
    type: r.type as 'channel' | 'agent',
    channelType: r.channel_type ?? undefined,
    platformId: r.platform_id ?? undefined,
    agentGroupId: r.agent_group_id ?? undefined
  }));
}

/**
 * Looks up a destination by name (case-insensitive).
 */
export function findDestinationByName(
  inDb: DatabaseSync,
  name: string
): DestinationEntry | undefined {
  const stmt = inDb.prepare('SELECT * FROM destinations WHERE LOWER(name) = LOWER(?) LIMIT 1;');
  const row = stmt.get(name) as any;
  if (!row) return undefined;
  return {
    name: row.name,
    displayName: row.display_name ?? row.name,
    type: row.type as 'channel' | 'agent',
    channelType: row.channel_type ?? undefined,
    platformId: row.platform_id ?? undefined,
    agentGroupId: row.agent_group_id ?? undefined
  };
}

/**
 * Generates Markdown documentation of available destinations for system prompt injection.
 */
export function formatDestinationsDocumentation(destinations: DestinationEntry[]): string {
  if (destinations.length === 0) {
    return 'No external destinations configured.';
  }

  const lines = [
    '## Addressable Destinations',
    'You can send messages to the following configured destinations using `send_message`:',
    ''
  ];

  for (const d of destinations) {
    if (d.type === 'channel') {
      lines.push(
        `- \`${d.name}\` (channel: ${d.channelType ?? 'generic'}${d.platformId ? `, platform_id: ${d.platformId}` : ''}) — ${d.displayName ?? d.name}`
      );
    } else {
      lines.push(
        `- \`${d.name}\` (agent: ${d.agentGroupId ?? d.name}) — Peer Agent: ${d.displayName ?? d.name}`
      );
    }
  }

  lines.push('');
  lines.push('When using `send_message`, always use the exact destination name listed above in the `to` field.');

  return lines.join('\n');
}

/**
 * Discovers available destinations from the central SQLite relational DB (protoclaw.db):
 * - Messaging groups (external channels)
 * - Other agent groups (peer agents)
 */
export function resolveDestinationsFromCentralDb(
  centralDb: DatabaseSync,
  currentAgentGroupId?: string
): DestinationEntry[] {
  const destinations: DestinationEntry[] = [];

  // 1. Gather messaging groups
  try {
    const messagingGroups = centralDb.prepare('SELECT * FROM messaging_groups;').all() as any[];
    for (const mg of messagingGroups) {
      destinations.push({
        name: mg.name || `${mg.channel_type}-${mg.platform_id}`,
        displayName: mg.name || `${mg.channel_type} Channel (${mg.platform_id})`,
        type: 'channel',
        channelType: mg.channel_type,
        platformId: mg.platform_id
      });
    }
  } catch {
    // If table doesn't exist yet, ignore
  }

  // 2. Gather peer agent groups
  try {
    const agentGroups = centralDb.prepare('SELECT * FROM agent_groups;').all() as any[];
    for (const ag of agentGroups) {
      if (currentAgentGroupId && ag.id === currentAgentGroupId) {
        continue; // Exclude self
      }
      destinations.push({
        name: ag.id,
        displayName: ag.name || ag.id,
        type: 'agent',
        agentGroupId: ag.id
      });
    }
  } catch {
    // If table doesn't exist yet, ignore
  }

  return destinations;
}
