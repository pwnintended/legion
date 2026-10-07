/**
 * Fuzzy path matching for "Go to file" (⌘P): the query's characters must appear in order (case-insensitive,
 * whitespace ignored). Among the alignments, the best-scoring one wins: matches at the start of a path segment
 * or a word (`/`, `-`, `_`, `.`, camelCase), consecutive runs and matches in the file name score high; gaps cost.
 * Pure and dependency-free: the engine ranks with it, demo mode too.
 */

export interface FuzzyResult {
  score: number;
  /** Indexes into the text of the matched characters, ascending. */
  positions: number[];
}

const MATCH = 16;
const CONSECUTIVE = 18;
const GAP_START = 3;
const GAP_EXTEND = 1;
const BOUNDARY_SEGMENT = 14;
const BOUNDARY_WORD = 10;
const BOUNDARY_CAMEL = 8;
const IN_BASENAME = 6;
const FIRST_CHAR_MULTIPLIER = 2;

function boundaryBonus(text: string, j: number): number {
  if (j === 0) return BOUNDARY_SEGMENT;
  const prev = text[j - 1] as string;
  const cur = text[j] as string;
  if (prev === '/') return BOUNDARY_SEGMENT;
  if (prev === '-' || prev === '_' || prev === '.' || prev === ' ') return BOUNDARY_WORD;
  if (prev >= 'a' && prev <= 'z' && cur >= 'A' && cur <= 'Z') return BOUNDARY_CAMEL;
  if (!/[0-9]/.test(prev) && /[0-9]/.test(cur)) return BOUNDARY_CAMEL;
  return 0;
}

/** Score `text` against `query`; null when the query's characters don't all appear in order. */
export function fuzzyMatch(query: string, text: string): FuzzyResult | null {
  const q = query.replace(/\s+/g, '').toLowerCase();
  if (!q) return { score: 0, positions: [] };
  const lower = text.toLowerCase();
  const n = text.length;
  const m = q.length;
  if (m > n) return null;

  // Cheap rejection: is q a subsequence at all?
  for (let i = 0, j = 0; i < m; i++, j++) {
    j = lower.indexOf(q[i] as string, j);
    if (j === -1) return null;
  }

  const baseStart = text.lastIndexOf('/') + 1;
  const bonus = new Float64Array(n);
  for (let j = 0; j < n; j++) bonus[j] = boundaryBonus(text, j) + (j >= baseStart ? IN_BASENAME : 0);

  const NEG = Number.NEGATIVE_INFINITY;
  // score[i*n + j]: best score with q[i] matched at text[j]; from[i*n + j]: where q[i-1] was matched.
  const score = new Float64Array(m * n).fill(NEG);
  const from = new Int32Array(m * n).fill(-1);

  for (let j = 0; j < n; j++) {
    if (lower[j] !== q[0]) continue;
    // Leading characters skipped cost a little (prefers matches early in the segment they start).
    score[j] =
      MATCH +
      (bonus[j] as number) * FIRST_CHAR_MULTIPLIER -
      Math.min(j - baseStart >= 0 ? j - baseStart : j, 12) * 0.25;
  }
  for (let i = 1; i < m; i++) {
    const row = i * n;
    const prev = (i - 1) * n;
    const c = q[i] as string;
    let carry = NEG;
    let carryFrom = -1;
    for (let j = i; j < n; j++) {
      // Best previous match at k ≤ j-2 (a gap of j-k-1 ≥ 1), with the gap penalty applied.
      if (carry !== NEG) carry -= GAP_EXTEND;
      if (j >= 2) {
        const candidate = (score[prev + j - 2] as number) - GAP_START;
        if (candidate > carry) {
          carry = candidate;
          carryFrom = j - 2;
        }
      }
      if (lower[j] !== c) continue;
      const adjacent = score[prev + j - 1] as number;
      const viaRun = adjacent === NEG ? NEG : adjacent + CONSECUTIVE;
      const best = viaRun >= carry ? viaRun : carry;
      if (best === NEG) continue;
      score[row + j] = best + MATCH + (bonus[j] as number);
      from[row + j] = viaRun >= carry ? j - 1 : carryFrom;
    }
  }

  const last = (m - 1) * n;
  let bestJ = -1;
  let best = NEG;
  for (let j = m - 1; j < n; j++) {
    const s = score[last + j] as number;
    if (s > best) {
      best = s;
      bestJ = j;
    }
  }
  if (bestJ === -1) return null;
  const positions = new Array<number>(m);
  for (let i = m - 1, j = bestJ; i >= 0; i--) {
    positions[i] = j;
    j = from[i * n + j] as number;
  }
  // Shorter paths win ties; a match ending in the file name is what people usually mean.
  const total = best - n * 0.1 + (bestJ >= baseStart ? IN_BASENAME : 0);
  return { score: Math.round(total * 100) / 100, positions };
}

/** The best `limit` matches of `query` among `paths`, best first (ties: shorter, then alphabetical). */
export function fuzzyRank(
  query: string,
  paths: readonly string[],
  limit: number,
): { path: string; score: number; positions: number[] }[] {
  const out: { path: string; score: number; positions: number[] }[] = [];
  for (const path of paths) {
    const match = fuzzyMatch(query, path);
    if (match) out.push({ path, score: match.score, positions: match.positions });
  }
  out.sort((a, b) => b.score - a.score || a.path.length - b.path.length || a.path.localeCompare(b.path));
  return out.slice(0, limit);
}
