/**
 * Classic delta-debugging minimization (Zeller & Hildebrandt), used for §11.3 pass 2
 * ("delta-debug contiguous operation ranges"). `isValid` is the acceptance oracle: it
 * must return `true` only when removing exactly `removed` (a subset of `items`) still
 * reproduces the exact divergence signature on a fresh target. Deterministic: candidate
 * order is fixed by `items`' own order (already canonical — §11.3), never randomized.
 */
export async function ddmin<T>(
  items: readonly T[],
  isValid: (removed: ReadonlySet<T>) => Promise<boolean>,
): Promise<T[]> {
  let remaining = [...items];
  let chunkCount = 2;

  while (remaining.length >= 1) {
    if (remaining.length === 1) {
      // Base case: a single remaining element can't be split into 2+ chunks — test
      // removing it directly instead of breaking out without ever trying.
      if (await isValid(new Set(remaining))) remaining = [];
      break;
    }

    const chunkSize = Math.ceil(remaining.length / chunkCount);
    const chunks: T[][] = [];
    for (let i = 0; i < remaining.length; i += chunkSize) {
      chunks.push(remaining.slice(i, i + chunkSize));
    }
    if (chunks.length < 2) break;

    let reduced = false;

    // Try removing each chunk outright.
    for (const chunk of chunks) {
      const removed = new Set(chunk);
      if (removed.size === remaining.length) continue;
      if (await isValid(removed)) {
        remaining = remaining.filter((x) => !removed.has(x));
        chunkCount = Math.max(chunkCount - 1, 2);
        reduced = true;
        break;
      }
    }
    if (reduced) continue;

    // Try keeping only each chunk (i.e. removing its complement).
    for (const chunk of chunks) {
      const keep = new Set(chunk);
      const removed = new Set(remaining.filter((x) => !keep.has(x)));
      if (removed.size === 0) continue;
      if (await isValid(removed)) {
        remaining = chunk;
        chunkCount = 2;
        reduced = true;
        break;
      }
    }
    if (reduced) continue;

    if (chunkCount >= remaining.length) break;
    chunkCount = Math.min(chunkCount * 2, remaining.length);
  }

  return remaining;
}
