import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULTS, loadConfig, parseList } from '../src/config.js';
import {
  ConfigError,
  MissingApiKeyError,
  clearRegisteredSecrets,
  redact,
} from '../src/errors.js';

function makeReader(overrides: Record<string, string> = {}): (name: string) => string {
  const base: Record<string, string> = {
    gemini_api_key: 'AIzaSyTestKey123456789012345678901234',
    github_token: 'ghs_testGitHubToken12345678901234567890',
    ...overrides,
  };
  return (name: string) => base[name] ?? '';
}

describe('config', () => {
  beforeEach(() => {
    clearRegisteredSecrets();
  });

  it('loads defaults when optional inputs are empty', () => {
    const cfg = loadConfig(makeReader());
    expect(cfg.model).toBe(DEFAULTS.model);
    expect(cfg.maxFiles).toBe(DEFAULTS.maxFiles);
    expect(cfg.maxDiffChars).toBe(DEFAULTS.maxDiffChars);
    expect(cfg.maxFindings).toBe(DEFAULTS.maxFindings);
    expect(cfg.reviewLanguage).toBe(DEFAULTS.reviewLanguage);
    expect(cfg.customInstructions).toBe('');
    expect(cfg.instructionsFile).toBe(DEFAULTS.instructionsFile);
    expect(cfg.ignorePatterns).toEqual([]);
    expect(cfg.useDefaultIgnores).toBe(true);
    expect(cfg.commentTitle).toBe(DEFAULTS.commentTitle);
    expect(cfg.temperature).toBe(DEFAULTS.temperature);
    expect(cfg.failOnError).toBe(true);
  });

  it('keeps DEFAULTS in sync with action.yml', () => {
    const actionYml = readFileSync(resolve(process.cwd(), 'action.yml'), 'utf8');
    expect(actionYml).toContain(`default: '${DEFAULTS.model}'`);
    expect(actionYml).toContain(`default: '${DEFAULTS.maxFiles}'`);
    expect(actionYml).toContain(`default: '${DEFAULTS.maxDiffChars}'`);
    expect(actionYml).toContain(`default: '${DEFAULTS.maxFindings}'`);
    expect(actionYml).toContain(`default: '${DEFAULTS.reviewLanguage}'`);
    expect(actionYml).toContain(`default: '${DEFAULTS.instructionsFile}'`);
    expect(actionYml).toContain(`default: '${DEFAULTS.commentTitle}'`);
    expect(actionYml).toContain(`default: '${DEFAULTS.temperature}'`);
  });

  it('registers gemini_api_key and github_token for secret redaction', () => {
    loadConfig(
      makeReader({
        gemini_api_key: 'my-custom-gemini-secret-value',
        github_token: 'my-custom-github-secret-value',
      }),
    );
    expect(redact('leaked my-custom-gemini-secret-value and my-custom-github-secret-value')).toBe(
      'leaked *** and ***',
    );
  });

  it('throws MissingApiKeyError when gemini_api_key is missing', () => {
    expect(() => loadConfig(makeReader({ gemini_api_key: '   ' }))).toThrow(MissingApiKeyError);
  });

  it('throws ConfigError when github_token is empty', () => {
    expect(() => loadConfig(makeReader({ github_token: '' }))).toThrow(ConfigError);
  });

  it('validates numeric bounds and integer constraints', () => {
    expect(() => loadConfig(makeReader({ max_files: '0' }))).toThrow(ConfigError);
    expect(() => loadConfig(makeReader({ max_files: '3001' }))).toThrow(ConfigError);
    expect(() => loadConfig(makeReader({ max_files: '12.5' }))).toThrow(ConfigError);
    expect(() => loadConfig(makeReader({ max_diff_chars: '500' }))).toThrow(ConfigError);
    expect(() => loadConfig(makeReader({ max_findings: '101' }))).toThrow(ConfigError);
    expect(() => loadConfig(makeReader({ temperature: '-0.1' }))).toThrow(ConfigError);
    expect(() => loadConfig(makeReader({ temperature: '2.5' }))).toThrow(ConfigError);
    expect(() => loadConfig(makeReader({ temperature: 'not-a-number' }))).toThrow(ConfigError);
  });

  it('parses booleans and rejects invalid boolean values', () => {
    const cfg = loadConfig(
      makeReader({
        use_default_ignores: 'false',
        fail_on_error: '0',
      }),
    );
    expect(cfg.useDefaultIgnores).toBe(false);
    expect(cfg.failOnError).toBe(false);

    expect(() => loadConfig(makeReader({ use_default_ignores: 'maybe' }))).toThrow(ConfigError);
  });

  it('rejects malformed model identifiers and oversized custom instructions', () => {
    expect(() => loadConfig(makeReader({ model: '../evil/path' }))).toThrow(ConfigError);
    expect(() =>
      loadConfig(makeReader({ custom_instructions: 'x'.repeat(10_001) })),
    ).toThrow(ConfigError);
  });

  it('disables instructions_file when set to "none" or "false"', () => {
    expect(loadConfig(makeReader({ instructions_file: 'none' })).instructionsFile).toBe('');
    expect(loadConfig(makeReader({ instructions_file: 'FALSE' })).instructionsFile).toBe('');
  });

  it('parses comma- and newline-separated pattern lists and ignores comments', () => {
    const raw = `
      # Build artifacts
      dist/**, coverage/**
      *.generated.ts
      !dist/keep.js
    `;
    expect(parseList(raw)).toEqual([
      'dist/**',
      'coverage/**',
      '*.generated.ts',
      '!dist/keep.js',
    ]);
  });
});

