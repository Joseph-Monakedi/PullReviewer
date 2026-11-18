import { describe, expect, it, vi } from 'vitest';
import { AiProviderError, GeminiError, registerSecret } from '../src/errors.js';
import {
  AnthropicClient,
  type FetchLike,
  type GenAIModelsLike,
  GoogleGenAIClient,
  OpenAICompatibleClient,
  createAiClient,
} from '../src/gemini/client.js';
import { parseRetryAfterMs } from '../src/gemini/retry.js';

describe('Multi-provider AI clients & retry logic', () => {
  it('GoogleGenAIClient returns text and token usage on first-attempt success', async () => {
    const models: GenAIModelsLike = {
      generateContent: vi.fn().mockResolvedValue({
        text: '{"summary":"ok","risk_level":"low","findings":[],"positive_observations":[]}',
        usageMetadata: {
          promptTokenCount: 120,
          candidatesTokenCount: 45,
          totalTokenCount: 165,
        },
      }),
    };

    const client = new GoogleGenAIClient('key', { sleep: async () => {} }, models);
    const res = await client.generateReview({
      model: 'gemini-3.8-flash',
      systemInstruction: 'sys',
      userPrompt: 'usr',
      temperature: 0.2,
    });

    expect(res.text).toContain('"summary":"ok"');
    expect(res.usage).toEqual({
      promptTokens: 120,
      candidateTokens: 45,
      totalTokens: 165,
    });
  });

  it('OpenAICompatibleClient calls /chat/completions and parses usage', async () => {
    const fakeFetch: FetchLike = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content:
                  '{"summary":"openai ok","risk_level":"low","findings":[],"positive_observations":[]}',
              },
              finish_reason: 'stop',
            },
          ],
          usage: {
            prompt_tokens: 200,
            completion_tokens: 60,
            total_tokens: 260,
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const client = createAiClient({
      provider: 'openai',
      apiKey: 'sk-proj-testkey12345678901234567890',
      retryOptions: { sleep: async () => {} },
      fetchImpl: fakeFetch,
    });

    const res = await client.generateReview({
      model: 'gpt-4.1-mini',
      systemInstruction: 'sys',
      userPrompt: 'usr',
      temperature: 0.2,
    });

    expect(res.text).toContain('openai ok');
    expect(res.usage).toEqual({
      promptTokens: 200,
      candidateTokens: 60,
      totalTokens: 260,
    });
    expect(fakeFetch).toHaveBeenCalledWith(
      'https://api.openai.com/v1/chat/completions',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('AnthropicClient calls /messages with x-api-key and parses token usage', async () => {
    const fakeFetch: FetchLike = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          content: [
            {
              type: 'text',
              text: '{"summary":"claude ok","risk_level":"low","findings":[],"positive_observations":[]}',
            },
          ],
          stop_reason: 'end_turn',
          usage: {
            input_tokens: 300,
            output_tokens: 90,
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const client = new AnthropicClient({
      apiKey: 'sk-ant-testkey12345678901234567890',
      retryOptions: { sleep: async () => {} },
      fetchImpl: fakeFetch,
    });

    const res = await client.generateReview({
      model: 'claude-sonnet-4-20250514',
      systemInstruction: 'sys',
      userPrompt: 'usr',
      temperature: 0.2,
    });

    expect(res.text).toContain('claude ok');
    expect(res.usage).toEqual({
      promptTokens: 300,
      candidateTokens: 90,
      totalTokens: 390,
    });
    expect(fakeFetch).toHaveBeenCalledWith(
      'https://api.anthropic.com/v1/messages',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('OpenAICompatibleClient retries on 429 and 503 and succeeds', async () => {
    const fakeFetch: FetchLike = vi
      .fn()
      .mockResolvedValueOnce(
        new Response('Rate limited', { status: 429, headers: { 'retry-after': '1' } }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content:
                    '{"summary":"recovered","risk_level":"low","findings":[],"positive_observations":[]}',
                },
              },
            ],
            usage: { total_tokens: 100 },
          }),
          { status: 200 },
        ),
      );

    const client = new OpenAICompatibleClient({
      apiKey: 'sk-or-v1-testkey12345678901234567890',
      providerLabel: 'OpenRouter',
      retryOptions: { sleep: async () => {} },
      fetchImpl: fakeFetch,
    });

    const res = await client.generateReview({
      model: 'deepseek/deepseek-r1',
      systemInstruction: 'sys',
      userPrompt: 'usr',
      temperature: 0.2,
    });
    expect(res.text).toContain('recovered');
    expect(fakeFetch).toHaveBeenCalledTimes(2);
  });

  it('retries on 429 and 503 with Retry-After support and succeeds', async () => {
    const delays: number[] = [];
    const generateContent = vi
      .fn()
      .mockRejectedValueOnce({
        status: 429,
        message: 'Rate limit exceeded {"retryDelay": "3s"}',
      })
      .mockRejectedValueOnce({
        status: 503,
        headers: { 'retry-after': '2' },
        message: 'Service temporarily unavailable',
      })
      .mockResolvedValueOnce({
        text: '{"summary":"recovered","risk_level":"low","findings":[],"positive_observations":[]}',
        usageMetadata: { totalTokenCount: 50 },
      });

    const client = new GoogleGenAIClient(
      'key',
      {
        maxAttempts: 3,
        baseDelayMs: 100,
        random: () => 0,
        sleep: async (ms) => {
          delays.push(ms);
        },
      },
      { generateContent },
    );

    const res = await client.generateReview({
      model: 'gemini-3.8-flash',
      systemInstruction: 'sys',
      userPrompt: 'usr',
      temperature: 0.2,
    });

    expect(res.text).toContain('recovered');
    expect(generateContent).toHaveBeenCalledTimes(3);
    expect(delays).toEqual([3000, 2000]);
  });

  it('does not retry on 401/403/404 and redacts leaked API keys', async () => {
    const secretKey = 'AIzaSySecretKeyThatMustNotAppearInLogs12345';
    registerSecret(secretKey);

    const generateContent = vi.fn().mockRejectedValue({
      status: 401,
      message: `Invalid key ${secretKey}`,
    });

    const client = new GoogleGenAIClient(
      secretKey,
      { maxAttempts: 3, sleep: async () => {} },
      { generateContent },
    );

    await expect(
      client.generateReview({
        model: 'gemini-3.8-flash',
        systemInstruction: 'sys',
        userPrompt: 'usr',
        temperature: 0.2,
      }),
    ).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(GeminiError);
      expect(err).toBeInstanceOf(AiProviderError);
      const ge = err as AiProviderError;
      expect(ge.status).toBe(401);
      expect(ge.retryable).toBe(false);
      expect(ge.message).not.toContain(secretKey);
      return true;
    });

    expect(generateContent).toHaveBeenCalledTimes(1);
  });

  it('fails without retry when response is blocked or empty', async () => {
    const blockedModels: GenAIModelsLike = {
      generateContent: vi.fn().mockResolvedValue({
        promptFeedback: { blockReason: 'SAFETY', blockReasonMessage: 'Blocked by policy' },
      }),
    };
    const blockedClient = new GoogleGenAIClient('key', { sleep: async () => {} }, blockedModels);
    await expect(
      blockedClient.generateReview({
        model: 'gemini-3.8-flash',
        systemInstruction: 'sys',
        userPrompt: 'usr',
        temperature: 0.2,
      }),
    ).rejects.toThrow(/blocked the review prompt \(SAFETY: Blocked by policy\)/);

    const emptyModels: GenAIModelsLike = {
      generateContent: vi.fn().mockResolvedValue({
        text: '   ',
        candidates: [{ finishReason: 'MAX_TOKENS' }],
      }),
    };
    const emptyClient = new GoogleGenAIClient('key', { sleep: async () => {} }, emptyModels);
    await expect(
      emptyClient.generateReview({
        model: 'gemini-3.8-flash',
        systemInstruction: 'sys',
        userPrompt: 'usr',
        temperature: 0.2,
      }),
    ).rejects.toThrow(/empty response \(finishReason: MAX_TOKENS\)/);
  });

  it('parses HTTP-date and Headers.get Retry-After values', () => {
    const now = Date.UTC(2026, 10, 18, 12, 0, 0);
    const futureDate = new Date(now + 5000).toUTCString();
    expect(
      parseRetryAfterMs(
        {
          headers: {
            get: (name: string) => (name === 'retry-after' ? futureDate : null),
          },
        },
        now,
      ),
    ).toBe(5000);
  });
});
