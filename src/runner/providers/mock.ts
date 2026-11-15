import type { AgentProvider, ProviderContext } from './types.js';

export interface MockProviderOptions {
  prefix?: string;
  responder?: (prompt: string, context?: ProviderContext) => string | Promise<string>;
}

/**
 * Deterministic test provider for fast, offline unit tests.
 */
export class MockEchoProvider implements AgentProvider {
  readonly name = 'mock';
  private prefix: string;
  private responder?: (prompt: string, context?: ProviderContext) => string | Promise<string>;
  public calls: Array<{ prompt: string; context?: ProviderContext }> = [];

  constructor(options: MockProviderOptions = {}) {
    this.prefix = options.prefix ?? 'Echo: ';
    this.responder = options.responder;
  }

  async query(prompt: string, context?: ProviderContext): Promise<string> {
    this.calls.push({ prompt, context });
    if (this.responder) {
      return this.responder(prompt, context);
    }
    return `${this.prefix}${prompt}`;
  }

  clear(): void {
    this.calls.length = 0;
  }
}

