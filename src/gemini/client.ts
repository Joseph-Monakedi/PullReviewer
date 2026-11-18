/**
 * Wrapper around the official `@google/genai` SDK.
 *
 * Security invariants:
 * - No tools, code execution, or grounding are ever enabled.
 * - Instructions live exclusively in `systemInstruction`; untrusted PR text is
 *   passed only in `contents`.
 * - Output is constrained to `application/json` matching `REVIEW_RESPONSE_JSON_SCHEMA`.
 */
import { GoogleGenAI } from '@google/genai';
import { GeminiError } from '../errors.js';
import { REVIEW_RESPONSE_JSON_SCHEMA } from '../review/schema.js';
import { type RetryOptions, withRetry } from './retry.js';

export interface TokenUsage {
  promptTokens?: number;
  candidateTokens?: number;
  totalTokens?: number;
}

export interface GeminiReviewRequest {
  model: string;
  systemInstruction: string;
  userPrompt: string;
  temperature: number;
}

export interface GeminiReviewResult {
  text: string;
  usage: TokenUsage;
}

export interface GeminiClient {
  generateReview(request: GeminiReviewRequest): Promise<GeminiReviewResult>;
}

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

export class GoogleGenAIClient implements GeminiClient {
  private readonly models: GenAIModelsLike;
  private readonly retryOptions: RetryOptions;

  constructor(apiKey: string, retryOptions: RetryOptions = {}, modelsOverride?: GenAIModelsLike) {
    this.models = modelsOverride ?? (new GoogleGenAI({ apiKey }).models as unknown as GenAIModelsLike);
    this.retryOptions = retryOptions;
  }

  async generateReview(request: GeminiReviewRequest): Promise<GeminiReviewResult> {
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
          throw new GeminiError(
            `Gemini blocked the review prompt (${blockReason}${detail}).`,
            undefined,
            false,
          );
        }

        const text = response.text?.trim() ?? '';
        if (!text) {
          const finishReason = response.candidates?.[0]?.finishReason ?? 'UNKNOWN';
          throw new GeminiError(
            `Gemini returned an empty response (finishReason: ${finishReason}).`,
            undefined,
            false,
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

