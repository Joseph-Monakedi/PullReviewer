/**
 * Action input parsing, provider resolution, and validation.
 *
 * Inputs are read through an injectable reader so the parsing logic can be
 * unit-tested without the Actions runtime.
 */
import { ConfigError, MissingApiKeyError, registerSecret } from './errors.js';

export const PROVIDERS = ['gemini', 'openai', 'anthropic', 'openai-compatible'] as const;
export type AiProvider = (typeof PROVIDERS)[number];
export type ProviderInput = AiProvider | 'auto';

export interface ReviewerConfig {
  provider: AiProvider;
  apiKey: string;
  /** Backwards-compatible alias for `apiKey`. */
  geminiApiKey: string;
  baseUrl?: string;
  githubToken: string;
  model: string;
  maxFiles: number;
  maxDiffChars: number;
  maxFindings: number;
  reviewLanguage: string;
  customInstructions: string;
  instructionsFile: string;
  ignorePatterns: string[];
  useDefaultIgnores: boolean;
  commentTitle: string;
  temperature: number;
  failOnError: boolean;
}

export const PROVIDER_DEFAULT_MODELS: Record<AiProvider, string> = {
  gemini: 'gemini-3.8-flash',
  openai: 'gpt-4.1-mini',
  anthropic: 'claude-sonnet-4-20250514',
  'openai-compatible': 'gpt-4.1-mini',
};

/** Defaults. Keep in sync with action.yml (a unit test enforces this). */
export const DEFAULTS = {
  provider: 'auto' as ProviderInput,
  model: 'gemini-3.8-flash',
  maxFiles: 50,
  maxDiffChars: 100_000,
  maxFindings: 20,
  reviewLanguage: 'English',
  customInstructions: '',
  instructionsFile: '.github/ai-review.md',
  legacyInstructionsFile: '.github/gemini-review.md',
  useDefaultIgnores: true,
  commentTitle: 'AI Code Review',
  temperature: 0.2,
  failOnError: true,
} as const;

export const LIMITS = {
  maxFiles: { min: 1, max: 3000 },
  maxDiffChars: { min: 1_000, max: 2_000_000 },
  maxFindings: { min: 1, max: 100 },
  temperature: { min: 0, max: 2 },
  customInstructionsChars: 10_000,
  commentTitleChars: 200,
} as const;

export type InputReader = (name: string) => string;

function parseInteger(name: string, raw: string, fallback: number, min: number, max: number): number {
  const value = raw.trim();
  if (value === '') return fallback;
  if (!/^\d+$/.test(value)) {
    throw new ConfigError(`Input "${name}" must be a whole number, got "${value}".`);
  }
  const parsed = Number(value);
  if (parsed < min || parsed > max) {
    throw new ConfigError(`Input "${name}" must be between ${min} and ${max}, got ${parsed}.`);
  }
  return parsed;
}

function parseNumber(name: string, raw: string, fallback: number, min: number, max: number): number {
  const value = raw.trim();
  if (value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    throw new ConfigError(`Input "${name}" must be a number between ${min} and ${max}, got "${value}".`);
  }
  return parsed;
}

function parseBoolean(name: string, raw: string, fallback: boolean): boolean {
  const value = raw.trim().toLowerCase();
  if (value === '') return fallback;
  if (['true', 'yes', '1', 'on'].includes(value)) return true;
  if (['false', 'no', '0', 'off'].includes(value)) return false;
  throw new ConfigError(`Input "${name}" must be "true" or "false", got "${raw.trim()}".`);
}

/** Split a newline- or comma-separated list; supports `#` comment lines. */
export function parseList(raw: string): string[] {
  return raw
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0 && !item.startsWith('#'));
}

/**
 * Model identifiers across Gemini, OpenAI, Anthropic, OpenRouter, and Ollama
 * (e.g. `gemini-3.8-flash`, `gpt-4.1-mini`, `claude-sonnet-4-20250514`,
 * `deepseek/deepseek-r1`, `qwen2.5-coder:32b`). Path traversal is forbidden.
 */
const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;

export function isValidModelId(model: string): boolean {
  return MODEL_ID_PATTERN.test(model) && !model.includes('..') && !model.includes('//');
}

function parseProviderInput(raw: string): ProviderInput {
  const normalized = raw.trim().toLowerCase();
  if (normalized === '' || normalized === 'auto') return 'auto';
  if (normalized === 'google') return 'gemini';
  if (normalized === 'claude') return 'anthropic';
  if (normalized === 'openrouter' || normalized === 'ollama' || normalized === 'custom') {
    return 'openai-compatible';
  }
  if ((PROVIDERS as readonly string[]).includes(normalized)) {
    return normalized as AiProvider;
  }
  throw new ConfigError(
    `Input "provider" must be one of "auto", "gemini", "openai", "anthropic", or "openai-compatible", got "${raw.trim()}".`,
  );
}

