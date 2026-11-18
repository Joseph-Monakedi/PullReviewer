import { describe, expect, it } from 'vitest';
import type { ReviewedFile } from '../src/diff/extract.js';
import { ResponseValidationError } from '../src/errors.js';
import { stripCodeFences, validateAndGroundReview } from '../src/review/validate.js';

const reviewedFiles: ReviewedFile[] = [
  {
    filename: 'src/auth.ts',
    status: 'modified',
    additions: 5,
    deletions: 1,
    annotatedPatch: '10   | const x = 1;\n11 + | const y = 2;',
    visibleLines: new Set([10, 11]),
    addedLines: new Set([11]),
  },
  {
    filename: 'src/db.ts',
    status: 'modified',
    additions: 2,
    deletions: 0,
    annotatedPatch: '20 + | db.query(raw);',
    visibleLines: new Set([20]),
    addedLines: new Set([20]),
  },
];

describe('validateAndGroundReview', () => {
  it('parses fenced JSON, drops hallucinated files, nulls unseen lines, and sorts/caps findings', () => {
    const payload = {
      summary: 'Found a SQL injection issue and a minor style note.',
      risk_level: 'high',
      findings: [
        {
          file: 'src/auth.ts',
          line: 999, // not in visibleLines -> should be nulled
          severity: 'low',
          category: 'style',
          title: 'Prefer const',
          description: 'Minor style suggestion.',
          impact: 'Low impact',
          suggestion: 'Use const',
          evidence: 'let y = 2;',
        },
        {
          file: 'src/nonexistent.ts', // not in reviewedFiles -> should be dropped
          line: 1,
          severity: 'critical',
          category: 'bug',
          title: 'Hallucinated file',
          description: 'Does not exist in PR.',
          impact: 'None',
          suggestion: 'None',
          evidence: '',
        },
        {
          file: './src/db.ts',
          line: 20, // valid visible line
          severity: 'critical',
          category: 'security',
          title: 'SQL Injection',
          description: 'Unparameterised query.',
          impact: 'Arbitrary database read/write.',
          suggestion: 'Use parameterised queries.',
          evidence: 'db.query(raw);',
        },
        {
          file: 'src/auth.ts',
          line: 11,
          severity: 'medium',
          category: 'bug',
          title: 'Missing null check',
          description: 'Check null.',
          impact: 'TypeError at runtime.',
          suggestion: 'Guard against null.',
          evidence: 'const y = 2;',
        },
      ],
      positive_observations: ['Good modular structure.'],
    };

    const fenced = '```json\n' + JSON.stringify(payload, null, 2) + '\n```';
    expect(stripCodeFences(fenced)).toBe(JSON.stringify(payload, null, 2));

    const result = validateAndGroundReview(fenced, reviewedFiles, 2);

    expect(result.riskLevel).toBe('high');
    expect(result.discardedFindingsCount).toBe(1);
    expect(result.nulledLineCount).toBe(1);
    expect(result.cappedFindingsCount).toBe(1); // 3 valid findings capped to maxFindings=2
    expect(result.findings).toHaveLength(2);
    // Sorted critical first, then medium (low was capped out)
    expect(result.findings[0]?.severity).toBe('critical');
    expect(result.findings[0]?.file).toBe('src/db.ts');
    expect(result.findings[0]?.line).toBe(20);
    expect(result.findings[1]?.severity).toBe('medium');
    expect(result.findings[1]?.line).toBe(11);
  });

  it('nulls unseen line numbers while keeping the file-level finding', () => {
    const payload = {
      summary: 'Summary.',
      risk_level: 'low',
      findings: [
        {
          file: 'src/auth.ts',
          line: 404,
          severity: 'low',
          category: 'maintainability',
          title: 'File-level note',
          description: 'Line 404 is not in the hunk.',
          impact: '',
          suggestion: '',
          evidence: '',
        },
      ],
      positive_observations: [],
    };

    const result = validateAndGroundReview(JSON.stringify(payload), reviewedFiles, 10);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.line).toBeNull();
    expect(result.nulledLineCount).toBe(1);
  });

  it('throws ResponseValidationError on malformed JSON or schema mismatch', () => {
    expect(() => validateAndGroundReview('{not json', reviewedFiles, 10)).toThrow(
      ResponseValidationError,
    );
    expect(() =>
      validateAndGroundReview(
        JSON.stringify({ summary: '', risk_level: 'invalid_risk', findings: [] }),
        reviewedFiles,
        10,
      ),
    ).toThrow(ResponseValidationError);
  });
});

