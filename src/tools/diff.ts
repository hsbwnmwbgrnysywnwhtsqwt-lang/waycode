/**
 * Minimal line-based unified diff, good enough for a human-readable preview in
 * the chat UI. Not intended to be applied by patch tools — edits are applied by
 * writing the resulting file directly.
 */

/**
 * Above this many lines a file counts as "large": we stop printing every
 * unchanged line as context and switch to hunks, so a one-line edit in a
 * 5,000-line file is a readable preview instead of the entire file.
 */
const FULL_CONTEXT_MAX_LINES = 400;
/** Unchanged lines kept around each change once we are in hunk mode. */
const HUNK_CONTEXT = 3;
/** Hard cap on the rendered preview — it is posted to the webview verbatim. */
const MAX_DIFF_LINES = 600;
/**
 * Ceiling on the LCS table. The table is O(before × after), so a write_file on
 * a large file used to allocate hundreds of millions of cells and hang (or kill)
 * the extension host. Past this size we fall back to a coarse replace block,
 * which is all a preview needs anyway.
 */
const MAX_LCS_CELLS = 4_000_000;

export function makeDiff(before: string, after: string, filename: string): string {
  const a = before.split("\n");
  const b = after.split("\n");

  // An identical head and tail is the common case for a targeted edit. Trimming
  // them first keeps the LCS table small enough to matter even on big files.
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) {
    tail++;
  }

  const lines: string[] = [];
  for (let i = 0; i < head; i++) lines.push(`  ${a[i]}`);
  lines.push(...diffMiddle(a.slice(head, a.length - tail), b.slice(head, b.length - tail)));
  for (let i = a.length - tail; i < a.length; i++) lines.push(`  ${a[i]}`);

  const body = a.length + b.length > FULL_CONTEXT_MAX_LINES ? condense(lines) : lines;
  return [`--- ${filename}`, `+++ ${filename}`, ...cap(body)].join("\n");
}

/** Diff the part that actually differs — exactly, when that is affordable. */
function diffMiddle(a: string[], b: string[]): string[] {
  const out: string[] = [];
  if (!a.length && !b.length) return out;
  if (a.length * b.length > MAX_LCS_CELLS) {
    // Too large to align line by line — show it as a wholesale replacement.
    for (const line of a) out.push(`- ${line}`);
    for (const line of b) out.push(`+ ${line}`);
    return out;
  }
  let i = 0;
  let j = 0;
  for (const [ai, bj] of longestCommonSubsequence(a, b)) {
    while (i < ai) out.push(`- ${a[i++]}`);
    while (j < bj) out.push(`+ ${b[j++]}`);
    out.push(`  ${a[i]}`);
    i++;
    j++;
  }
  while (i < a.length) out.push(`- ${a[i++]}`);
  while (j < b.length) out.push(`+ ${b[j++]}`);
  return out;
}

/** Drop unchanged runs that are far from any change, saying what was skipped. */
function condense(lines: string[]): string[] {
  const changed = lines.map((l) => l.startsWith("+") || l.startsWith("-"));
  let nextChange = Number.POSITIVE_INFINITY;
  const nearChangeAfter: number[] = new Array(lines.length);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (changed[i]) nextChange = i;
    nearChangeAfter[i] = nextChange;
  }
  let prevChange = Number.NEGATIVE_INFINITY;
  const out: string[] = [];
  let skipped = 0;
  for (let i = 0; i < lines.length; i++) {
    if (changed[i]) prevChange = i;
    const keep = i - prevChange <= HUNK_CONTEXT || nearChangeAfter[i] - i <= HUNK_CONTEXT;
    if (!keep) {
      skipped++;
      continue;
    }
    if (skipped) {
      out.push(skippedMarker(skipped));
      skipped = 0;
    }
    out.push(lines[i]);
  }
  if (skipped) out.push(skippedMarker(skipped));
  return out;
}

function skippedMarker(n: number): string {
  return `@@ ${n} unchanged line${n === 1 ? "" : "s"} @@`;
}

/** Never hand the webview an unbounded preview. */
function cap(lines: string[]): string[] {
  if (lines.length <= MAX_DIFF_LINES) return lines;
  return [
    ...lines.slice(0, MAX_DIFF_LINES),
    `@@ preview truncated — ${lines.length - MAX_DIFF_LINES} more lines @@`,
  ];
}

/** Returns matched index pairs [i,j] of equal lines, in order. */
function longestCommonSubsequence(a: string[], b: string[]): Array<[number, number]> {
  const n = a.length;
  const m = b.length;
  // A flat table rather than n+1 JS arrays, so the memory cost is predictable
  // and stays inside the MAX_LCS_CELLS budget checked by the caller.
  const width = m + 1;
  const dp = new Int32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * width + j] =
        a[i] === b[j]
          ? dp[(i + 1) * width + j + 1] + 1
          : Math.max(dp[(i + 1) * width + j], dp[i * width + j + 1]);
    }
  }
  const pairs: Array<[number, number]> = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      pairs.push([i, j]);
      i++;
      j++;
    } else if (dp[(i + 1) * width + j] >= dp[i * width + j + 1]) {
      i++;
    } else {
      j++;
    }
  }
  return pairs;
}
