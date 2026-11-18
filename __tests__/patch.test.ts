import { describe, expect, it } from 'vitest';
import { annotatePatch, parsePatch } from '../src/diff/patch.js';

describe('parsePatch & annotatePatch', () => {
  it('parses hunks, tracks visible and added new-side lines, and formats line gutter', () => {
    const rawPatch = [
      '@@ -10,4 +10,5 @@ export function greet(name: string) {',
      '   const prefix = "Hello";',
      '-  return prefix + " " + name;',
      '+  const trimmed = name.trim();',
      '+  return `${prefix}, ${trimmed}!`;',
      ' }',
      '',
    ].join('\n');

    const parsed = parsePatch(rawPatch);
    expect(parsed.hunks).toHaveLength(1);
    expect([...parsed.visibleLines]).toEqual([10, 11, 12, 13]);
    expect([...parsed.addedLines]).toEqual([11, 12]);

    const annotated = annotatePatch(parsed);
    expect(annotated).toBe(
      [
        '@@ -10,4 +10,5 @@ export function greet(name: string) {',
        '10   |   const prefix = "Hello";',
        '   - |   return prefix + " " + name;',
        '11 + |   const trimmed = name.trim();',
        '12 + |   return `${prefix}, ${trimmed}!`;',
        '13   | }',
      ].join('\n'),
    );
  });

  it('handles deletions-only hunks and "\\ No newline at end of file" markers', () => {
    const rawPatch = [
      '@@ -1,3 +0,0 @@',
      '-line one',
      '-line two',
      '-line three',
      '\\ No newline at end of file',
    ].join('\r\n');

    const parsed = parsePatch(rawPatch);
    expect(parsed.hunks).toHaveLength(1);
    expect(parsed.visibleLines.size).toBe(0);
    expect(parsed.addedLines.size).toBe(0);

    const annotated = annotatePatch(parsed);
    expect(annotated).toContain('- | line one');
    expect(annotated).toContain('\\ No newline at end of file');
  });
});

