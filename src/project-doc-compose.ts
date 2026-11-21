/**
 * src/project-doc-compose.ts
 * Project Document & System Instructions Composer for ProtoClaw.
 * 
 * Assembles modular standing instructions for an agent group:
 * 1. Base Core Persona & Dual-DB IPC operational rules.
 * 2. Sandboxed workspace paths & boundaries.
 * 3. Group-specific standing instructions (AGENT.md).
 * 4. Available tool specifications & usage guidance.
 */

import fs from 'node:fs';
import path from 'node:path';

export interface ComposeOptions {
  /** Override the default base persona and rules */
  baseInstructions?: string;
  /** Documentation for available workspace tools */
  toolsDocumentation?: string;
  /** Additional custom instruction sections */
  customSections?: Array<{ name: string; body: string }>;
}

export interface GroupPaths {
  baseGroupsDir: string;
  groupDir: string;
  workspaceDir: string;
  agentMdPath: string;
}

export const DEFAULT_BASE_INSTRUCTIONS = `# ProtoClaw Autonomous Agent

You are ProtoClaw, an autonomous, highly reliable AI agent operating on the Dual-DB Mailbox IPC architecture.

## Core Operational Invariants
- Dual-DB Mailbox Engine: You communicate through host-managed inbound and outbound SQLite mailboxes.
- High Reliability: You think systematically, reason carefully, and give concise, high-impact responses.
- Sandbox Integrity: All file reading, writing, and script executions MUST operate strictly inside your designated workspace directory. Never attempt to read or modify files outside your workspace boundary.`;

export function getDefaultAgentMd(agentGroupId: string): string {
  return `# Agent Instructions (${agentGroupId})

## Role & Objectives
You are the primary assistant for the "${agentGroupId}" agent group.

## Guidelines
- Follow standard software engineering best practices.
- Prefer Node.js 22 modern standards (native ESM, native fetch, node:sqlite).
- Before creating or modifying files, check existing workspace files to maintain consistency.
- Be concise, direct, and actionable in your responses.`;
}

/**
 * Resolves all key filesystem paths for a given agent group.
 */
export function getGroupPaths(agentGroupId: string): GroupPaths {
  const baseGroupsDir = path.resolve(process.cwd(), 'groups');
  const groupDir = path.join(baseGroupsDir, agentGroupId);
  const workspaceDir = path.join(groupDir, 'workspace');
  
  // Primary instructions file is AGENT.md (with fallback to agent.md or legacy CLAUDE.md)
  let agentMdPath = path.join(groupDir, 'AGENT.md');
  if (!fs.existsSync(agentMdPath)) {
    const lowercase = path.join(groupDir, 'agent.md');
    const legacy = path.join(groupDir, 'CLAUDE.md');
    if (fs.existsSync(lowercase)) {
      agentMdPath = lowercase;
    } else if (fs.existsSync(legacy)) {
      agentMdPath = legacy;
    }
  }

  return { baseGroupsDir, groupDir, workspaceDir, agentMdPath };
}

/**
 * Ensures the group directory structure and AGENT.md instructions exist on disk.
 */
export function ensureGroupWorkspace(agentGroupId: string): GroupPaths {
  const paths = getGroupPaths(agentGroupId);

  if (!fs.existsSync(paths.groupDir)) {
    fs.mkdirSync(paths.groupDir, { recursive: true });
  }
  if (!fs.existsSync(paths.workspaceDir)) {
    fs.mkdirSync(paths.workspaceDir, { recursive: true });
  }
  if (!fs.existsSync(paths.agentMdPath)) {
    fs.writeFileSync(paths.agentMdPath, getDefaultAgentMd(agentGroupId), 'utf-8');
  }

  return paths;
}

/**
 * Composes the comprehensive system prompt for an agent group by merging:
 * 1. Base Core Persona
 * 2. Sandboxed Workspace Path & Boundaries
 * 3. Group Standing Instructions (AGENT.md)
 * 4. Available Tools Documentation
 */
export function composeProjectInstructions(
  agentGroupId: string,
  options: ComposeOptions = {}
): string {
  const paths = ensureGroupWorkspace(agentGroupId);

  let groupInstructions = '';
  if (fs.existsSync(paths.agentMdPath)) {
    groupInstructions = fs.readFileSync(paths.agentMdPath, 'utf-8').trim();
  }

  const sections: string[] = [];

  // 1. Base Core Persona
  sections.push(options.baseInstructions || DEFAULT_BASE_INSTRUCTIONS);

  // 2. Sandboxed Workspace Environment & Boundary Rule
  sections.push(`## Workspace Environment
Your sandboxed working directory is located at:
\`${paths.workspaceDir}\`
All workspace files, scripts, and command executions MUST operate strictly within this workspace directory.
Never attempt to access, read, or modify parent files outside this workspace.`);

  // 3. Group Standing Instructions (AGENT.md)
  if (groupInstructions) {
    sections.push(`## Group Standing Instructions (AGENT.md)
${groupInstructions}`);
  }

  // 4. Tools Documentation
  if (options.toolsDocumentation) {
    sections.push(`## Available Tools
${options.toolsDocumentation}`);
  }

  // 5. Custom Sections
  if (options.customSections && options.customSections.length > 0) {
    for (const section of options.customSections) {
      sections.push(`## ${section.name}
${section.body}`);
    }
  }

  return sections.join('\n\n');
}
