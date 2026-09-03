export function jsonPointerGet(obj: unknown, pointer: string): unknown {
  if (pointer === "" || pointer === "/") return obj;
  const parts = pointer
    .split("/")
    .slice(1)
    .map((p) => p.replace(/~1/g, "/").replace(/~0/g, "~"));
  let cur: unknown = obj;
  for (const part of parts) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

/**
 * Rebuilds a nested JSON tree from a flat `Record<JsonPointer, value>` map (as stored on
 * `SemanticObservation.contractFields`), so a `PredicateAst` pointer like `/status` or
 * `/user/id` resolves correctly against it regardless of how deep the flat map's keys go.
 */
export function pointerMapToTree(flat: Record<string, unknown>): Record<string, unknown> {
  const tree: Record<string, unknown> = {};
  for (const [pointer, value] of Object.entries(flat)) {
    jsonPointerSet(tree, pointer, value);
  }
  return tree;
}

export function jsonPointerSet(
  obj: Record<string, unknown>,
  pointer: string,
  value: unknown,
): void {
  const parts = pointer
    .split("/")
    .slice(1)
    .map((p) => p.replace(/~1/g, "/").replace(/~0/g, "~"));
  let cur: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i]!;
    const next = cur[key];
    if (next === null || typeof next !== "object") return;
    cur = next as Record<string, unknown>;
  }
  const lastKey = parts.at(-1);
  if (lastKey !== undefined) cur[lastKey] = value;
}
