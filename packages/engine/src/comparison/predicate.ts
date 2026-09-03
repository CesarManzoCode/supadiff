import type { JsonValue, PredicateAst } from "@supadiff/spec";
import { jsonPointerGet } from "../values/json-pointer.js";

/**
 * Evaluates the closed `PredicateAst` expression language (§7.1) against a flat fact
 * object. Pointers are resolved against `facts`; `{literal}` operands are used as-is.
 * No JavaScript execution and no unbounded regex — only equality, membership, and
 * boolean composition, per the contract's closed algebra.
 */
export function evaluatePredicate(
  predicate: PredicateAst,
  facts: Record<string, JsonValue>,
): boolean {
  switch (predicate.op) {
    case "eq": {
      const left = jsonPointerGet(facts, predicate.left);
      const right =
        typeof predicate.right === "object"
          ? predicate.right.literal
          : jsonPointerGet(facts, predicate.right);
      return deepEqual(left, right);
    }
    case "neq": {
      const left = jsonPointerGet(facts, predicate.left);
      const right =
        typeof predicate.right === "object"
          ? predicate.right.literal
          : jsonPointerGet(facts, predicate.right);
      return !deepEqual(left, right);
    }
    case "in": {
      const left = jsonPointerGet(facts, predicate.left);
      return predicate.right.some((v) => deepEqual(v, left));
    }
    case "and":
      return predicate.clauses.every((c) => evaluatePredicate(c, facts));
    case "or":
      return predicate.clauses.some((c) => evaluatePredicate(c, facts));
    case "not":
      return !evaluatePredicate(predicate.clause, facts);
  }
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  if (typeof a === "object" && typeof b === "object") {
    const ak = Object.keys(a as object).sort();
    const bk = Object.keys(b as object).sort();
    if (ak.length !== bk.length || ak.some((k, i) => k !== bk[i])) return false;
    return ak.every((k) =>
      deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
    );
  }
  return false;
}
