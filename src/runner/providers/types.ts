/**
 * Types and interfaces for Agent Providers.
 */

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface ProviderContext {
  /** Optional system instructions / persona prompt */
  systemPrompt?: string;
  /** Previous conversation turns */
  history?: ChatMessage[];
  /** Model override */
  model?: string;
  /** Sampling temperature (0.0 to 2.0) */
  temperature?: number;
}

export interface AgentProvider {
  /** Provider identifier (e.g. 'mock', 'gemini', 'anthropic', 'openai') */
  readonly name: string;
  /** Query the AI model and return its text response */
  query(prompt: string, context?: ProviderContext): Promise<string>;
}

