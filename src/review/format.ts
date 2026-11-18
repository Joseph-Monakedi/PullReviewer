/**
 * Render a validated review (or a skipped/failure notice) as safe GitHub Markdown.
 *
 * Security invariants:
 * - Model-generated strings are sanitised: raw HTML is escaped, `@mentions` and
 *   `#123` references are neutralised with a zero-width joiner, remote images
 *   and arbitrary links are stripped, and code excerpts use dynamically sized
 *   fences so embedded backticks cannot break out.
 * - Only file links constructed by this module (pointing to the PR's `headSha`
 *   on `github.com`) are emitted as live links.
 * - Total comment length is capped below GitHub's 65,536-character limit,
 *   truncating lower-severity findings first.
 */
import {
  EXCLUSION_REASON_LABELS,
  type ExtractedDiff,
} from '../diff/extract.js';
import { redact } from '../errors.js';
import type { TokenUsage } from '../gemini/client.js';
import type {
  RiskLevel,
  Severity,
  ValidatedFinding,
  ValidatedReview,
} from './schema.js';
import { SEVERITIES } from './schema.js';

export const COMMENT_MARKER = '<!-- gemini-pr-reviewer:v1 -->';
export const MAX_COMMENT_CHARS = 62_000;

const ZERO_WIDTH_JOINER = '\u200D';

const SEVERITY_LABELS: Record<Severity, string> = {
  critical: '🔴 Critical',
  high: '🟠 High',
  medium: '🟡 Medium',
  low: '🔵 Low',
};

const RISK_BADGES: Record<RiskLevel, string> = {
  low: '🟢 Low',
  medium: '🟡 Medium',
  high: '🟠 High',
  critical: '🔴 Critical',
};

export interface FormatCommonContext {
  commentTitle: string;
  owner: string;
  repo: string;
  headSha: string;
  model: string;
  extracted: ExtractedDiff;
}

export interface FormatReviewOptions extends FormatCommonContext {
  review: ValidatedReview;
  usage?: TokenUsage;
}

export interface FormatFailureOptions extends FormatCommonContext {
  errorMessage: string;
}

/**
 * Sanitise untrusted prose (from the model or PR) so it is safe to embed in a
 * GitHub comment without triggering notifications, rendering raw HTML, or
 * loading external images.
 */
export function sanitizeMarkdownText(input: string): string {
  let text = redact(input);

  // Strip Markdown images: ![alt](url) -> [image removed: alt]
  text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, (_m, alt: string) =>
    alt.trim() ? `[image removed: ${alt.trim()}]` : '[image removed]',
  );

  // Neutralise external Markdown links: [label](https://...) -> label
  text = text.replace(/\[([^\]]+)\]\(\s*(?:https?:|mailto:|javascript:|data:)[^)]*\)/gi, '$1');

  // Escape HTML angle brackets so raw tags and HTML comments cannot be injected.
  text = text.replace(/</g, '&lt;').replace(/>/g, '&gt;');

  // Neutralise @mentions and #123 issue/PR auto-references with a zero-width joiner.
  text = text.replace(/(^|[^\w/])@([A-Za-z0-9][A-Za-z0-9-]{0,38})/g, `$1@${ZERO_WIDTH_JOINER}$2`);
  text = text.replace(/(^|[^\w&])#(\d+)/g, `$1#${ZERO_WIDTH_JOINER}$2`);

  return text;
}

