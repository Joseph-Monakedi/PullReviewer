import { describe, expect, it } from 'vitest';
import { type PullRequestFile, extractDiff } from '../src/diff/extract.js';
import { FileFilter } from '../src/diff/filters.js';

const samplePatch = '@@ -1,2 +1,2 @@\n-const a = 1;\n+const a = 2;\n export default a;';

describe('extractDiff', () => {
  it('categorises ignored, binary, patchless, max_files, and budget-exceeded files', () => {
    const files: PullRequestFile[] = [
      {
        filename: 'package-lock.json',
        status: 'modified',
        additions: 100,
        deletions: 100,
        changes: 200,
        patch: samplePatch,
      },
      {
        filename: 'assets/custom.dat2',
        status: 'added',
        additions: 0,
        deletions: 0,
        changes: 0,
      },
      {
        filename: 'src/binary-inline.txt',
        status: 'modified',
        additions: 1,
        deletions: 0,
        changes: 1,
        patch: '@@ -1 +1 @@\n+hello\0world',
      },
      {
        filename: 'src/renamed-only.ts',
        previous_filename: 'src/old-name.ts',
        status: 'renamed',
        additions: 0,
        deletions: 0,
        changes: 0,
      },
      {
        filename: 'src/oversized.ts',
        status: 'modified',
        additions: 50,
        deletions: 0,
        changes: 50,
        patch: `@@ -1,1 +1,1 @@\n+${'x'.repeat(500)}`,
      },
      {
        filename: 'src/fits-one.ts',
        status: 'modified',
        additions: 1,
        deletions: 1,
        changes: 2,
        patch: samplePatch,
      },
      {
        filename: 'src/fits-two.ts',
        status: 'modified',
        additions: 1,
        deletions: 1,
        changes: 2,
        patch: samplePatch,
      },
    ];

    const result = extractDiff(files, {
      filter: new FileFilter(),
      maxFiles: 1,
      maxDiffChars: 200,
    });

    expect(result.reviewed.map((f) => f.filename)).toEqual(['src/fits-one.ts']);
    expect(result.excluded).toEqual([
      { filename: 'package-lock.json', reason: 'ignored' },
      { filename: 'assets/custom.dat2', reason: 'binary' },
      { filename: 'src/binary-inline.txt', reason: 'binary' },
      { filename: 'src/renamed-only.ts', reason: 'no_patch' },
      { filename: 'src/oversized.ts', reason: 'budget' },
      { filename: 'src/fits-two.ts', reason: 'max_files' },
    ]);
    expect(result.reachedGitHubFileLimit).toBe(false);
  });

  it('flags when GitHub file list reaches the 3,000-file ceiling', () => {
    const manyFiles: PullRequestFile[] = Array.from({ length: 3000 }, (_, i) => ({
      filename: `src/file-${i}.ts`,
      status: 'modified',
      additions: 0,
      deletions: 0,
      changes: 0,
    }));

    const result = extractDiff(manyFiles, {
      filter: new FileFilter(),
      maxFiles: 5,
      maxDiffChars: 10_000,
    });
    expect(result.reachedGitHubFileLimit).toBe(true);
  });
});

