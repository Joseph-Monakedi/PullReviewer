/**
 * Select and budget PR files for review.
 *
 * Files are filtered, parsed, annotated with new-side line numbers, and packed
 * greedily into the character budget so one oversized file does not starve
 * smaller files later in the change set.
 */
import { FileFilter } from './filters.js';
import { annotatePatch, parsePatch } from './patch.js';

export interface PullRequestFile {
  filename: string;
  previous_filename?: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
  patch?: string;
}

export interface ReviewedFile {
  filename: string;
  previousFilename?: string;
  status: string;
  additions: number;
  deletions: number;
  annotatedPatch: string;
  visibleLines: Set<number>;
  addedLines: Set<number>;
}

export type ExclusionReason = 'ignored' | 'binary' | 'no_patch' | 'max_files' | 'budget';

export const EXCLUSION_REASON_LABELS: Record<ExclusionReason, string> = {
  ignored: 'matched ignore pattern',
  binary: 'binary file',
  no_patch: 'no diff patch available (empty change, rename-only, or file diff too large)',
  max_files: 'exceeded max_files limit',
  budget: 'exceeded max_diff_chars budget',
};

export interface ExcludedFile {
  filename: string;
  reason: ExclusionReason;
}

export interface ExtractedDiff {
  reviewed: ReviewedFile[];
  excluded: ExcludedFile[];
  totalDiffChars: number;
  /** True when the PR hit GitHub's 3,000-file listing ceiling. */
  reachedGitHubFileLimit: boolean;
}

export interface ExtractOptions {
  filter: FileFilter;
  maxFiles: number;
  maxDiffChars: number;
}

const GITHUB_FILE_LIST_LIMIT = 3000;

function looksBinary(file: PullRequestFile): boolean {
  if (file.patch !== undefined) {
    return file.patch.includes('\0') || /^GIT binary patch/m.test(file.patch);
  }
  // GitHub omits `patch` with 0 line changes for binary additions/modifications.
  return (
    file.changes === 0 &&
    file.additions === 0 &&
    file.deletions === 0 &&
    (file.status === 'added' || file.status === 'modified')
  );
}

export function extractDiff(files: readonly PullRequestFile[], options: ExtractOptions): ExtractedDiff {
  const reviewed: ReviewedFile[] = [];
  const excluded: ExcludedFile[] = [];
  let totalDiffChars = 0;

  for (const file of files) {
    if (options.filter.isIgnored(file.filename)) {
      excluded.push({ filename: file.filename, reason: 'ignored' });
      continue;
    }

    if (looksBinary(file)) {
      excluded.push({ filename: file.filename, reason: 'binary' });
      continue;
    }

    if (!file.patch || file.patch.trim() === '') {
      excluded.push({ filename: file.filename, reason: 'no_patch' });
      continue;
    }

    if (reviewed.length >= options.maxFiles) {
      excluded.push({ filename: file.filename, reason: 'max_files' });
      continue;
    }

    const parsed = parsePatch(file.patch);
    if (parsed.hunks.length === 0) {
      excluded.push({ filename: file.filename, reason: 'no_patch' });
      continue;
    }

    const annotatedPatch = annotatePatch(parsed);
    if (totalDiffChars + annotatedPatch.length > options.maxDiffChars) {
      excluded.push({ filename: file.filename, reason: 'budget' });
      continue;
    }

    totalDiffChars += annotatedPatch.length;
    reviewed.push({
      filename: file.filename,
      previousFilename: file.previous_filename,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      annotatedPatch,
      visibleLines: parsed.visibleLines,
      addedLines: parsed.addedLines,
    });
  }

  return {
    reviewed,
    excluded,
    totalDiffChars,
    reachedGitHubFileLimit: files.length >= GITHUB_FILE_LIST_LIMIT,
  };
}

