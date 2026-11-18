/**
 * Parse, validate, ground, and normalise the raw JSON returned by Gemini.
 *
 * Grounding rules:
 * - Any finding whose `file` is not in the reviewed file set is discarded and
 *   counted in `discardedFindingsCount`.
 * - Any finding whose `line` is not in that file's `visibleLines` set has its
 *   `line` reset to `null` (preserving the file-level finding) and is counted
 *   in `nulledLineCount`.
 */
import type { ReviewedFile } from '../diff/extract.js';
import { ResponseValidationError } from '../errors.js';
import {
  RawReviewResponseSchema,
  SEVERITY_RANK,
  type ValidatedFinding,
  type ValidatedReview,
} from './schema.js';

const FIELD_CAPS = {
  summary: 2_000,
  title: 200,
  description: 2_000,
  impact: 1_000,
  suggestion: 2_000,
  evidence: 1_000,
  positiveObservation: 500,
  maxPositiveObservations: 10,
} as const;

/** Strip optional ```json ... ``` fences around a JSON object. */
export function stripCodeFences(raw: string): string {
  const trimmed = raw.trim();
  const match = /^```(?:json|JSON)?\s*\r?\n([\s\S]*?)\r?\n```\s*$/.exec(trimmed);
  if (match && match[1] !== undefined) {
    return match[1].trim();
  }
  return trimmed;
}

function capString(value: string, maxLen: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= maxLen) return trimmed;
  return `${trimmed.slice(0, maxLen - 1)}…`;
}

function normalizePath(path: string): string {
  return path.trim().replace(/^(?:\.\/|\/)+/, '');
}

export function validateAndGroundReview(
  rawText: string,
  reviewedFiles: readonly ReviewedFile[],
  maxFindings: number,
): ValidatedReview {
  const cleaned = stripCodeFences(rawText);

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(cleaned);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new ResponseValidationError(`Model response is not valid JSON: ${message}`);
  }

  const result = RawReviewResponseSchema.safeParse(parsedJson);
  if (!result.success) {
    const issues = result.error.issues
      .slice(0, 5)
      .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
      .join('; ');
    throw new ResponseValidationError(`Model response failed schema validation: ${issues}`);
  }

  const data = result.data;
  const fileMap = new Map<string, ReviewedFile>();
  for (const file of reviewedFiles) {
    fileMap.set(normalizePath(file.filename), file);
  }

  let discardedFindingsCount = 0;
  let nulledLineCount = 0;
  const grounded: ValidatedFinding[] = [];

  for (const finding of data.findings) {
    const normalizedFile = normalizePath(finding.file);
    const matchedFile = fileMap.get(normalizedFile);
    if (!matchedFile) {
      discardedFindingsCount++;
      continue;
    }

    let groundedLine: number | null = finding.line ?? null;
    if (groundedLine !== null && !matchedFile.visibleLines.has(groundedLine)) {
      groundedLine = null;
      nulledLineCount++;
    }

    grounded.push({
      file: matchedFile.filename,
      line: groundedLine,
      severity: finding.severity,
      category: finding.category,
      title: capString(finding.title, FIELD_CAPS.title).replace(/[\r\n]+/g, ' '),
      description: capString(finding.description, FIELD_CAPS.description),
      impact: capString(finding.impact, FIELD_CAPS.impact),
      suggestion: capString(finding.suggestion, FIELD_CAPS.suggestion),
      evidence: capString(finding.evidence, FIELD_CAPS.evidence),
    });
  }

  grounded.sort((a, b) => {
    const rankDiff = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
    if (rankDiff !== 0) return rankDiff;
    const fileDiff = a.file.localeCompare(b.file);
    if (fileDiff !== 0) return fileDiff;
    return (a.line ?? 0) - (b.line ?? 0);
  });

  const cappedFindingsCount = Math.max(0, grounded.length - maxFindings);
  const findings = grounded.slice(0, maxFindings);

  const positiveObservations = data.positive_observations
    .map((item) => capString(item, FIELD_CAPS.positiveObservation))
    .filter((item) => item.length > 0)
    .slice(0, FIELD_CAPS.maxPositiveObservations);

  return {
    summary: capString(data.summary, FIELD_CAPS.summary),
    riskLevel: data.risk_level,
    findings,
    positiveObservations,
    discardedFindingsCount,
    nulledLineCount,
    cappedFindingsCount,
  };
}