/** Wrap a snippet in a fenced block whose fence is longer than any backtick run inside. */
export function fenceCode(code: string, language = ''): string {
  const safeCode = redact(code).replace(/\r\n/g, '\n').trimEnd();
  let maxBackticks = 2;
  const matches = safeCode.match(/`+/g);
  if (matches) {
    for (const run of matches) {
      if (run.length > maxBackticks) maxBackticks = run.length;
    }
  }
  const fence = '`'.repeat(maxBackticks + 1);
  return `${fence}${language}\n${safeCode}\n${fence}`;
}

/** Build a safe GitHub blob URL for a repository path at a specific commit SHA. */
export function buildBlobUrl(
  owner: string,
  repo: string,
  headSha: string,
  filePath: string,
  line: number | null,
): string {
  const encodedPath = filePath
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
  const base = `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/blob/${encodeURIComponent(headSha)}/${encodedPath}`;
  return line !== null && line > 0 ? `${base}#L${line}` : base;
}

function renderFinding(
  finding: ValidatedFinding,
  owner: string,
  repo: string,
  headSha: string,
): string {
  const url = buildBlobUrl(owner, repo, headSha, finding.file, finding.line);
  const locationLabel = finding.line !== null ? `${finding.file}:${finding.line}` : finding.file;
  const title = sanitizeMarkdownText(finding.title);
  const description = sanitizeMarkdownText(finding.description);
  const parts: string[] = [
    `#### ${SEVERITY_LABELS[finding.severity]} · \`${finding.category}\` — ${title}`,
    `**Location:** [\`${locationLabel}\`](${url})`,
    '',
    description,
  ];

  if (finding.impact) {
    parts.push('', `**Impact:** ${sanitizeMarkdownText(finding.impact)}`);
  }
  if (finding.suggestion) {
    parts.push('', `**Suggestion:** ${sanitizeMarkdownText(finding.suggestion)}`);
  }
  if (finding.evidence) {
    parts.push('', '**Evidence:**', fenceCode(finding.evidence));
  }

  return parts.join('\n');
}

function renderScopeSection(
  extracted: ExtractedDiff,
  discardedFindingsCount = 0,
  cappedFindingsCount = 0,
): string {
  const reviewedCount = extracted.reviewed.length;
  const excludedCount = extracted.excluded.length;
  const lines: string[] = [
    '<details>',
    `<summary>Review scope (${reviewedCount} file${reviewedCount === 1 ? '' : 's'} reviewed, ${excludedCount} excluded)</summary>`,
    '',
  ];

  if (extracted.reachedGitHubFileLimit) {
    lines.push(
      '> **Note:** This pull request reached GitHub\'s 3,000-file listing ceiling; files beyond the first 3,000 are not visible to the action.',
      '',
    );
  }

  if (reviewedCount > 0) {
    lines.push('**Reviewed files:**');
    for (const file of extracted.reviewed.slice(0, 100)) {
      lines.push(`- \`${file.filename}\` (+${file.additions}/-${file.deletions})`);
    }
    if (reviewedCount > 100) {
      lines.push(`- _…and ${reviewedCount - 100} more reviewed file(s)._`);
    }
    lines.push('');
  }

  if (excludedCount > 0) {
    lines.push('**Excluded files:**');
    for (const item of extracted.excluded.slice(0, 100)) {
      lines.push(`- \`${item.filename}\` — ${EXCLUSION_REASON_LABELS[item.reason]}`);
    }
    if (excludedCount > 100) {
      lines.push(`- _…and ${excludedCount - 100} more excluded file(s)._`);
    }
    lines.push('');
  }

  if (discardedFindingsCount > 0) {
    lines.push(
      `_Note: ${discardedFindingsCount} finding(s) referencing files outside the reviewed diff were discarded._`,
      '',
    );
  }
  if (cappedFindingsCount > 0) {
    lines.push(
      `_Note: ${cappedFindingsCount} additional finding(s) were omitted due to the configured \`max_findings\` cap._`,
      '',
    );
  }

  lines.push('</details>');
  return lines.join('\n');
}

function renderFooter(model: string, headSha: string, usage?: TokenUsage): string {
  const shortSha = headSha.slice(0, 7);
  const usageBit =
    usage?.totalTokens !== undefined
      ? ` · Tokens: ${usage.promptTokens ?? '?'} in / ${usage.candidateTokens ?? '?'} out (${usage.totalTokens} total)`
      : '';
  return [
    '---',
    `_Model: \`${sanitizeMarkdownText(model)}\` · Commit: \`${shortSha}\`${usageBit} · AI-generated review (advisory only — verify findings before acting)._`,
  ].join('\n');
}

function assembleReviewBody(
  options: FormatReviewOptions,
  includedFindings: readonly ValidatedFinding[],
  omittedForSizeCount: number,
): string {
  const { commentTitle, owner, repo, headSha, model, extracted, review, usage } = options;

  const counts: Record<Severity, number> = {
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
  };
  for (const f of review.findings) {
    counts[f.severity]++;
  }
  const totalFindings = review.findings.length;

  const sections: string[] = [
    COMMENT_MARKER,
    `## ${sanitizeMarkdownText(commentTitle)}`,
    '',
    `**Overall Risk:** ${RISK_BADGES[review.riskLevel]}`,
    '',
    sanitizeMarkdownText(review.summary),
    '',
    '| Severity | Count |',
    '| :--- | ---: |',
    `| ${SEVERITY_LABELS.critical} | ${counts.critical} |`,
    `| ${SEVERITY_LABELS.high} | ${counts.high} |`,
    `| ${SEVERITY_LABELS.medium} | ${counts.medium} |`,
    `| ${SEVERITY_LABELS.low} | ${counts.low} |`,
    `| **Total** | **${totalFindings}** |`,
  ];

  if (includedFindings.length === 0 && totalFindings === 0) {
    sections.push('', '✅ **No actionable issues found in the reviewed diff.**');
  } else {
    sections.push('', '### Findings');
    for (const severity of SEVERITIES) {
      const group = includedFindings.filter((f) => f.severity === severity);
      if (group.length === 0) continue;
      for (const finding of group) {
        sections.push('', renderFinding(finding, owner, repo, headSha));
      }
    }
    if (omittedForSizeCount > 0) {
      sections.push(
        '',
        `_${omittedForSizeCount} lower-severity finding(s) omitted to stay within GitHub's comment size limit._`,
      );
    }
  }

  if (review.positiveObservations.length > 0) {
    sections.push('', '### Positive Observations');
    for (const obs of review.positiveObservations) {
      sections.push(`- ${sanitizeMarkdownText(obs)}`);
    }
  }

  sections.push(
    '',
    renderScopeSection(extracted, review.discardedFindingsCount, review.cappedFindingsCount),
    '',
    renderFooter(model, headSha, usage),
  );

  return sections.join('\n');
}

export function formatReviewComment(options: FormatReviewOptions): string {
  const findings = [...options.review.findings];
  let body = assembleReviewBody(options, findings, 0);

  // Drop lowest-severity findings (which are already sorted last) until within budget.
  while (body.length > MAX_COMMENT_CHARS && findings.length > 0) {
    findings.pop();
    const omitted = options.review.findings.length - findings.length;
    body = assembleReviewBody(options, findings, omitted);
  }

  if (body.length > MAX_COMMENT_CHARS) {
    const footer = `\n\n…_[comment truncated to fit GitHub's size limit]_\n\n${renderFooter(options.model, options.headSha, options.usage)}`;
    body = `${body.slice(0, MAX_COMMENT_CHARS - footer.length)}${footer}`;
  }

  return body;
}

export function formatSkippedReviewComment(options: FormatCommonContext): string {
  const { commentTitle, model, headSha, extracted } = options;
  const reason =
    extracted.excluded.length === 0
      ? 'This pull request contains no changed files.'
      : `All ${extracted.excluded.length} changed file(s) in this pull request were excluded by filter or budget rules, so no diff was sent to Gemini.`;

  return [
    COMMENT_MARKER,
    `## ${sanitizeMarkdownText(commentTitle)}`,
    '',
    `ℹ️ **Review skipped:** ${reason}`,
    '',
    renderScopeSection(extracted),
    '',
    renderFooter(model, headSha),
  ].join('\n');
}

export function formatFailureComment(options: FormatFailureOptions): string {
  const { commentTitle, model, headSha, extracted, errorMessage } = options;
  return [
    COMMENT_MARKER,
    `## ${sanitizeMarkdownText(commentTitle)}`,
    '',
    '⚠️ **Automated review could not be completed for this commit.**',
    '',
    `> ${sanitizeMarkdownText(errorMessage)}`,
    '',
    renderScopeSection(extracted),
    '',
    renderFooter(model, headSha),
  ].join('\n');
}

