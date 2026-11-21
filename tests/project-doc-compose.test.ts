import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { 
  getGroupPaths, 
  ensureGroupWorkspace, 
  composeProjectInstructions 
} from '../src/project-doc-compose.js';

describe('Phase 8 - Step 1: Project Document & Instructions Composer (AGENT.md)', () => {
  const testGroupId = `test-group-${Date.now()}`;
  const testGroupDir = path.resolve(process.cwd(), 'groups', testGroupId);

  afterEach(() => {
    if (fs.existsSync(testGroupDir)) {
      try {
        fs.rmSync(testGroupDir, { recursive: true, force: true });
      } catch {}
    }
  });

  it('resolves correct group paths', () => {
    const paths = getGroupPaths('engineering');
    expect(paths.groupDir).toContain('groups');
    expect(paths.groupDir).toContain('engineering');
    expect(paths.workspaceDir).toBe(path.join(paths.groupDir, 'workspace'));
    expect(paths.agentMdPath).toBe(path.join(paths.groupDir, 'AGENT.md'));
  });

  it('automatically provisions group folder, workspace folder, and default AGENT.md', () => {
    expect(fs.existsSync(testGroupDir)).toBe(false);

    const paths = ensureGroupWorkspace(testGroupId);

    expect(fs.existsSync(paths.groupDir)).toBe(true);
    expect(fs.existsSync(paths.workspaceDir)).toBe(true);
    expect(fs.existsSync(paths.agentMdPath)).toBe(true);

    const content = fs.readFileSync(paths.agentMdPath, 'utf-8');
    expect(content).toContain(`Agent Instructions (${testGroupId})`);
    expect(content).toContain('Node.js 22 modern standards');
  });

  it('composes full instructions including persona, workspace path, and AGENT.md', () => {
    const paths = ensureGroupWorkspace(testGroupId);
    
    // Customize AGENT.md
    fs.writeFileSync(
      paths.agentMdPath,
      '# Custom Engineering Guidelines\n- All code must have 100% test coverage.',
      'utf-8'
    );

    const instructions = composeProjectInstructions(testGroupId);

    // 1. Contains Core Persona
    expect(instructions).toContain('# ProtoClaw Autonomous Agent');
    expect(instructions).toContain('Dual-DB Mailbox IPC architecture');

    // 2. Contains Workspace Path Boundary Rule
    expect(instructions).toContain('## Workspace Environment');
    expect(instructions).toContain(paths.workspaceDir);
    expect(instructions).toContain('Never attempt to access, read, or modify parent files outside this workspace');

    // 3. Contains Group Standing Instructions from AGENT.md
    expect(instructions).toContain('## Group Standing Instructions (AGENT.md)');
    expect(instructions).toContain('All code must have 100% test coverage');
  });

  it('includes tools documentation and custom sections when provided', () => {
    const toolsDoc = '`read_file(path)`: Reads file content.\n`write_file(path, content)`: Writes file.';
    
    const instructions = composeProjectInstructions(testGroupId, {
      toolsDocumentation: toolsDoc,
      customSections: [
        { name: 'Security Policy', body: 'Do not leak environment secrets.' }
      ]
    });

    expect(instructions).toContain('## Available Tools');
    expect(instructions).toContain('`read_file(path)`');
    expect(instructions).toContain('## Security Policy');
    expect(instructions).toContain('Do not leak environment secrets');
  });

  it('supports fallback to legacy CLAUDE.md if present and AGENT.md was not yet created', () => {
    const paths = getGroupPaths(testGroupId);
    fs.mkdirSync(paths.groupDir, { recursive: true });
    
    // Write legacy CLAUDE.md
    const legacyPath = path.join(paths.groupDir, 'CLAUDE.md');
    fs.writeFileSync(legacyPath, '# Legacy Claude Rules\n- Special rule here.', 'utf-8');

    const composed = composeProjectInstructions(testGroupId);
    expect(composed).toContain('Special rule here');
  });
});
