/**
 * Multi-provider AI client adapters:
 * - `gemini`: Official `@google/genai` SDK
 * - `openai`: OpenAI Chat Completions API (`https://api.openai.com/v1`)
 * - `anthropic`: Anthropic Messages API (`https://api.anthropic.com/v1`)
 * - `openai-compatible`: Any OpenAI-compatible endpoint (OpenRouter, Groq,
 *   DeepSeek, Together, Mistral, Fireworks, Ollama, vLLM, LiteLLM, Azure, etc.)
 *
 * Security invariants across all providers:
 * - No tools, function calling, or code execution are ever enabled.
 * - Instructions live exclusively in the system prompt; untrusted PR text is
 *   passed only in the user message.
 * - Output is constrained to structured JSON matching `REVIEW_RESPONSE_JSON_SCHEMA`.
 */
import { GoogleGenAI } from '@google/genai';
import type { AiProvider } from '../config.js';
import { AiProviderError } from '../errors.js';
import { REVIEW_RESPONSE_JSON_SCHEMA } from '../review/schema.js';
import { type RetryOptions, withRetry } from './retry.js';

export interface TokenUsage {
  promptTokens?: number;
  candidateTokens?: number;
  totalTokens?: number;
}

export interface AiReviewRequest {
  model: string;
  systemInstruction: string;
  userPrompt: string;
  temperature: number;
}

export type GeminiReviewRequest = AiReviewRequest;

export interface AiReviewResult {
  text: string;
  usage: TokenUsage;
}

export type GeminiReviewResult = AiReviewResult;

export interface AiClient {
  generateReview(request: AiReviewRequest): Promise<AiReviewResult>;
}

export type GeminiClient = AiClient;

/** Minimal shape of `ai.models.generateContent` so tests can inject a fake SDK. */
export interface GenAIModelsLike {
  generateContent(params: {
    model: string;
    contents: string;
    config: {
      systemInstruction: string;
      temperature: number;
      responseMimeType: string;
      responseJsonSchema: Record<string, unknown>;
    };
  }): Promise<{
    text?: string;
    promptFeedback?: { blockReason?: string; blockReasonMessage?: string };
    candidates?: Array<{ finishReason?: string }>;
    usageMetadata?: {
      promptTokenCount?: number;
      candidatesTokenCount?: number;
      totalTokenCount?: number;
    };
  }>;
}

export type FetchLike = typeof globalThis.fetch;

async function readErrorBody(response: Response): Promise<string> {
  try {
    const text = await response.text();
    return text.slice(0, 600);
  } catch {
    return response.statusText || 'HTTP error';
  }
}

export class GoogleGenAIClient implements AiClient {
  private readonly models: GenAIModelsLike;
  private readonly retryOptions: RetryOptions;

  constructor(
    apiKey: string,
    retryOptions: RetryOptions = {},
    modelsOverride?: GenAIModelsLike,
    baseUrl?: string,
  ) {
    this.models =
      modelsOverride ??
      (new GoogleGenAI({
        apiKey,
        ...(baseUrl ? { httpOptions: { baseUrl } } : {}),
      }).models as unknown as GenAIModelsLike);
    this.retryOptions = { providerName: 'Gemini', ...retryOptions };
  }

  async generateReview(request: AiReviewRequest): Promise<AiReviewResult> {
    return withRetry(
      async () => {
        const response = await this.models.generateContent({
          model: request.model,
          contents: request.userPrompt,
          config: {
            systemInstruction: request.systemInstruction,
            temperature: request.temperature,
            responseMimeType: 'application/json',
            responseJsonSchema: REVIEW_RESPONSE_JSON_SCHEMA,
          },
        });

        const blockReason = response.promptFeedback?.blockReason;
        if (blockReason) {
          const detail = response.promptFeedback?.blockReasonMessage
            ? `: ${response.promptFeedback.blockReasonMessage}`
            : '';
          throw new AiProviderError(
            `Gemini blocked the review prompt (${blockReason}${detail}).`,
            undefined,
            false,
            undefined,
            'Gemini',
          );
        }

        const text = response.text?.trim() ?? '';
        if (!text) {
          const finishReason = response.candidates?.[0]?.finishReason ?? 'UNKNOWN';
          throw new AiProviderError(
            `Gemini returned an empty response (finishReason: ${finishReason}).`,
            undefined,
            false,
            undefined,
            'Gemini',
          );
        }

        return {
          text,
          usage: {
            promptTokens: response.usageMetadata?.promptTokenCount,
            candidateTokens: response.usageMetadata?.candidatesTokenCount,
            totalTokens: response.usageMetadata?.totalTokenCount,
          },
        };
      },
      request.model,
      this.retryOptions,
    );
  }
}

