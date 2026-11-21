import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { 
  parseToolCall, 
  executeAgentWithTools 
} from '../src/runner/tool-loop.js';
import { runPollCycle } from '../src/runner/poll-loop.js';
import { MockEchoProvider } from '../src/runner/providers/index.js';
import type { AgentProvider, ProviderContext } from '../src/runner/providers/types.js';
import { 
  provisionSessionStorage, 
  sessionDir, 
  inboundDbPath, 
  outboundDbPath 
} from '../src/session-manager.js';
import { 
  openInboundDb, 
  openOutboundDb, 
  writeMessageIn 
} from '../src/mailbox/session-db.js';

describe('Phase 8 - Step 3: Tool Execution Loop in Agent Runner', () => {
  const testWorkspaceDir = path.resolve(process.cwd(), 'temp-tool-loop-workspace');

  beforeEach(() => {
    if (!fs.existsSync(testWorkspaceDir)) {
      fs.mkdirSync(testWorkspaceDir, { recursive: true });
    }
  });

  afterEach(() => {
    if (fs.existsSync(testWorkspaceDir)) {
      try {
        fs.rmSync(testWorkspaceDir, { recursive: true, force: true });
      } catch {}
    }
  });

  describe('parseToolCall', () => {
    it('parses standard ```tool_call code blocks', () => {
      const response = `I will read the file now.\n\`\`\`tool_call\n{\n  "name": "read_file",\n  "args": { "path": "package.json" }\n}\n\`\`\`\nPlease wait.`;
      const parsed = parseToolCall(response);
      expect(parsed).not.toBeNull();
      expect(parsed?.name).toBe('read_file');
      expect(parsed?.args).toEqual({ path: 'package.json' });
    });

    it('parses ```tool and ```json:tool variants', () => {
      const resp1 = `\`\`\`tool\n{"name": "write_file", "args": {"path": "a.txt", "content": "123"}}\n\`\`\``;
      const parsed1 = parseToolCall(resp1);
      expect(parsed1?.name).toBe('write_file');
      expect(parsed1?.args).toEqual({ path: 'a.txt', content: '123' });

      const resp2 = `\`\`\`json:tool\n{"tool": "list_directory", "arguments": {"path": "src"}}\n\`\`\``;
      const parsed2 = parseToolCall(resp2);
      expect(parsed2?.name).toBe('list_directory');
      expect(parsed2?.args).toEqual({ path: 'src' });
    });

    it('parses <tool_call> XML-style tags', () => {
      const response = `<tool_call>{"function": "bash", "parameters": {"command": "echo hello"}}</tool_call>`;
      const parsed = parseToolCall(response);
      expect(parsed?.name).toBe('bash');
      expect(parsed?.args).toEqual({ command: 'echo hello' });
    });

    it('returns null when response contains no tool call', () => {
      const response = `Hello! How can I help you today? No tools needed.`;
      expect(parseToolCall(response)).toBeNull();
    });

    it('returns null on malformed JSON inside tool block', () => {
      const response = `\`\`\`tool_call\n{ invalid json here\n\`\`\``;
      expect(parseToolCall(response)).toBeNull();
    });
  });

  describe('executeAgentWithTools', () => {
    it('returns immediately when the model does not call any tools', async () => {
      const provider: AgentProvider = {
        name: 'simple-ai',
        query: vi.fn().mockResolvedValue('Here is your answer without tools.')
      };

      const result = await executeAgentWithTools({
        workspaceDir: testWorkspaceDir,
        provider,
        userPrompt: 'Tell me a joke',
        systemPrompt: 'You are helpful.'
      });

      expect(result.finalText).toBe('Here is your answer without tools.');
      expect(result.stepsExecuted).toBe(1);
      expect(result.toolCalls.length).toBe(0);
      expect(provider.query).toHaveBeenCalledTimes(1);
    });

    it('executes a tool and returns final response after tool output is provided', async () => {
      let callCount = 0;
      const provider: AgentProvider = {
        name: 'file-creator-ai',
        query: vi.fn().mockImplementation(async (prompt: string) => {
          callCount++;
          if (callCount === 1) {
            return `Creating file now.\n\`\`\`tool_call\n{"name": "write_file", "args": {"path": "hello.txt", "content": "Created via Step 3 Tool Loop"}}\n\`\`\``;
          }
          // In turn 2, the prompt contains the tool output
          expect(prompt).toContain('[Tool Output for write_file]');
          return 'I have successfully created the file hello.txt with the requested content.';
        })
      };

      const onToolCall = vi.fn();
      const result = await executeAgentWithTools({
        workspaceDir: testWorkspaceDir,
        provider,
        userPrompt: 'Please create hello.txt',
        onToolCall
      });

      expect(result.finalText).toBe('I have successfully created the file hello.txt with the requested content.');
      expect(result.stepsExecuted).toBe(2);
      expect(result.toolCalls.length).toBe(1);
      expect(result.toolCalls[0].name).toBe('write_file');
      expect(onToolCall).toHaveBeenCalledTimes(1);

      // Verify file was physically created in workspace
      const createdFile = path.join(testWorkspaceDir, 'hello.txt');
      expect(fs.existsSync(createdFile)).toBe(true);
      expect(fs.readFileSync(createdFile, 'utf-8')).toBe('Created via Step 3 Tool Loop');
    });

    it('supports chained multi-step tool calls (write then read)', async () => {
      let turn = 0;
      const provider: AgentProvider = {
        name: 'chain-ai',
        query: vi.fn().mockImplementation(async () => {
          turn++;
          if (turn === 1) {
            return `\`\`\`tool_call\n{"name": "write_file", "args": {"path": "secret.txt", "content": "shh-secret-token"}}\n\`\`\``;
          }
          if (turn === 2) {
            return `\`\`\`tool_call\n{"name": "read_file", "args": {"path": "secret.txt"}}\n\`\`\``;
          }
          return 'Verified that secret.txt contains shh-secret-token.';
        })
      };

      const result = await executeAgentWithTools({
        workspaceDir: testWorkspaceDir,
        provider,
        userPrompt: 'Store and verify secret token',
        maxSteps: 5
      });

      expect(result.stepsExecuted).toBe(3);
      expect(result.toolCalls.length).toBe(2);
      expect(result.toolCalls[0].name).toBe('write_file');
      expect(result.toolCalls[1].name).toBe('read_file');
      expect(result.finalText).toBe('Verified that secret.txt contains shh-secret-token.');
    });

    it('feeds security errors back to model for self-correction without crashing', async () => {
      let turn = 0;
      const provider: AgentProvider = {
        name: 'curious-ai',
        query: vi.fn().mockImplementation(async (prompt: string) => {
          turn++;
          if (turn === 1) {
            // Attempt forbidden path traversal outside workspace
            return `\`\`\`tool_call\n{"name": "read_file", "args": {"path": "../../../etc/passwd"}}\n\`\`\``;
          }
          // Turn 2 sees security error and apologizes/self-corrects
          expect(prompt).toContain('Tool Error');
          expect(prompt).toContain('Security violation');
          return 'I apologize, I am restricted to the workspace directory and cannot access parent files.';
        })
      };

      const result = await executeAgentWithTools({
        workspaceDir: testWorkspaceDir,
        provider,
        userPrompt: 'Read etc/passwd'
      });

      expect(result.stepsExecuted).toBe(2);
      expect(result.toolCalls.length).toBe(1);
      expect(result.toolCalls[0].error).toContain('Security violation');
      expect(result.finalText).toContain('restricted to the workspace directory');
    });

    it('terminates cleanly when maxSteps cutoff is reached', async () => {
      const provider: AgentProvider = {
        name: 'infinite-loop-ai',
        query: vi.fn().mockResolvedValue(
          `\`\`\`tool_call\n{"name": "list_directory", "args": {"path": "."}}\n\`\`\``
        )
      };

      const result = await executeAgentWithTools({
        workspaceDir: testWorkspaceDir,
        provider,
        userPrompt: 'Inspect forever',
        maxSteps: 3
      });

      expect(result.stepsExecuted).toBe(3);
      expect(result.toolCalls.length).toBe(3);
      expect(result.finalText).toContain('maximum number of tool execution steps');
    });
  });

  describe('Integration with runPollCycle', () => {
    const agentGroupId = 'tool-cycle-agent';
    let currentSessionId: string;
    let currentSessionDir: string;

    beforeEach(() => {
      currentSessionId = `test-tool-cycle-${Date.now()}`;
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

    it('executes tool loop through runPollCycle and writes final answer to outbound.db', async () => {
      const inPath = inboundDbPath(agentGroupId, currentSessionId);
      const outPath = outboundDbPath(agentGroupId, currentSessionId);

      // Write test inbound message requesting a file creation
      const inDb = openInboundDb(inPath);
      let inMsg;
      try {
        inMsg = writeMessageIn(inDb, {
          content: 'Create status.json with status ok',
          kind: 'message',
          channel_type: 'cli',
          platform_id: 'term-1',
          thread_id: 'th-1'
        });
      } finally {
        inDb.close();
      }

      let step = 0;
      const toolAwareProvider: AgentProvider = {
        name: 'tool-runner',
        query: vi.fn().mockImplementation(async () => {
          step++;
          if (step === 1) {
            return `\`\`\`tool_call\n{"name": "write_file", "args": {"path": "status.json", "content": "{\\"status\\": \\"ok\\"}"}}\n\`\`\``;
          }
          return 'status.json was created successfully.';
        })
      };

      const result = await runPollCycle({
        agentGroupId,
        sessionId: currentSessionId,
        provider: toolAwareProvider,
        workspaceDir: testWorkspaceDir
      });

      expect(result.processed).toBe(1);

      // Verify file was written to the custom workspaceDir
      const statusFile = path.join(testWorkspaceDir, 'status.json');
      expect(fs.existsSync(statusFile)).toBe(true);
      expect(fs.readFileSync(statusFile, 'utf-8')).toBe('{"status": "ok"}');

      // Verify final response was written to outbound.db
      const outDb = openOutboundDb(outPath, false);
      try {
        const outRow = outDb.prepare('SELECT * FROM messages_out WHERE in_reply_to = ?').get(inMsg.id) as any;
        expect(outRow).toBeDefined();
        expect(outRow.seq).toBe(1);
        expect(outRow.content).toBe('status.json was created successfully.');
      } finally {
        outDb.close();
      }
    });
  });
});
