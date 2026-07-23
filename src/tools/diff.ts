/**
 * Minimal line-based unified diff, good enough for a human-readable preview in
 * the chat UI. Not intended to be applied by patch tools — edits are applied by
 * writing the resulting file directly.
 */
export function makeDiff(before: string, after: string, filename: string): string {
  const a = before.split("\n");
  const b = after.split("\n");
  const lcs = longestCommonSubsequence(a, b);

  const out: string[] = [`--- ${filename}`, `+++ ${filename}`];
  let i = 0;
  let j = 0;
  for (const [ai, bj] of lcs) {
    while (i < ai) out.push(`- ${a[i++]}`);
    while (j < bj) out.push(`+ ${b[j++]}`);
    out.push(`  ${a[i]}`);
    i++;
    j++;
  }
  while (i < a.length) out.push(`- ${a[i++]}`);
  while (j < b.length) out.push(`+ ${b[j++]}`);
  return out.join("\n");
}

/** Returns matched index pairs [i,j] of equal lines, in order. */
function longestCommonSubsequence(a: string[], b: string[]): Array<[number, number]> {
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
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
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      i++;
    } else {
      j++;
    }
  }
  return pairs;
}
