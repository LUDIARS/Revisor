/**
 * @implements RV-CPP-CODE-CHECKS-02 — which lines of each changed C++ file the PR wrote.
 *
 * Findings are judged on the PR's own lines so a legacy `delete` elsewhere in a
 * touched file does not block a change that never wrote it. Files git does not
 * track yet (new, untracked) count as written in full.
 *
 * SRP: turning a zero-context diff into per-file written line ranges.
 */

/** Paths whose language the Anatomia C++ checks judge (plain `.c` is out of scope there too). */
export const CPP_SOURCE = /\.(?:cc|cpp|cxx|c\+\+|h|hh|hpp|hxx|h\+\+|inl|ipp)$/i;

const FILE_HEADER = /^\+\+\+ b\/(.+)$/;
const HUNK = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;

/**
 * Parse `git diff -U0` output into `file -> [[start, end], ...]` (1-based,
 * inclusive). Pure deletions (`+N,0`) write no line and add no range.
 */
export function parseWrittenLines(diffText) {
  const written = new Map();
  let current = null;
  for (const line of String(diffText).split(/\r?\n/)) {
    const header = FILE_HEADER.exec(line);
    if (header) {
      current = header[1];
      if (!written.has(current)) written.set(current, []);
      continue;
    }
    const hunk = HUNK.exec(line);
    if (!hunk || current === null) continue;
    const start = Number(hunk[1]);
    const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
    if (count > 0) written.get(current).push([start, start + count - 1]);
  }
  return written;
}

/** True when `line` of `file` was written by the PR. `WHOLE_FILE` marks untracked files. */
export const WHOLE_FILE = Object.freeze([[1, Number.MAX_SAFE_INTEGER]]);

export function isWrittenLine(written, file, line) {
  const ranges = written.get(file);
  return Array.isArray(ranges) && ranges.some(([start, end]) => line >= start && line <= end);
}
