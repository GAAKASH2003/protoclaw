import type { AgentProvider, ProviderContext } from './types.js';

export interface GeminiProviderOptions {
  /** Google AI Gemini API Key (defaults to process.env.GEMINI_API_KEY) */
  apiKey?: string;
  /** Gemini Model name (defaults to 'gemini-2.5-flash') */
  model?: string;
  /** Sampling temperature (0.0 to 2.0) */
  temperature?: number;
  /** Optional custom API base URL */
  apiBaseUrl?: string;
}

/**
 * Google Gemini API Provider using Node.js native fetch.
 * Implements the AgentProvider contract with zero third-party dependencies.
 */
export class GeminiProvider implements AgentProvider {
  readonly name = 'gemini';
  private apiKey: string;
  private defaultModel: string;
  private defaultTemperature: number;
  private apiBaseUrl: string;

  constructor(options: GeminiProviderOptions = {}) {
    this.apiKey = options.apiKey || (typeof process !== 'undefined' ? process.env.GEMINI_API_KEY || '' : '');
    this.defaultModel = options.model || (typeof process !== 'undefined' ? process.env.GEMINI_MODEL || '' : '') || 'gemini-2.5-flash';
    this.defaultTemperature = options.temperature ?? 0.7;
    this.apiBaseUrl = options.apiBaseUrl || 'https://generativelanguage.googleapis.com/v1beta';
  }

  async query(prompt: string, context?: ProviderContext): Promise<string> {
    const apiKey = this.apiKey || (typeof process !== 'undefined' ? process.env.GEMINI_API_KEY || '' : '');
    if (!apiKey) {
      throw new Error(
        'GeminiProvider: GEMINI_API_KEY is missing. Pass it to the GeminiProvider constructor or set the GEMINI_API_KEY environment variable.'
      );
    }

    const model = context?.model || this.defaultModel;
    const temperature = context?.temperature ?? this.defaultTemperature;

    // Convert multi-turn history to Gemini's format: [{ role: 'user' | 'model', parts: [{ text }] }]
    const contents: Array<{ role: 'user' | 'model'; parts: Array<{ text: string }> }> = [];

    if (context?.history && context.history.length > 0) {
      for (const msg of context.history) {
        if (msg.role === 'system') continue; // Handled via systemInstruction
        contents.push({
          role: msg.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: msg.content }]
        });
      }
    }

    // Append the current turn
    contents.push({
      role: 'user',
      parts: [{ text: prompt }]
    });

    const body: Record<string, unknown> = {
      contents,
      generationConfig: {
        temperature
      }
    };

    // Attach system instruction if provided
    if (context?.systemPrompt) {
      body.systemInstruction = {
        parts: [{ text: context.systemPrompt }]
      };
    }

    const url = `${this.apiBaseUrl}/models/${model}:generateContent?key=${apiKey}`;

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30000) as any
    });

    if (!res.ok) {
      const errorText = await res.text().catch(() => '');
      throw new Error(`Gemini API error (HTTP ${res.status}): ${errorText || res.statusText}`);
    }

    const data = (await res.json()) as {
      candidates?: Array<{
        content?: {
          parts?: Array<{ text?: string }>;
        };
      }>;
    };

    const candidate = data.candidates?.[0];
    const textPart = candidate?.content?.parts?.[0]?.text;

    if (typeof textPart !== 'string') {
      throw new Error('Gemini API returned an empty or unexpected response format.');
    }

    return textPart.trim();
  }
}

