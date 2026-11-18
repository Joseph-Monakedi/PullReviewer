/**
 * Retry helper with exponential backoff, jitter, and Retry-After support for
 * transient Gemini API and network failures.
 */
import { GeminiError, describeError, getStatus } from '../errors.js';

export interface RetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  onRetry?: (attempt: number, delayMs: number, error: GeminiError) => void;
}

const RETRYABLE_STATUS_CODES = new Set([408, 429, 500, 502, 503, 504]);
const NON_RETRYABLE_STATUS_CODES = new Set([400, 401, 403, 404, 422]);

const TRANSIENT_NETWORK_PATTERN =
  /\b(?:ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|EPIPE|UND_ERR_[A-Z_]+|fetch failed|network error|socket hang up|timed? ?out)\b/i;

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Parse a Retry-After header (delta-seconds or HTTP-date) or Google's retryDelay ("12s"). */
export function parseRetryAfterMs(err: unknown, nowMs: number = Date.now()): number | undefined {
  if (typeof err !== 'object' || err === null) return undefined;

  const candidate = err as {
    retryAfterMs?: unknown;
    headers?: Record<string, unknown> | { get?: (name: string) => string | null };
    response?: { headers?: Record<string, unknown> | { get?: (name: string) => string | null } };
    message?: unknown;
  };

  if (typeof candidate.retryAfterMs === 'number' && candidate.retryAfterMs > 0) {
    return candidate.retryAfterMs;
  }

  const headerSources = [candidate.headers, candidate.response?.headers];
  for (const headers of headerSources) {
    if (!headers) continue;
    let rawHeader: unknown;
    if (typeof (headers as { get?: unknown }).get === 'function') {
      rawHeader = (headers as { get: (name: string) => string | null }).get('retry-after');
    } else {
      const record = headers as Record<string, unknown>;
      rawHeader = record['retry-after'] ?? record['Retry-After'];
    }
    if (typeof rawHeader === 'string' && rawHeader.trim() !== '') {
      const trimmed = rawHeader.trim();
      if (/^\d+(\.\d+)?$/.test(trimmed)) {
        return Math.ceil(Number(trimmed) * 1000);
      }
      const dateMs = Date.parse(trimmed);
      if (!Number.isNaN(dateMs) && dateMs > nowMs) {
        return dateMs - nowMs;
      }
    }
  }

  // Google RPC ErrorInfo / RetryInfo often embeds `"retryDelay": "15s"` in the error body/message.
  if (typeof candidate.message === 'string') {
    const match = /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/i.exec(candidate.message);
    if (match) {
      return Math.ceil(Number(match[1]) * 1000);
    }
  }

  return undefined;
}

/** Convert an arbitrary error from the Gemini SDK into a classified, redacted GeminiError. */
export function classifyGeminiError(err: unknown, model: string): GeminiError {
  if (err instanceof GeminiError) return err;

  const status = getStatus(err);
  const retryAfterMs = parseRetryAfterMs(err);
  const rawDesc = describeError(err);

  if (status !== undefined) {
    if (NON_RETRYABLE_STATUS_CODES.has(status)) {
      const hint =
        status === 401 || status === 403
          ? 'Verify that GEMINI_API_KEY is valid and enabled for the Gemini API.'
          : status === 404
            ? `Verify that model "${model}" exists and is available to your API key.`
            : 'Check the request configuration and model parameters.';
      return new GeminiError(
        `Gemini API request failed with HTTP ${status} (model "${model}"). ${hint} Details: ${rawDesc}`,
        status,
        false,
      );
    }
    if (RETRYABLE_STATUS_CODES.has(status)) {
      const rateHint =
        status === 429
          ? 'Rate limit or quota exceeded (HTTP 429).'
          : `Transient server error (HTTP ${status}).`;
      return new GeminiError(
        `Gemini API temporary failure on model "${model}": ${rateHint} Details: ${rawDesc}`,
        status,
        true,
        retryAfterMs,
      );
    }
    return new GeminiError(
      `Gemini API error HTTP ${status} (model "${model}"): ${rawDesc}`,
      status,
      status >= 500,
      retryAfterMs,
    );
  }

  const isTransientNetwork = TRANSIENT_NETWORK_PATTERN.test(rawDesc);
  return new GeminiError(
    `Gemini API error (model "${model}"): ${rawDesc}`,
    undefined,
    isTransientNetwork,
    retryAfterMs,
  );
}

export async function withRetry<T>(
  operation: (attempt: number) => Promise<T>,
  model: string,
  options: RetryOptions = {},
): Promise<T> {
  const maxAttempts = Math.max(1, options.maxAttempts ?? 3);
  const baseDelayMs = options.baseDelayMs ?? 1_500;
  const maxDelayMs = options.maxDelayMs ?? 30_000;
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;

  let lastError: GeminiError | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await operation(attempt);
    } catch (err) {
      const classified = classifyGeminiError(err, model);
      lastError = classified;

      if (!classified.retryable || attempt >= maxAttempts) {
        throw classified;
      }

      const exponential = baseDelayMs * Math.pow(2, attempt - 1);
      const jitter = Math.floor(random() * baseDelayMs * 0.5);
      const computedDelay = Math.max(exponential + jitter, classified.retryAfterMs ?? 0);
      const delayMs = Math.min(computedDelay, maxDelayMs);

      options.onRetry?.(attempt, delayMs, classified);
      await sleep(delayMs);
    }
  }

  throw lastError ?? new GeminiError(`Gemini request failed after ${maxAttempts} attempts.`, undefined, false);
}

