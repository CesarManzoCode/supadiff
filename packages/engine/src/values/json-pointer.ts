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
