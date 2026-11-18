import { beforeEach, describe, expect, it } from 'vitest';
import {
   clearRegisteredSecrets,
  describeError,
  getStatus,
  redact,
  registerSecret,
} from '../src/errors.js';

describe('errors & secret redaction', () => {
  beforeEach(() => {
    clearRegisteredSecrets();
  });

  it('redacts explicitly registered secrets', () => {
    registerSecret('super-secret-value-12345');
    expect(redact('Error calling API with super-secret-value-12345!')).toBe(
      'Error calling API with ***!',
    );
  });

  it('redacts common credential patterns even when not registered', () => {
    const googleKey = 'AIzaSyD-9876543210abcdefghijklmnopqrstuvwx';
    const ghToken = 'ghp_1234567890abcdefghijklmnopqrstuvwxyz';
    const finePat = 'github_pat_11ABCDEFG0123456789_abcdefghijklmnop';
    const text = [
      `google=${googleKey}`,
      `gh=${ghToken}`,
      `pat=${finePat}`,
      'url=https://generativelanguage.googleapis.com/v1beta/models?key=MY_URL_SECRET_KEY&foo=1',
      'header x-goog-api-key: "header-secret-value"',
      'Authorization: Bearer bearer-secret-token',
    ].join(' | ');

    const out = redact(text);
    expect(out).not.toContain(googleKey);
    expect(out).not.toContain(ghToken);
    expect(out).not.toContain(finePat);
    expect(out).not.toContain('MY_URL_SECRET_KEY');
    expect(out).not.toContain('header-secret-value');
    expect(out).not.toContain('bearer-secret-token');
    expect(out).toContain('?key=***&foo=1');
  });

  it('describes and truncates long error messages safely', () => {
    registerSecret('TOP_SECRET_TOKEN');
    const err = new Error(`Failure with TOP_SECRET_TOKEN: ${'a'.repeat(1200)}`);
    const desc = describeError(err);
    expect(desc).not.toContain('TOP_SECRET_TOKEN');
    expect(desc.length).toBeLessThanOrEqual(1001);
    expect(desc.endsWith('…')).toBe(true);
  });

  it('extracts HTTP status codes from diverse error shapes', () => {
    expect(getStatus({ status: 429 })).toBe(429);
    expect(getStatus({ response: { status: 503 } })).toBe(503);
    expect(getStatus({ code: '401' })).toBe(401);
    expect(getStatus({ status: 999 })).toBeUndefined();
    expect(getStatus(null)).toBeUndefined();
    expect(getStatus('boom')).toBeUndefined();
  });
});

