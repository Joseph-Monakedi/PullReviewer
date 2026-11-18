/**
 * Unified-diff patch parsing.
 *
 * GitHub's `patch` field contains hunks only (no file headers). We re-render
 * each hunk with explicit new-file line numbers so Gemini can cite lines
 * accurately, and we record which new-side lines are visible so we can reject
 * line numbers the model invents.
 */

export type DiffLineType = 'add' | 'del' | 'context' | 'meta';

export interface DiffLine {
  type: DiffLineType;
  content: string;
  oldLine?: number;
  newLine?: number;
}

export interface Hunk {
  header: string;
  oldStart: number;
  newStart: number;
  lines: DiffLine[];
}

export interface ParsedPatch {
  hunks: Hunk[];
  /** New-side line numbers that appear in the diff (added or context lines). */
  visibleLines: Set<number>;
  /** New-side line numbers that were added or modified. */
  addedLines: Set<number>;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

export function parsePatch(patch: string): ParsedPatch {
  const hunks: Hunk[] = [];
  const visibleLines = new Set<number>();
  const addedLines = new Set<number>();
  let current: Hunk | undefined;
  let oldLine = 0;
  let newLine = 0;

  for (const raw of patch.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    const header = HUNK_HEADER.exec(line);
    if (header) {
      oldLine = Number(header[1]);
      newLine = Number(header[3]);
      current = { header: line, oldStart: oldLine, newStart: newLine, lines: [] };
      hunks.push(current);
      continue;
    }
    if (!current) continue; // ignore anything before the first hunk

    const marker = line.charAt(0);
    const content = line.slice(1);
    if (marker === '+') {
      current.lines.push({ type: 'add', content, newLine });
      visibleLines.add(newLine);
      addedLines.add(newLine);
      newLine++;
    } else if (marker === '-') {
      current.lines.push({ type: 'del', content, oldLine });
      oldLine++;
    } else if (marker === '\\') {
      current.lines.push({ type: 'meta', content: line });
    } else if (marker === ' ' || line === '') {
      // A bare empty line can appear when trailing whitespace was stripped.
      if (line === '' && current.lines.length === 0) continue;
      current.lines.push({ type: 'context', content, oldLine, newLine });
      visibleLines.add(newLine);
      oldLine++;
      newLine++;
    }
  }

  // Drop the phantom context line produced by a trailing newline in the patch text.
  const lastHunk = hunks.at(-1);
  const last = lastHunk?.lines.at(-1);
  if (lastHunk && last && last.type === 'context' && last.content === '' && /\n\r?$/.test(patch)) {
    lastHunk.lines.pop();
    if (last.newLine !== undefined) visibleLines.delete(last.newLine);
  }

  return { hunks, visibleLines, addedLines };
}

/**
 * Render a patch with a line-number gutter, e.g.
 *
 *     @@ -10,3 +10,4 @@ function foo()
 *       10   | const a = 1;
 *       11 + | const b = 2;
 *          - | const c = 3;
 */
export function annotatePatch(parsed: ParsedPatch): string {
  let maxLine = 1;
  for (const hunk of parsed.hunks) {
    for (const line of hunk.lines) {
      if (line.newLine !== undefined && line.newLine > maxLine) maxLine = line.newLine;
    }
  }
  const width = String(maxLine).length;
  const out: string[] = [];
  for (const hunk of parsed.hunks) {
    out.push(hunk.header);
    for (const line of hunk.lines) {
      switch (line.type) {
        case 'add':
          out.push(`${String(line.newLine).padStart(width)} + | ${line.content}`);
          break;
        case 'context':
          out.push(`${String(line.newLine).padStart(width)}   | ${line.content}`);
          break;
        case 'del':
          out.push(`${' '.repeat(width)} - | ${line.content}`);
          break;
        case 'meta':
          out.push(`${' '.repeat(width)}   ${line.content}`);
          break;
      }
    }
  }
  return out.join('\n');
}