/** Infer the provider when `provider: auto` is configured. */
export function detectProvider(
  explicit: ProviderInput,
  rawModel: string,
  baseUrl: string | undefined,
  apiKey: string,
): AiProvider {
  if (explicit !== 'auto') return explicit;

  if (baseUrl) {
    const lowerUrl = baseUrl.toLowerCase();
    if (lowerUrl.includes('anthropic.com')) return 'anthropic';
    if (lowerUrl.includes('googleapis.com')) return 'gemini';
    if (lowerUrl.includes('api.openai.com')) return 'openai';
    return 'openai-compatible';
  }

  const lowerModel = rawModel.trim().toLowerCase();
  if (lowerModel) {
    if (lowerModel.startsWith('claude-') || lowerModel.startsWith('anthropic/')) {
      return lowerModel.startsWith('anthropic/') ? 'openai-compatible' : 'anthropic';
    }
    if (
      lowerModel.startsWith('gpt-') ||
      lowerModel.startsWith('chatgpt-') ||
      /^o[134](?:$|-)/.test(lowerModel)
    ) {
      return 'openai';
    }
    if (lowerModel.startsWith('gemini-') || lowerModel.startsWith('models/gemini-')) {
      return 'gemini';
    }
    if (lowerModel.includes('/')) {
      return 'openai-compatible';
    }
  }

  if (apiKey.startsWith('sk-ant-')) return 'anthropic';
  if (apiKey.startsWith('sk-or-')) return 'openai-compatible';
  if (apiKey.startsWith('sk-')) return 'openai';

  return 'gemini';
}

function validateBaseUrl(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new ConfigError(`Input "base_url" is not a valid URL: "${trimmed}".`);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new ConfigError(`Input "base_url" must use http:// or https://, got "${parsed.protocol}".`);
  }
  return trimmed.replace(/\/+$/, '');
}

function isLocalhostUrl(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '::1';
  } catch {
    return false;
  }
}

export function loadConfig(read: InputReader): ReviewerConfig {
  const providerInput = parseProviderInput(read('provider'));
  const baseUrl = validateBaseUrl(read('base_url'));

  // Accept `api_key` (universal) or provider-specific `gemini_api_key` (backwards-compatible).
  let apiKey = read('api_key').trim() || read('gemini_api_key').trim();
  if (apiKey === '' && isLocalhostUrl(baseUrl)) {
    apiKey = 'local-no-key';
  }
  if (apiKey === '') {
    throw new MissingApiKeyError(
      'No AI API key was provided. Pass `api_key: ${{ secrets.AI_API_KEY }}` (or `gemini_api_key: ${{ secrets.GEMINI_API_KEY }}`). ' +
        'Note: repository secrets are not available to workflows triggered by pull requests from forks.',
    );
  }
  if (apiKey !== 'local-no-key') {
    registerSecret(apiKey);
  }

  const githubToken = read('github_token').trim();
  if (githubToken === '') {
    throw new ConfigError(
      'The "github_token" input is empty. It defaults to ${{ github.token }}; do not override it with an empty value.',
    );
  }
  registerSecret(githubToken);

  const rawModel = read('model').trim();
  const provider = detectProvider(providerInput, rawModel, baseUrl, apiKey);
  const model = rawModel || PROVIDER_DEFAULT_MODELS[provider];

  if (!isValidModelId(model)) {
    throw new ConfigError(`Input "model" is not a valid model identifier: "${model}".`);
  }

  const customInstructions = read('custom_instructions').trim();
  if (customInstructions.length > LIMITS.customInstructionsChars) {
    throw new ConfigError(
      `Input "custom_instructions" is too long (${customInstructions.length} chars, max ${LIMITS.customInstructionsChars}).`,
    );
  }

  const commentTitle = (read('comment_title').trim() || DEFAULTS.commentTitle)
    .replace(/[\r\n]+/g, ' ')
    .slice(0, LIMITS.commentTitleChars);

  const instructionsFile = read('instructions_file').trim();

  return {
    provider,
    apiKey,
    geminiApiKey: apiKey,
    baseUrl,
    githubToken,
    model,
    maxFiles: parseInteger('max_files', read('max_files'), DEFAULTS.maxFiles, LIMITS.maxFiles.min, LIMITS.maxFiles.max),
    maxDiffChars: parseInteger(
      'max_diff_chars',
      read('max_diff_chars'),
      DEFAULTS.maxDiffChars,
      LIMITS.maxDiffChars.min,
      LIMITS.maxDiffChars.max,
    ),
    maxFindings: parseInteger(
      'max_findings',
      read('max_findings'),
      DEFAULTS.maxFindings,
      LIMITS.maxFindings.min,
      LIMITS.maxFindings.max,
    ),
    reviewLanguage: (read('review_language').trim() || DEFAULTS.reviewLanguage).slice(0, 50),
    customInstructions,
    // An explicit "none" (or "false") disables the instructions file lookup.
    instructionsFile: ['none', 'false'].includes(instructionsFile.toLowerCase())
      ? ''
      : instructionsFile || DEFAULTS.instructionsFile,
    ignorePatterns: parseList(read('ignore_patterns')),
    useDefaultIgnores: parseBoolean('use_default_ignores', read('use_default_ignores'), DEFAULTS.useDefaultIgnores),
    commentTitle,
    temperature: parseNumber(
      'temperature',
      read('temperature'),
      DEFAULTS.temperature,
      LIMITS.temperature.min,
      LIMITS.temperature.max,
    ),
    failOnError: parseBoolean('fail_on_error', read('fail_on_error'), DEFAULTS.failOnError),
  };
}
