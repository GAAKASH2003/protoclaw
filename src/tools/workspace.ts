/**
 * src/tools/workspace.ts
 * Sandboxed Workspace Tool Primitives for ProtoClaw Agents.
 * 
 * Invariants:
 * 1. Boundary Guard: All file operations are strictly jailed to the agent's workspace directory.
 * 2. Path Traversal Protection: Traversal attempts (../, root absolute paths) throw a WorkspaceSecurityError.
 * 3. Command Execution: All commands execute with cwd = workspace directory and a strict timeout.
 */

import fs from 'node:fs';
import path from 'node:path';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

export class WorkspaceSecurityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkspaceSecurityError';
  }
}

/**
 * Validates that a user-supplied path resolves strictly within the workspace directory.
 * Throws WorkspaceSecurityError if the path attempts to escape the boundary.
 */
export function resolveSafePath(workspaceDir: string, userPath: string): string {
  const root = path.resolve(workspaceDir);
  const resolved = path.resolve(root, userPath);

  // Must equal root or start with root + path separator
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new WorkspaceSecurityError(
      `Security violation: Path "${userPath}" attempts to escape workspace boundary "${workspaceDir}".`
    );
  }

  return resolved;
}

export interface ReadFileResult {
  path: string;
  content: string;
  sizeBytes: number;
}

/**
 * Reads text content of a file within the workspace.
 */
export function readFile(workspaceDir: string, filePath: string): ReadFileResult {
  const fullPath = resolveSafePath(workspaceDir, filePath);
  if (!fs.existsSync(fullPath)) {
    throw new Error(`File not found: "${filePath}"`);
  }
  const stat = fs.statSync(fullPath);
  if (!stat.isFile()) {
    throw new Error(`Path is a directory, not a file: "${filePath}"`);
  }
  const content = fs.readFileSync(fullPath, 'utf-8');
  return {
    path: path.relative(workspaceDir, fullPath).replace(/\\/g, '/'),
    content,
    sizeBytes: stat.size
  };
}

export interface WriteFileResult {
  path: string;
  bytesWritten: number;
  success: boolean;
}

/**
 * Creates or overwrites a file within the workspace, automatically creating parent directories.
 */
export function writeFile(workspaceDir: string, filePath: string, content: string): WriteFileResult {
  const fullPath = resolveSafePath(workspaceDir, filePath);
  const dir = path.dirname(fullPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(fullPath, content, 'utf-8');
  return {
    path: path.relative(workspaceDir, fullPath).replace(/\\/g, '/'),
    bytesWritten: Buffer.byteLength(content, 'utf-8'),
    success: true
  };
}

export interface DirectoryEntry {
  name: string;
  type: 'file' | 'directory';
  sizeBytes?: number;
}

export interface ListDirectoryResult {
  path: string;
  entries: DirectoryEntry[];
}

/**
 * Lists entries in a directory within the workspace.
 */
export function listDirectory(workspaceDir: string, dirPath = '.'): ListDirectoryResult {
  const fullPath = resolveSafePath(workspaceDir, dirPath);
  if (!fs.existsSync(fullPath)) {
    throw new Error(`Directory not found: "${dirPath}"`);
  }
  const stat = fs.statSync(fullPath);
  if (!stat.isDirectory()) {
    throw new Error(`Path is a file, not a directory: "${dirPath}"`);
  }

  const items = fs.readdirSync(fullPath, { withFileTypes: true });
  const entries: DirectoryEntry[] = items.map((item) => {
    let sizeBytes: number | undefined;
    if (item.isFile()) {
      try {
        sizeBytes = fs.statSync(path.join(fullPath, item.name)).size;
      } catch {}
    }
    return {
      name: item.name,
      type: item.isDirectory() ? 'directory' : 'file',
      sizeBytes
    };
  });

  return {
    path: path.relative(workspaceDir, fullPath).replace(/\\/g, '/') || '.',
    entries
  };
}

export interface BashOptions {
  timeoutMs?: number;
  maxBuffer?: number;
}

export interface BashResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  success: boolean;
}

