import type { AgentProvider, ProviderContext } from './types.js';

export interface OpenRouterProviderOptions {
  apiKey?: string;
  model?: string;
  temperature?: number;
  apiBaseUrl?: string;
  siteUrl?: string;
  siteName?: string;
}


export class OpenRouterProvider implements AgentProvider {
  readonly name = 'openrouter';
  private apiKey: string;
  private defaultModel: string;
  private defaultTemperature: number;
  private apiBaseUrl: string;
  private siteUrl: string;
  private siteName: string;

  constructor(options: OpenRouterProviderOptions = {}) {
    this.apiKey =
      options.apiKey ||
      (typeof process !== 'undefined'
        ? process.env.OPENROUTER_API_KEY || process.env.GEMINI_API_KEY || ''
        : '');
    this.defaultModel =
      options.model ||
      (typeof process !== 'undefined' ? process.env.OPENROUTER_MODEL || '' : '') ||
      'google/gemini-2.5-flash';
    this.defaultTemperature = options.temperature ?? 0.7;
    this.apiBaseUrl = (options.apiBaseUrl || 'https://openrouter.ai/api/v1').replace(/\/+$/, '');
    this.siteUrl = options.siteUrl || 'https://github.com/protoclaw/protoclaw';
    this.siteName = options.siteName || 'ProtoClaw';
  }

  async query(prompt: string, context?: ProviderContext): Promise<string> {
    const apiKey =
      this.apiKey ||
      (typeof process !== 'undefined'
        ? process.env.OPENROUTER_API_KEY || process.env.GEMINI_API_KEY || ''
        : '');

    if (!apiKey) {
      throw new Error(
        'OpenRouterProvider: API key is missing. Pass it to the OpenRouterProvider constructor or set OPENROUTER_API_KEY (or GEMINI_API_KEY) in environment variables.'
      );
    }

    let model = context?.model || this.defaultModel;
    // Auto-prefix google/ if user specifies a bare Gemini model name (e.g. gemini-2.5-flash)
    if (!model.includes('/') && model.toLowerCase().startsWith('gemini')) {
      model = `google/${model}`;
    }

    const temperature = context?.temperature ?? this.defaultTemperature;

    const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [];

    if (context?.systemPrompt) {
      messages.push({
        role: 'system',
        content: context.systemPrompt
      });
    }

    if (context?.history && context.history.length > 0) {
      for (const msg of context.history) {
        messages.push({
          role: msg.role,
          content: msg.content
        });
      }
    }

    // Append current user turn
    messages.push({
      role: 'user',
      content: prompt
    });

    const body = {
      model,
      messages,
      temperature
    };

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
      'HTTP-Referer': this.siteUrl,
      'X-Title': this.siteName
    };

    const url = `${this.apiBaseUrl}/chat/completions`;

    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30000) as any
    });

    if (!res.ok) {
      const errorText = await res.text().catch(() => '');
      let detail = errorText;
      try {
        const parsed = JSON.parse(errorText);
        if (parsed.error?.message) {
          detail = parsed.error.message;
        }
      } catch {
        // use raw errorText
      }
      throw new Error(`OpenRouter API error (HTTP ${res.status}): ${detail || res.statusText}`);
    }

    const data = (await res.json()) as {
      choices?: Array<{
        message?: {
          role?: string;
          content?: string;
        };
      }>;
    };

    const content = data.choices?.[0]?.message?.content;
    if (typeof content !== 'string') {
      throw new Error('OpenRouter API returned an empty or unexpected response format.');
    }

    return content.trim();
  }
}
