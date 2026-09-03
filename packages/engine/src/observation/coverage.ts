import type { FieldCoverageReceipt, JsonPointer } from "@supadiff/spec";

export interface FieldAccounting {
  contractual: JsonPointer[];
  diagnostic: JsonPointer[];
  ignored: JsonPointer[];
}

/** RFC 6901 §3: escape `~` before `/` when composing a JSON Pointer path segment. */
function escapeToken(token: string): string {
  return token.replace(/~/g, "~0").replace(/\//g, "~1");
}

/**
 * Computes field coverage over the FULL JSON tree of a response body, recursively (§6.1,
 * §7.3, workstream 5). A raw field at any depth — not just the top level — that is not
 * accounted for by a contractual, diagnostic, or explicit-ignore pointer becomes
 * `unassessed`; projectors MUST NOT silently discard it.
 *
 * "Contractual subtree" rule: when a full path has been explicitly declared (in
 * `contractual`, `diagnostic`, or `ignored`) as an atomic value — e.g. a projector declares
 * `/rows` as one opaque contractual field whose internal shape a downstream comparison rule
 * (such as `unordered-collection`) is responsible for judging — traversal stops at that path.
 * Its children are NOT individually walked and therefore can never spuriously appear as
 * `unassessed`; only a path that is genuinely unaccounted for, at whatever depth it occurs,
 * is reported.
 */
export function computeCoverage(
  responseBody: unknown,
  accounting: FieldAccounting,
): FieldCoverageReceipt {
  const covered = new Set<JsonPointer>([
    ...accounting.contractual,
    ...accounting.diagnostic,
    ...accounting.ignored,
  ]);

  const unassessed: JsonPointer[] = [];

  function walk(node: unknown, path: JsonPointer): void {
    // Declared as an atomic subtree at this exact path: stop here, never descend into it.
    if (covered.has(path)) return;

    if (Array.isArray(node)) {
      if (node.length === 0) {
        unassessed.push(path);
        return;
      }
      node.forEach((item, i) => walk(item, `${path}/${i}`));
      return;
    }

    if (node !== null && typeof node === "object") {
      const keys = Object.keys(node as Record<string, unknown>);
      if (keys.length === 0) {
        unassessed.push(path);
        return;
      }
      for (const key of keys) {
        walk((node as Record<string, unknown>)[key], `${path}/${escapeToken(key)}`);
      }
      return;
    }

    // Scalar or null leaf, not accounted for at this exact path.
    unassessed.push(path);
  }

  if (Array.isArray(responseBody)) {
    responseBody.forEach((item, i) => walk(item, `/${i}`));
  } else if (responseBody !== null && typeof responseBody === "object") {
    for (const key of Object.keys(responseBody as Record<string, unknown>)) {
      walk((responseBody as Record<string, unknown>)[key], `/${escapeToken(key)}`);
    }
  }

  return {
    contractualFields: accounting.contractual,
    diagnosticFields: accounting.diagnostic,
    ignoredFields: accounting.ignored,
    unassessedFields: unassessed,
  };
}
