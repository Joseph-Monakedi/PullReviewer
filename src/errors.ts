/**
 * Error types and secret-redaction helpers.
 *
 * Every message that may reach the Actions log or a PR comment should be passed
 * through `redact()` so credentials can never leak, even if an upstream library
 * echoes request details in an exception message.
 */

/** Invalid or missing action configuration. */
export class ConfigError extends Error {
  override readonly name: string = 'ConfigError';
}

/** The AI provider API key input is empty (common for fork PRs, where secrets are withheld). */
export class MissingApiKeyError extends ConfigError {
  override readonly name = 'MissingApiKeyError';
}

/** A failure talking to the configured AI provider API. */
export class AiProviderError extends Error {
  override readonly name: string = 'AiProviderError';
  constructor(
    message: string,
    readonly status: number | undefined,
    readonly retryable: boolean,
    readonly retryAfterMs?: number,
    readonly provider?: string,
  ) {
    super(message);
  }
}

/** Backwards-compatible alias for AiProviderError. */
export { AiProviderError as GeminiError };

/** The AI model returned something that is not a valid review document. */
export class ResponseValidationError extends Error {
  override readonly name = 'ResponseValidationError';
}

/** A failure talking to the GitHub API. */
export class GitHubApiError extends Error {
  override readonly name = 'GitHubApiError';
  constructor(
    message: string,
    readonly status: number | undefined,
  ) {
    super(message);
  }
}

const registeredSecrets = new Set<string>();

/** Register a value that must never appear in output. */
export function registerSecret(value: string | undefined): void {
  if (value && value.trim().length >= 4) registeredSecrets.add(value.trim());
}

/** Test helper: forget all registered secrets. */
export function clearRegisteredSecrets(): void {
  registeredSecrets.clear();
}

/** Well-known credential shapes across AI providers & GitHub, redacted even if never registered. */
const CREDENTIAL_PATTERNS: RegExp[] = [
  /AIza[0-9A-Za-z_-]{30,}/g, // Google / Gemini API keys
  /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g, // Anthropic API keys
  /\bsk-proj-[A-Za-z0-9_-]{20,}\b/g, // OpenAI project API keys
  /\bsk-or-[A-Za-z0-9_-]{20,}\b/g, // OpenRouter API keys
  /\bsk-[A-Za-z0-9_-]{20,}\b/g, // OpenAI / generic sk- API keys
  /\bgsk_[A-Za-z0-9_-]{20,}\b/g, // Groq API keys
  /\bhf_[A-Za-z0-9]{20,}\b/g, // Hugging Face tokens
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g, // GitHub tokens
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, // GitHub fine-grained PATs
  /([?&](?:key|api_key|apikey|access_token)=)[^&\s"']+/gi, // credentials in URLs
  /(x-goog-api-key["']?\s*[:=]\s*["']?)[^\s"',}]+/gi, // Google auth header
  /(x-api-key["']?\s*[:=]\s*["']?)[^\s"',}]+/gi, // Anthropic / generic x-api-key header
  /(api-key["']?\s*[:=]\s*["']?)[^\s"',}]+/gi, // Azure OpenAI api-key header
  /(authorization["']?\s*[:=]\s*["']?(?:bearer|token)\s+)[^\s"',}]+/gi, // auth headers
];

/** Remove secrets and credential-looking strings from arbitrary text. */
export function redact(text: string): string {
  let out = text;
  for (const secret of registeredSecrets) {
    out = out.split(secret).join('***');
  }
  for (const pattern of CREDENTIAL_PATTERNS) {
    out = out.replace(pattern, (match, prefix?: unknown) =>
      typeof prefix === 'string' && match.startsWith(prefix) ? `${prefix}***` : '***',
    );
  }
  return out;
}

/** Produce a safe, single-line-ish description of any thrown value. */
export function describeError(err: unknown): string {
  let message: string;
  if (err instanceof Error) {
    message = `${err.name}: ${err.message}`;
  } else if (typeof err === 'string') {
    message = err;
  } else {
    try {
      message = JSON.stringify(err);
    } catch {
      message = String(err);
    }
  }
  const redacted = redact(message);
  return redacted.length > 1000 ? `${redacted.slice(0, 1000)}…` : redacted;
}

/** Extract an HTTP status code from common error shapes (Octokit, Gen AI SDK, fetch). */
export function getStatus(err: unknown): number | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const candidate = err as { status?: unknown; code?: unknown; response?: { status?: unknown } };
  for (const value of [candidate.status, candidate.response?.status, candidate.code]) {
    if (typeof value === 'number' && value >= 100 && value < 600) return value;
    if (typeof value === 'string' && /^\d{3}$/.test(value)) return Number(value);
  }
  return undefined;
}
