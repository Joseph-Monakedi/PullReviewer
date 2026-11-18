import { describe, expect, it } from 'vitest';
import type { ExtractedDiff } from '../src/diff/extract.js';
import {
  COMMENT_MARKER,
  MAX_COMMENT_CHARS,
  fenceCode,
  formatFailureComment,
  formatReviewComment,
  formatSkippedReviewComment,
  sanitizeMarkdownText,
} from '../src/review/format.js';
import type { ValidatedFinding, ValidatedReview } from '../src/review/schema.js';

const sampleExtracted: ExtractedDiff = {
  reviewed: [
    {
      filename: 'src/index.ts',
      status: 'modified',
      additions: 10,
      deletions: 2,
      annotatedPatch: '1 + | const x = 1;',
      visibleLines: new Set([1]),
      addedLines: new Set([1]),
    },
  ],
  excluded: [{ filename: 'package-lock.json', reason: 'ignored' }],
  totalDiffChars: 16,
  reachedGitHubFileLimit: false,
};

describe('formatReviewComment & sanitisation', () => {
  it('neutralises @mentions, #refs, raw HTML, external links, and remote images', () => {
    const raw =
      'Hey @alice and #42! <script>alert(1)</script> ![pixel](https://evil.example/track.png) [phish](https://evil.example/login)';
    const clean = sanitizeMarkdownText(raw);

    expect(clean).not.toContain('<script>');
    expect(clean).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(clean).not.toContain('https://evil.example/track.png');
    expect(clean).toContain('[image removed: pixel]');
    expect(clean).not.toContain('https://evil.example/login');
    expect(clean).toContain('phish');
    // @alice and #42 have zero-width joiners inserted
    expect(clean).toContain('@\u200Dalice');
    expect(clean).toContain('#\u200D42');
  });

  it('expands code fence length when evidence contains triple backticks', () => {
    const fenced = fenceCode('const a = ```hello```;');
    expect(fenced.startsWith('````\n')).toBe(true);
    expect(fenced.endsWith('\n````')).toBe(true);
  });

  it('renders findings grouped by severity with blob links, scope details, and footer', () => {
    const review: ValidatedReview = {
      summary: 'Overall clean with one high-severity issue.',
      riskLevel: 'high',
      findings: [
        {
          file: 'src/index.ts',
          line: 1,
          severity: 'high',
          category: 'security',
          title: 'Hardcoded token',
          description: 'Do not commit tokens.',
          impact: 'Credential exposure.',
          suggestion: 'Read from process.env.',
          evidence: 'const x = 1;',
        },
      ],
      positiveObservations: ['Good unit test coverage.'],
      discardedFindingsCount: 1,
      nulledLineCount: 0,
      cappedFindingsCount: 0,
    };

    const md = formatReviewComment({
      commentTitle: 'Gemini AI Code Review',
      owner: 'acme',
      repo: 'widget',
      headSha: 'abcdef1234567890',
      model: 'gemini-3.8-flash',
      extracted: sampleExtracted,
      review,
      usage: { promptTokens: 500, candidateTokens: 150, totalTokens: 650 },
    });

    expect(md.startsWith(COMMENT_MARKER)).toBe(true);
    expect(md).toContain('## Gemini AI Code Review');
    expect(md).toContain('**Overall Risk:** 🟠 High');
    expect(md).toContain(
      '[`src/index.ts:1`](https://github.com/acme/widget/blob/abcdef1234567890/src/index.ts#L1)',
    );
    expect(md).toContain('`package-lock.json` — matched ignore pattern');
    expect(md).toContain('1 finding(s) referencing files outside the reviewed diff were discarded');
    expect(md).toContain('Commit: `abcdef1`');
    expect(md).toContain('Tokens: 500 in / 150 out (650 total)');
  });

  it('renders no-findings badge when findings array is empty', () => {
    const md = formatReviewComment({
      commentTitle: 'Gemini AI Code Review',
      owner: 'acme',
      repo: 'widget',
      headSha: 'abcdef1234567890',
      model: 'gemini-3.8-flash',
      extracted: sampleExtracted,
      review: {
        summary: 'Looks great!',
        riskLevel: 'low',
        findings: [],
        positiveObservations: [],
        discardedFindingsCount: 0,
        nulledLineCount: 0,
        cappedFindingsCount: 0,
      },
    });
    expect(md).toContain('No actionable issues found in the reviewed diff.');
  });

  it('truncates lower-severity findings first when comment exceeds MAX_COMMENT_CHARS', () => {
    const manyFindings: ValidatedFinding[] = Array.from({ length: 40 }, (_, i) => ({
      file: 'src/index.ts',
      line: 1,
      severity: i === 0 ? 'critical' : 'low',
      category: 'bug',
      title: `Finding item ${i + 1}`,
      description: 'D'.repeat(1_200),
      impact: 'I'.repeat(600),
      suggestion: 'S'.repeat(800),
      evidence: 'E'.repeat(400),
    }));

    const md = formatReviewComment({
      commentTitle: 'Gemini AI Code Review',
      owner: 'acme',
      repo: 'widget',
      headSha: 'abcdef1234567890',
      model: 'gemini-3.8-flash',
      extracted: sampleExtracted,
      review: {
        summary: 'Many findings.',
        riskLevel: 'critical',
        findings: manyFindings,
        positiveObservations: [],
        discardedFindingsCount: 0,
        nulledLineCount: 0,
        cappedFindingsCount: 0,
      },
    });

    expect(md.length).toBeLessThanOrEqual(MAX_COMMENT_CHARS);
    expect(md).toContain('Finding item 1'); // Critical finding is preserved
    expect(md).not.toContain('Finding item 40'); // Lowest-severity tail was dropped
    expect(md).toContain("lower-severity finding(s) omitted to stay within GitHub's comment size limit");
  });

  it('formats skipped and failure comments with the marker', () => {
    const skipped = formatSkippedReviewComment({
      commentTitle: 'Gemini AI Code Review',
      owner: 'acme',
      repo: 'widget',
      headSha: '1234567890abcdef',
      model: 'gemini-3.8-flash',
      extracted: {
        reviewed: [],
        excluded: [{ filename: 'yarn.lock', reason: 'ignored' }],
        totalDiffChars: 0,
        reachedGitHubFileLimit: false,
      },
    });
    expect(skipped).toContain(COMMENT_MARKER);
    expect(skipped).toContain('Review skipped:');

    const failed = formatFailureComment({
      commentTitle: 'Gemini AI Code Review',
      owner: 'acme',
      repo: 'widget',
      headSha: '1234567890abcdef',
      model: 'gemini-3.8-flash',
      extracted: sampleExtracted,
      errorMessage: 'HTTP 503 Service Unavailable',
    });
    expect(failed).toContain(COMMENT_MARKER);
    expect(failed).toContain('Automated review could not be completed');
    expect(failed).toContain('HTTP 503 Service Unavailable');
  });
});