/**
 * Executes a shell command strictly inside the workspace directory.
 */
export async function bash(
  workspaceDir: string,
  command: string,
  options: BashOptions = {}
): Promise<BashResult> {
  const root = path.resolve(workspaceDir);
  if (!fs.existsSync(root)) {
    fs.mkdirSync(root, { recursive: true });
  }

  const timeout = options.timeoutMs ?? 30000;
  const maxBuffer = options.maxBuffer ?? 1024 * 1024; // 1MB buffer

  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd: root,
      timeout,
      maxBuffer,
      windowsHide: true
    });
    return {
      stdout: stdout.trim(),
      stderr: stderr.trim(),
      exitCode: 0,
      success: true
    };
  } catch (error: any) {
    return {
      stdout: (error.stdout || '').trim(),
      stderr: (error.stderr || error.message || '').trim(),
      exitCode: typeof error.code === 'number' ? error.code : 1,
      success: false
    };
  }
}

import { 
  SEND_MESSAGE_TOOL, 
  executeSendMessage, 
  type MessageToolContext 
} from './message.js';

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

export const WORKSPACE_TOOLS: ToolDefinition[] = [
  {
    name: 'read_file',
    description: 'Reads the text content of a file within your workspace.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative path of the file to read.' }
      },
      required: ['path']
    }
  },
  {
    name: 'write_file',
    description: 'Creates or overwrites a file with new content inside your workspace.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative path of the file to write.' },
        content: { type: 'string', description: 'Text content to write into the file.' }
      },
      required: ['path', 'content']
    }
  },
  {
    name: 'list_directory',
    description: 'Lists all files and subdirectories within a workspace directory.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative path of the directory to inspect (defaults to root ".").' }
      },
      required: []
    }
  },
  {
    name: 'bash',
    description: 'Executes a shell command strictly inside your workspace directory.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command line to execute.' }
      },
      required: ['command']
    }
  }
];

export const COMMUNICATION_TOOLS: ToolDefinition[] = [
  SEND_MESSAGE_TOOL
];

export const AGENT_TOOLS: ToolDefinition[] = [
  ...WORKSPACE_TOOLS,
  ...COMMUNICATION_TOOLS
];

export const WORKSPACE_TOOLS_DOCUMENTATION = `
- \`read_file(path)\`: Reads the contents of a file inside your workspace.
- \`write_file(path, content)\`: Writes text content to a file inside your workspace (creates parent directories automatically).
- \`list_directory(path?)\`: Lists files and subdirectories inside your workspace directory.
- \`bash(command)\`: Executes a shell command strictly within your workspace folder.
- \`send_message(to, content)\`: Sends a message to a named external channel or peer agent destination.
`.trim();

/**
 * Unified tool dispatcher that validates and executes any workspace tool by name.
 */
export async function executeWorkspaceTool(
  workspaceDir: string,
  name: string,
  args: Record<string, any>,
  context?: MessageToolContext
): Promise<any> {
  switch (name) {
    case 'read_file':
      if (typeof args.path !== 'string') {
        throw new Error('read_file requires a string "path" argument.');
      }
      return readFile(workspaceDir, args.path);

    case 'write_file':
      if (typeof args.path !== 'string' || typeof args.content !== 'string') {
        throw new Error('write_file requires string "path" and "content" arguments.');
      }
      return writeFile(workspaceDir, args.path, args.content);

    case 'list_directory':
      return listDirectory(workspaceDir, typeof args.path === 'string' ? args.path : '.');

    case 'bash':
      if (typeof args.command !== 'string') {
        throw new Error('bash requires a string "command" argument.');
      }
      return await bash(workspaceDir, args.command, { timeoutMs: args.timeoutMs });

    case 'send_message':
      return await executeSendMessage(args, context);

    default:
      throw new Error(
        `Unknown workspace tool: "${name}". Available tools: read_file, write_file, list_directory, bash, send_message.`
      );
  }
}
