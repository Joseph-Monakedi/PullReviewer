import { describe, expect, it, vi } from 'vitest';
import { GeminiError, registerSecret } from '../src/errors.js';
import { type GenAIModelsLike, GoogleGenAIClient } from '../src/gemini/client.js';
import { parseRetryAfterMs } from '../src/gemini/retry.js';

describe('GoogleGenAIClient & retry logic', () => {
  it('returns text and token usage on first-attempt success', async () => {
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
      const ge = err as GeminiError;
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

