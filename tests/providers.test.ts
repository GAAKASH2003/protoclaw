import { describe, it, expect, vi, afterEach } from 'vitest';
import { 
  MockEchoProvider, 
  GeminiProvider, 
  OpenRouterProvider, 
  createDefaultProvider 
} from '../src/runner/providers/index.js';

describe('Phase 4 - Step 1: Agent Providers', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('MockEchoProvider', () => {
    it('returns default echo prefix and records call history', async () => {
      const mock = new MockEchoProvider();
      expect(mock.name).toBe('mock');

      const response = await mock.query('Hello world');
      expect(response).toBe('Echo: Hello world');
      expect(mock.calls.length).toBe(1);
      expect(mock.calls[0].prompt).toBe('Hello world');
    });

    it('supports custom responder function', async () => {
      const mock = new MockEchoProvider({
        responder: (prompt) => `Calculated: ${prompt}`
      });

      const response = await mock.query('2 + 2');
      expect(response).toBe('Calculated: 2 + 2');
    });
  });

  describe('GeminiProvider', () => {
    it('throws when GEMINI_API_KEY is missing', async () => {
      const provider = new GeminiProvider({ apiKey: '' });
      const oldKey = process.env.GEMINI_API_KEY;
      delete process.env.GEMINI_API_KEY;

      await expect(provider.query('Hi')).rejects.toThrow('GEMINI_API_KEY is missing');

      if (oldKey) process.env.GEMINI_API_KEY = oldKey;
    });

    it('formats request payload and parses Gemini candidate response', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          candidates: [
            {
              content: {
                parts: [{ text: 'Greetings from Gemini!' }]
              }
            }
          ]
        })
      });
      vi.stubGlobal('fetch', mockFetch);

      const provider = new GeminiProvider({ apiKey: 'test-api-key', model: 'gemini-2.5-flash' });
      const response = await provider.query('Hello', {
        systemPrompt: 'You are a helpful assistant.',
        history: [{ role: 'user', content: 'Who are you?' }, { role: 'assistant', content: 'I am an AI.' }]
      });

      expect(response).toBe('Greetings from Gemini!');
      expect(mockFetch).toHaveBeenCalledTimes(1);

      // Verify the URL and body format
      const [calledUrl, calledOptions] = mockFetch.mock.calls[0];
      expect(calledUrl).toContain('models/gemini-2.5-flash:generateContent?key=test-api-key');

      const body = JSON.parse(calledOptions.body);
      expect(body.systemInstruction.parts[0].text).toBe('You are a helpful assistant.');
      expect(body.contents.length).toBe(3); // 2 history turns + 1 current prompt
      expect(body.contents[0]).toEqual({ role: 'user', parts: [{ text: 'Who are you?' }] });
      expect(body.contents[1]).toEqual({ role: 'model', parts: [{ text: 'I am an AI.' }] });
      expect(body.contents[2]).toEqual({ role: 'user', parts: [{ text: 'Hello' }] });
    });

    it('handles HTTP error responses from Gemini API', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        statusText: 'Bad Request',
        text: async () => 'Invalid model name'
      }));

      const provider = new GeminiProvider({ apiKey: 'test-api-key' });
      await expect(provider.query('Hello')).rejects.toThrow('Gemini API error (HTTP 400): Invalid model name');
    });
  });

  describe('OpenRouterProvider', () => {
    it('throws when both OPENROUTER_API_KEY and GEMINI_API_KEY are missing', async () => {
      const oldRouterKey = process.env.OPENROUTER_API_KEY;
      const oldGeminiKey = process.env.GEMINI_API_KEY;
      delete process.env.OPENROUTER_API_KEY;
      delete process.env.GEMINI_API_KEY;

      const provider = new OpenRouterProvider({ apiKey: '' });
      await expect(provider.query('Hi')).rejects.toThrow('API key is missing');

      if (oldRouterKey) process.env.OPENROUTER_API_KEY = oldRouterKey;
      if (oldGeminiKey) process.env.GEMINI_API_KEY = oldGeminiKey;
    });

    it('falls back to GEMINI_API_KEY if OPENROUTER_API_KEY is not set', async () => {
      const oldRouterKey = process.env.OPENROUTER_API_KEY;
      const oldGeminiKey = process.env.GEMINI_API_KEY;
      delete process.env.OPENROUTER_API_KEY;
      process.env.GEMINI_API_KEY = 'gemini-fallback-key';

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [{ message: { role: 'assistant', content: 'Fallback worked!' } }]
        })
      });
      vi.stubGlobal('fetch', mockFetch);

      const provider = new OpenRouterProvider();
      const res = await provider.query('Ping');

      expect(res).toBe('Fallback worked!');
      const [, calledOptions] = mockFetch.mock.calls[0];
      expect(calledOptions.headers['Authorization']).toBe('Bearer gemini-fallback-key');

      if (oldRouterKey) process.env.OPENROUTER_API_KEY = oldRouterKey;
      else delete process.env.OPENROUTER_API_KEY;
      if (oldGeminiKey) process.env.GEMINI_API_KEY = oldGeminiKey;
      else delete process.env.GEMINI_API_KEY;
    });

    it('formats OpenAI-compatible payload, prefixes google/ to gemini models, and parses response', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                role: 'assistant',
                content: 'Response from Gemini via OpenRouter'
              }
            }
          ]
        })
      });
      vi.stubGlobal('fetch', mockFetch);

      const provider = new OpenRouterProvider({
        apiKey: 'sk-or-v1-test',
        model: 'gemini-2.5-flash',
        siteUrl: 'https://testsite.com',
        siteName: 'TestApp'
      });

      const response = await provider.query('What is 1+1?', {
        systemPrompt: 'Be concise.',
        history: [
          { role: 'user', content: 'Hi' },
          { role: 'assistant', content: 'Hello!' }
        ]
      });

      expect(response).toBe('Response from Gemini via OpenRouter');
      expect(mockFetch).toHaveBeenCalledTimes(1);

      const [calledUrl, calledOptions] = mockFetch.mock.calls[0];
      expect(calledUrl).toBe('https://openrouter.ai/api/v1/chat/completions');
      expect(calledOptions.headers).toEqual({
        'Content-Type': 'application/json',
        'Authorization': 'Bearer sk-or-v1-test',
        'HTTP-Referer': 'https://testsite.com',
        'X-Title': 'TestApp'
      });

      const body = JSON.parse(calledOptions.body);
      expect(body.model).toBe('google/gemini-2.5-flash');
      expect(body.messages).toEqual([
        { role: 'system', content: 'Be concise.' },
        { role: 'user', content: 'Hi' },
        { role: 'assistant', content: 'Hello!' },
        { role: 'user', content: 'What is 1+1?' }
      ]);
    });

    it('handles OpenRouter API error payloads cleanly', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
        text: async () => JSON.stringify({ error: { message: 'User key is invalid' } })
      }));

      const provider = new OpenRouterProvider({ apiKey: 'bad-key' });
      await expect(provider.query('Hello')).rejects.toThrow('OpenRouter API error (HTTP 401): User key is invalid');
    });
  });

  describe('createDefaultProvider', () => {
    it('creates GeminiProvider when GEMINI_API_KEY is present', () => {
      const oldGeminiKey = process.env.GEMINI_API_KEY;
      process.env.GEMINI_API_KEY = 'test-gemini-key';

      const provider = createDefaultProvider();
      expect(provider.name).toBe('gemini');

      if (oldGeminiKey) process.env.GEMINI_API_KEY = oldGeminiKey;
      else delete process.env.GEMINI_API_KEY;
    });

    it('falls back to MockEchoProvider when no API keys are set', () => {
      const oldGeminiKey = process.env.GEMINI_API_KEY;
      const oldRouterKey = process.env.OPENROUTER_API_KEY;
      delete process.env.GEMINI_API_KEY;
      delete process.env.OPENROUTER_API_KEY;

      const provider = createDefaultProvider();
      expect(provider.name).toBe('mock');

      if (oldGeminiKey) process.env.GEMINI_API_KEY = oldGeminiKey;
      if (oldRouterKey) process.env.OPENROUTER_API_KEY = oldRouterKey;
    });
  });
});
