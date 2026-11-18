/**
 * Action input parsing and validation.
 *
 * Inputs are read through an injectable reader so the parsing logic can be
 * unit-tested without the Actions runtime.
 */
import { ConfigError, MissingApiKeyError, registerSecret } from './errors.js';

export interface ReviewerConfig {
  geminiApiKey: string;
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

/** Defaults. Keep in sync with action.yml (a unit test enforces this). */
export const DEFAULTS = {
  model: 'gemini-3.8-flash',
  maxFiles: 50,
  maxDiffChars: 100_000,
  maxFindings: 20,
  reviewLanguage: 'English',
  customInstructions: '',
  instructionsFile: '.github/gemini-review.md',
  useDefaultIgnores: true,
  commentTitle: 'Gemini AI Code Review',
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

/** Model ids are interpolated into a URL path by the SDK, so restrict the charset. */
const MODEL_ID_PATTERN = /^(?:models\/)?[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function loadConfig(read: InputReader): ReviewerConfig {
  const geminiApiKey = read('gemini_api_key').trim();
  if (geminiApiKey === '') {
    throw new MissingApiKeyError(
      'The "gemini_api_key" input is empty. Add a repository secret named GEMINI_API_KEY and pass it with ' +
        '`gemini_api_key: ${{ secrets.GEMINI_API_KEY }}`. Note: secrets are not available to workflows ' +
        'triggered by pull requests from forks.',
    );
  }
  registerSecret(geminiApiKey);

  const githubToken = read('github_token').trim();
  if (githubToken === '') {
    throw new ConfigError('The "github_token" input is empty. It defaults to ${{ github.token }}; do not override it with an empty value.');
  }
  registerSecret(githubToken);

  const model = read('model').trim() || DEFAULTS.model;
  if (!MODEL_ID_PATTERN.test(model)) {
    throw new ConfigError(`Input "model" is not a valid Gemini model identifier: "${model}".`);
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
    geminiApiKey,
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
