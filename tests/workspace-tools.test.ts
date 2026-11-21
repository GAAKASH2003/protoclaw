import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  resolveSafePath,
  readFile,
  writeFile,
  listDirectory,
  bash,
  executeWorkspaceTool,
  WorkspaceSecurityError,
  WORKSPACE_TOOLS
} from '../src/tools/workspace.js';

describe('Phase 8 - Step 2: Sandboxed Workspace Tools Engine', () => {
  const testWorkspace = path.resolve(process.cwd(), 'groups', `test-ws-${Date.now()}`, 'workspace');

  beforeEach(() => {
    fs.mkdirSync(testWorkspace, { recursive: true });
  });

  afterEach(() => {
    const groupDir = path.dirname(testWorkspace);
    if (fs.existsSync(groupDir)) {
      try {
        fs.rmSync(groupDir, { recursive: true, force: true });
      } catch {}
    }
  });

  describe('Boundary Guard & Traversal Protection', () => {
    it('allows paths strictly inside the workspace', () => {
      const p1 = resolveSafePath(testWorkspace, 'hello.txt');
      expect(p1).toBe(path.join(testWorkspace, 'hello.txt'));

      const p2 = resolveSafePath(testWorkspace, 'sub/nested/file.ts');
      expect(p2).toBe(path.join(testWorkspace, 'sub', 'nested', 'file.ts'));
    });

    it('blocks directory traversal attacks (../) with WorkspaceSecurityError', () => {
      expect(() => resolveSafePath(testWorkspace, '../outside.txt')).toThrow(WorkspaceSecurityError);
      expect(() => resolveSafePath(testWorkspace, '../../.env')).toThrow(WorkspaceSecurityError);
      expect(() => resolveSafePath(testWorkspace, '../../../etc/passwd')).toThrow(WorkspaceSecurityError);
    });

    it('blocks absolute paths outside workspace', () => {
      const outsidePath = path.resolve(process.cwd(), 'package.json');
      expect(() => resolveSafePath(testWorkspace, outsidePath)).toThrow(WorkspaceSecurityError);
    });
  });

  describe('File Operations: writeFile & readFile', () => {
    it('writes and reads a text file', () => {
      const writeRes = writeFile(testWorkspace, 'notes.txt', 'Hello ProtoClaw Workspace!');
      expect(writeRes.success).toBe(true);
      expect(writeRes.path).toBe('notes.txt');

      const readRes = readFile(testWorkspace, 'notes.txt');
      expect(readRes.content).toBe('Hello ProtoClaw Workspace!');
      expect(readRes.sizeBytes).toBeGreaterThan(0);
    });

    it('automatically creates nested parent directories on write', () => {
      writeFile(testWorkspace, 'src/modules/math/calc.ts', 'export const add = (a, b) => a + b;');

      expect(fs.existsSync(path.join(testWorkspace, 'src', 'modules', 'math', 'calc.ts'))).toBe(true);
      const readRes = readFile(testWorkspace, 'src/modules/math/calc.ts');
      expect(readRes.content).toContain('export const add');
    });

    it('throws error when reading non-existent file', () => {
      expect(() => readFile(testWorkspace, 'missing.txt')).toThrow('File not found');
    });

    it('blocks reading or writing outside the workspace', () => {
      expect(() => writeFile(testWorkspace, '../malicious.txt', 'evil')).toThrow(WorkspaceSecurityError);
      expect(() => readFile(testWorkspace, '../../.env')).toThrow(WorkspaceSecurityError);
    });
  });

  describe('Directory Inspection: listDirectory', () => {
    it('lists files and subdirectories accurately', () => {
      writeFile(testWorkspace, 'file1.txt', 'one');
      writeFile(testWorkspace, 'file2.js', 'console.log()');
      writeFile(testWorkspace, 'subdir/nested.json', '{}');

      const result = listDirectory(testWorkspace, '.');

      expect(result.entries.length).toBe(3);
      const names = result.entries.map((e) => e.name);
      expect(names).toContain('file1.txt');
      expect(names).toContain('file2.js');
      expect(names).toContain('subdir');

      const subEntry = result.entries.find((e) => e.name === 'subdir');
      expect(subEntry?.type).toBe('directory');
    });
  });

  describe('Command Execution: bash', () => {
    it('executes commands with cwd set strictly to the workspace directory', async () => {
      writeFile(testWorkspace, 'data.txt', 'Sandboxed Data');

      // Check current working directory via node
      const cmd = `node -e "console.log(process.cwd())"`;
      const res = await bash(testWorkspace, cmd);

      expect(res.success).toBe(true);
      expect(res.exitCode).toBe(0);
      expect(path.resolve(res.stdout)).toBe(path.resolve(testWorkspace));
    });

    it('captures exit code and stderr on command failures', async () => {
      const res = await bash(testWorkspace, `node -e "process.exit(42)"`);
      expect(res.success).toBe(false);
      expect(res.exitCode).toBe(42);
    });
  });

  describe('Unified Tool Dispatcher: executeWorkspaceTool', () => {
    it('dispatches write_file, read_file, list_directory, and bash correctly', async () => {
      // 1. write_file
      const w = await executeWorkspaceTool(testWorkspace, 'write_file', {
        path: 'app.js',
        content: 'console.log(123);'
      });
      expect(w.success).toBe(true);

      // 2. read_file
      const r = await executeWorkspaceTool(testWorkspace, 'read_file', { path: 'app.js' });
      expect(r.content).toBe('console.log(123);');

      // 3. list_directory
      const l = await executeWorkspaceTool(testWorkspace, 'list_directory', {});
      expect(l.entries.some((e: any) => e.name === 'app.js')).toBe(true);

      // 4. bash
      const b = await executeWorkspaceTool(testWorkspace, 'bash', { command: 'node app.js' });
      expect(b.stdout).toBe('123');
    });

    it('throws error on unknown tool name', async () => {
      await expect(
        executeWorkspaceTool(testWorkspace, 'unknown_tool', {})
      ).rejects.toThrow('Unknown workspace tool');
    });
  });

  describe('Tool Definitions Schema', () => {
    it('exports all 4 core workspace tools with valid JSON Schemas', () => {
      expect(WORKSPACE_TOOLS.length).toBe(4);
      const names = WORKSPACE_TOOLS.map((t) => t.name);
      expect(names).toEqual(['read_file', 'write_file', 'list_directory', 'bash']);

      for (const tool of WORKSPACE_TOOLS) {
        expect(tool.description).toBeTruthy();
        expect(tool.parameters.type).toBe('object');
        expect(tool.parameters.properties).toBeDefined();
      }
    });
  });
});
