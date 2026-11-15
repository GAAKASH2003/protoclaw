import type { AgentProvider } from './types.js';
import { GeminiProvider } from './gemini.js';
import { OpenRouterProvider } from './openrouter.js';
import { MockEchoProvider } from './mock.js';

export * from './types.js';
export * from './mock.js';
export * from './gemini.js';
export * from './openrouter.js';

/**
 * Returns the appropriate provider based on configured environment variables:
 * 1. GeminiProvider if GEMINI_API_KEY is present
 * 2. OpenRouterProvider if OPENROUTER_API_KEY is present
 * 3. MockEchoProvider as a fallback for offline development/testing
 */
export function createDefaultProvider(): AgentProvider {
  if (typeof process !== 'undefined' && process.env.GEMINI_API_KEY) {
    return new GeminiProvider();
  }
  if (typeof process !== 'undefined' && process.env.OPENROUTER_API_KEY) {
    return new OpenRouterProvider();
  }
  return new MockEchoProvider();
}