export class OpenAICompatibleClient implements AiClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly providerLabel: string;
  private readonly retryOptions: RetryOptions;
  private readonly fetchImpl: FetchLike;

  constructor(options: {
    apiKey: string;
    baseUrl?: string;
    providerLabel?: string;
    retryOptions?: RetryOptions;
    fetchImpl?: FetchLike;
  }) {
    this.apiKey = options.apiKey;
    const defaultBase = options.apiKey.startsWith('sk-or-')
      ? 'https://openrouter.ai/api/v1'
      : 'https://api.openai.com/v1';
    this.baseUrl = (options.baseUrl ?? defaultBase).replace(/\/+$/, '');
    this.providerLabel = options.providerLabel ?? 'OpenAI';
    this.retryOptions = { providerName: this.providerLabel, ...options.retryOptions };
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
  }

  async generateReview(request: AiReviewRequest): Promise<AiReviewResult> {
    return withRetry(
      async () => {
        const isReasoningModel = /^o[134](?:$|-)/i.test(request.model);
        const body: Record<string, unknown> = {
          model: request.model,
          messages: [
            { role: 'system', content: request.systemInstruction },
            { role: 'user', content: request.userPrompt },
          ],
          response_format: { type: 'json_object' },
        };
        if (!isReasoningModel) {
          body.temperature = request.temperature;
        }

        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
        };
        if (this.apiKey && this.apiKey !== 'local-no-key') {
          headers.Authorization = `Bearer ${this.apiKey}`;
        }

        const endpoint = this.baseUrl.endsWith('/chat/completions')
          ? this.baseUrl
          : `${this.baseUrl}/chat/completions`;

        const response = await this.fetchImpl(endpoint, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
        });

        if (!response.ok) {
          const errorBody = await readErrorBody(response);
          throw Object.assign(new Error(`HTTP ${response.status}: ${errorBody}`), {
            status: response.status,
            headers: response.headers,
          });
        }

        const payload = (await response.json()) as {
          choices?: Array<{
            message?: { content?: string | null; refusal?: string | null };
            finish_reason?: string;
          }>;
          usage?: {
            prompt_tokens?: number;
            completion_tokens?: number;
            total_tokens?: number;
          };
        };

        const choice = payload.choices?.[0];
        if (choice?.message?.refusal) {
          throw new AiProviderError(
            `${this.providerLabel} refused the review request: ${choice.message.refusal}`,
            undefined,
            false,
            undefined,
            this.providerLabel,
          );
        }

        const text = choice?.message?.content?.trim() ?? '';
        if (!text) {
          const finishReason = choice?.finish_reason ?? 'UNKNOWN';
          throw new AiProviderError(
            `${this.providerLabel} returned an empty response (finish_reason: ${finishReason}).`,
            undefined,
            false,
            undefined,
            this.providerLabel,
          );
        }

        return {
          text,
          usage: {
            promptTokens: payload.usage?.prompt_tokens,
            candidateTokens: payload.usage?.completion_tokens,
            totalTokens: payload.usage?.total_tokens,
          },
        };
      },
      request.model,
      this.retryOptions,
    );
  }
}

export class AnthropicClient implements AiClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly retryOptions: RetryOptions;
  private readonly fetchImpl: FetchLike;

  constructor(options: {
    apiKey: string;
    baseUrl?: string;
    retryOptions?: RetryOptions;
    fetchImpl?: FetchLike;
  }) {
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? 'https://api.anthropic.com/v1').replace(/\/+$/, '');
    this.retryOptions = { providerName: 'Anthropic', ...options.retryOptions };
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
  }

  async generateReview(request: AiReviewRequest): Promise<AiReviewResult> {
    return withRetry(
      async () => {
        const endpoint = this.baseUrl.endsWith('/messages')
          ? this.baseUrl
          : `${this.baseUrl}/messages`;

        const response = await this.fetchImpl(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': this.apiKey,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model: request.model,
            max_tokens: 8192,
            temperature: Math.min(1, request.temperature),
            system: request.systemInstruction,
            messages: [{ role: 'user', content: request.userPrompt }],
          }),
        });

        if (!response.ok) {
          const errorBody = await readErrorBody(response);
          throw Object.assign(new Error(`HTTP ${response.status}: ${errorBody}`), {
            status: response.status,
            headers: response.headers,
          });
        }

        const payload = (await response.json()) as {
          content?: Array<{ type?: string; text?: string }>;
          stop_reason?: string;
          usage?: {
            input_tokens?: number;
            output_tokens?: number;
          };
        };

        const text = (payload.content ?? [])
          .filter((block) => block.type === 'text' && typeof block.text === 'string')
          .map((block) => block.text)
          .join('\n')
          .trim();

        if (!text) {
          const stopReason = payload.stop_reason ?? 'UNKNOWN';
          throw new AiProviderError(
            `Anthropic returned an empty response (stop_reason: ${stopReason}).`,
            undefined,
            false,
            undefined,
            'Anthropic',
          );
        }

        const promptTokens = payload.usage?.input_tokens;
        const candidateTokens = payload.usage?.output_tokens;
        const totalTokens =
          promptTokens !== undefined || candidateTokens !== undefined
            ? (promptTokens ?? 0) + (candidateTokens ?? 0)
            : undefined;

        return {
          text,
          usage: {
            promptTokens,
            candidateTokens,
            totalTokens,
          },
        };
      },
      request.model,
      this.retryOptions,
    );
  }
}

export interface CreateAiClientOptions {
  provider: AiProvider;
  apiKey: string;
  baseUrl?: string;
  retryOptions?: RetryOptions;
  fetchImpl?: FetchLike;
}

export function createAiClient(options: CreateAiClientOptions): AiClient {
  switch (options.provider) {
    case 'gemini':
      return new GoogleGenAIClient(
        options.apiKey,
        options.retryOptions,
        undefined,
        options.baseUrl,
      );
    case 'anthropic':
      return new AnthropicClient({
        apiKey: options.apiKey,
        baseUrl: options.baseUrl,
        retryOptions: options.retryOptions,
        fetchImpl: options.fetchImpl,
      });
    case 'openai':
      return new OpenAICompatibleClient({
        apiKey: options.apiKey,
        baseUrl: options.baseUrl,
        providerLabel: 'OpenAI',
        retryOptions: options.retryOptions,
        fetchImpl: options.fetchImpl,
      });
    case 'openai-compatible':
      return new OpenAICompatibleClient({
        apiKey: options.apiKey,
        baseUrl: options.baseUrl,
        providerLabel: 'OpenAI-compatible',
        retryOptions: options.retryOptions,
        fetchImpl: options.fetchImpl,
      });
  }
}
