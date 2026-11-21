/**
 * src/runner/tool-loop.ts
 * Iterative Tool Execution Loop (ReAct: Reasoning + Acting) for ProtoClaw Agent Runner.
 * 
 * Orchestrates multi-turn tool calling:
 * 1. Prompts the agent provider with current instructions and workspace context.
 * 2. Parses tool invocations (```tool_call ... ``` or <tool_call> ... </tool_call>).
 * 3. Safely executes workspace tools within the jailed directory boundary.
 * 4. Feeds tool outputs (or security/runtime errors for self-correction) back to the agent.
 * 5. Loops until the model yields a final text response or hits maxSteps cutoff.
 */

import type { AgentProvider, ChatMessage, ProviderContext } from './providers/types.js';
import { executeWorkspaceTool } from '../tools/workspace.js';
import type { MessageToolContext } from '../tools/message.js';

export interface ParsedToolCall {
  name: string;
  args: Record<string, any>;
  rawBlock: string;
}

/**
 * Extracts and parses a tool call request from an LLM response string.
 * Supports markdown code blocks (```tool_call, ```tool, ```json:tool)
 * and XML tags (<tool_call>).
 */
export function parseToolCall(response: string): ParsedToolCall | null {
  if (!response || typeof response !== 'string') return null;

  // Match ```tool_call ... ``` or ```tool ... ``` or ```json:tool ... ```
  const codeBlockMatch = response.match(/```(?:tool_call|tool|json:tool)\s*([\s\S]*?)```/i);
  // Match <tool_call> ... </tool_call>
  const xmlMatch = response.match(/<tool_call>\s*([\s\S]*?)<\/tool_call>/i);

  const matched = codeBlockMatch || xmlMatch;
  if (!matched) return null;

  try {
    const rawContent = matched[1].trim();
    const parsed = JSON.parse(rawContent);

    const name = parsed.name || parsed.tool || parsed.function || parsed.action;
    if (typeof name !== 'string' || !name.trim()) {
      return null;
    }

    let args = parsed.args || parsed.arguments || parsed.parameters || parsed.action_input || {};
    if (typeof args === 'string') {
      try {
        args = JSON.parse(args);
      } catch {
        args = { input: args };
      }
    }

    return {
      name: name.trim(),
      args: typeof args === 'object' && args !== null ? args : {},
      rawBlock: matched[0]
    };
  } catch {
    return null;
  }
}

export interface ToolExecutionRecord {
  step: number;
  name: string;
  args: Record<string, any>;
  result?: any;
  error?: string;
}

export interface ToolLoopOptions {
  workspaceDir: string;
  provider: AgentProvider;
  userPrompt: string;
  systemPrompt?: string;
  history?: ChatMessage[];
  maxSteps?: number;
  context?: ProviderContext;
  toolContext?: MessageToolContext;
  onToolCall?: (call: { name: string; args: any; result: any; error?: string }) => void;
}

export interface ToolLoopResult {
  finalText: string;
  stepsExecuted: number;
  toolCalls: ToolExecutionRecord[];
}

/**
 * Executes an autonomous reasoning and acting loop for an agent turn.
 */
export async function executeAgentWithTools(
  options: ToolLoopOptions
): Promise<ToolLoopResult> {
  const {
    workspaceDir,
    provider,
    userPrompt,
    systemPrompt,
    history = [],
    maxSteps = 5,
    context = {},
    onToolCall
  } = options;

  const currentHistory: ChatMessage[] = [...history];
  let currentPrompt = userPrompt;
  const recordedCalls: ToolExecutionRecord[] = [];

  for (let step = 0; step < maxSteps; step++) {
    // 1. Query the AI Provider
    const assistantResponse = await provider.query(currentPrompt, {
      ...context,
      systemPrompt,
      history: currentHistory
    });

    // 2. Parse for tool invocation
    const toolCall = parseToolCall(assistantResponse);

    // If no tool was requested, the model has produced its final reply to the user
    if (!toolCall) {
      return {
        finalText: assistantResponse.trim(),
        stepsExecuted: step + 1,
        toolCalls: recordedCalls
      };
    }

    // 3. Dispatch the tool safely within the workspace boundary
    let toolResult: any;
    let toolError: string | undefined;
    let toolResultString: string;

    try {
      toolResult = await executeWorkspaceTool(
        workspaceDir, 
        toolCall.name, 
        toolCall.args, 
        options.toolContext
      );
      toolResultString = typeof toolResult === 'string' ? toolResult : JSON.stringify(toolResult, null, 2);
    } catch (err: any) {
      // Capture error for agent self-correction rather than crashing the loop
      toolError = err?.message || String(err);
      toolResult = { error: toolError };
      toolResultString = `Tool Error: ${toolError}`;
    }

    const record: ToolExecutionRecord = {
      step: step + 1,
      name: toolCall.name,
      args: toolCall.args,
      result: toolResult,
      error: toolError
    };
    recordedCalls.push(record);

    if (onToolCall) {
      try {
        onToolCall({
          name: toolCall.name,
          args: toolCall.args,
          result: toolResult,
          error: toolError
        });
      } catch {
        // Observer callback errors must not abort the agent execution loop
      }
    }

    // 4. Update conversation history with this step
    currentHistory.push({ role: 'user', content: currentPrompt });
    currentHistory.push({ role: 'assistant', content: assistantResponse });

    // 5. Feed tool output back to the model for next turn
    currentPrompt = `[Tool Output for ${toolCall.name}]:\n${toolResultString}\n\nBased on this tool output, continue with the next tool or provide your final response to the user.`;
  }

  // Graceful fallback when maximum iterations are exhausted
  return {
    finalText: 'I reached the maximum number of tool execution steps while processing your request.',
    stepsExecuted: maxSteps,
    toolCalls: recordedCalls
  };
}
