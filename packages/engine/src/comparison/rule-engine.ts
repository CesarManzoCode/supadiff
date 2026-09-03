import type {
  ExplanationNode,
  JsonValue,
  RelationshipFact,
  RuleExpression,
  Sha256,
  SemanticObservation,
  StableId,
  TransformationReceipt,
} from "@supadiff/spec";
import { sha256OfCanonicalJson } from "@supadiff/spec";
import { deepEqual, evaluatePredicate } from "./predicate.js";
import { jsonPointerGet, pointerMapToTree } from "../values/json-pointer.js";

export interface RuleEvalContext {
  ruleRef: { id: StableId; version: string };
  path: string;
  referenceValue: unknown;
  candidateValue: unknown;
  referenceObservation: SemanticObservation;
  candidateObservation: SemanticObservation;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function describeType(v: unknown): string {
  if (v === undefined) return "missing";
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

function digestsOf(ctx: RuleEvalContext): { reference: Sha256; candidate: Sha256 } {
  // Some rule kinds (relationship, temporal-invariant, state-readback, url-redemption)
  // judge whole observations rather than a single scalar at `ctx.path`, so `referenceValue`/
  // `candidateValue` may legitimately be `undefined` there. These digests are diagnostic
  // evidence only (never part of equality logic), so `undefined` is canonicalized as `null`
  // rather than throwing.
  return {
    reference: sha256OfCanonicalJson((ctx.referenceValue ?? null) as JsonValue),
    candidate: sha256OfCanonicalJson((ctx.candidateValue ?? null) as JsonValue),
  };
}

function node(
  ctx: RuleEvalContext,
  verdict: ExplanationNode["verdict"],
  summary: string,
  transformations: TransformationReceipt[] = [],
  children?: ExplanationNode[],
): ExplanationNode {
  const result: ExplanationNode = {
    rule: ctx.ruleRef,
    path: ctx.path,
    verdict,
    summary,
    inputDigests: digestsOf(ctx),
    transformations,
  };
  if (children) result.children = children;
  return result;
}

/**
 * Type safety guard shared by `ordered-collection`, `unordered-collection`, and `subset`
 * (§7.3, §15.3): a non-array value is never silently coerced to `[]`, which could turn a
 * real type mismatch (e.g. `null`, an object, a string) into an accidental empty-array
 * match. Returns a `failed` node when either side is not an array, or `undefined` when
 * both sides are genuinely arrays and evaluation should proceed.
 */
function requireBothArrays(ctx: RuleEvalContext): ExplanationNode | undefined {
  const refIsArr = Array.isArray(ctx.referenceValue);
  const candIsArr = Array.isArray(ctx.candidateValue);
  if (refIsArr && candIsArr) return undefined;
  return node(
    ctx,
    "failed",
    `array rule type mismatch: reference is ${describeType(ctx.referenceValue)}, candidate is ${describeType(ctx.candidateValue)} — never coerced to []`,
  );
}

/** Returns the first key value that occurs more than once in either array, or undefined. */
function firstDuplicateKey(
  refArr: unknown[],
  candArr: unknown[],
  keyOf: (item: unknown) => unknown,
): unknown {
  for (const arr of [refArr, candArr]) {
    const seen = new Set<string>();
    for (const item of arr) {
      const k = JSON.stringify(keyOf(item) as JsonValue);
      if (seen.has(k)) return keyOf(item);
      seen.add(k);
    }
  }
  return undefined;
}

function findRelationship(
  obs: SemanticObservation,
  predicate: StableId,
): RelationshipFact | undefined {
  return obs.relationships.find((r) => r.predicate === predicate);
}

/**
 * Evaluates one `RuleExpression` node against a reference/candidate value pair,
 * producing a structured `ExplanationNode` that answers "why equal?" or "exactly
 * where and why different?" (§7.1, §7.4). Recurses for composite rule kinds.
 */
export function evaluateRule(rule: RuleExpression, ctx: RuleEvalContext): ExplanationNode {
  switch (rule.kind) {
    case "exact": {
      const equal = deepEqual(ctx.referenceValue, ctx.candidateValue);
      return node(
        ctx,
        equal ? "satisfied" : "failed",
        equal ? "values are byte-identical" : "values differ under exact equality",
      );
    }

    case "object": {
      // Type safety (§7.3, §15.3): null, missing (undefined), and a non-object value are
      // never silently coerced into {} — that would let e.g. a `null` field spuriously
      // "match" an empty object. Only two genuine objects are compared field-by-field.
      const refIsObject = isPlainObject(ctx.referenceValue);
      const candIsObject = isPlainObject(ctx.candidateValue);
      if (!refIsObject || !candIsObject) {
        if (!refIsObject && !candIsObject) {
          const ok = deepEqual(ctx.referenceValue, ctx.candidateValue);
          return node(
            ctx,
            ok ? "satisfied" : "failed",
            ok
              ? "neither side is an object; values are equal as-is (e.g. both null)"
              : `type/value mismatch: neither side is an object and the raw values differ (reference=${describeType(ctx.referenceValue)}, candidate=${describeType(ctx.candidateValue)})`,
          );
        }
        return node(
          ctx,
          "failed",
          `object rule type mismatch: reference is ${describeType(ctx.referenceValue)}, candidate is ${describeType(ctx.candidateValue)} — never coerced to {}`,
        );
      }
      const refObj = ctx.referenceValue as Record<string, unknown>;
      const candObj = ctx.candidateValue as Record<string, unknown>;
      const declaredFields = new Set(rule.fields.map((f) => f.field));
      const unknownKeys = [...new Set([...Object.keys(refObj), ...Object.keys(candObj)])].filter(
        (k) => !declaredFields.has(`/${k}`),
      );
      const children = rule.fields.map((fieldRule) => {
        const key = fieldRule.field.replace(/^\//, "");
        return evaluateRule(fieldRule.rule, {
          ...ctx,
          path: `${ctx.path}${fieldRule.field}`,
          referenceValue: refObj[key],
          candidateValue: candObj[key],
        });
      });
      if (unknownKeys.length > 0 && rule.unknown === "fail") {
        return node(
          ctx,
          "failed",
          `unaccounted field(s) at this object: ${unknownKeys.join(", ")} (unknown: "fail")`,
          [],
          children,
        );
      }
      const allSatisfied = children.every(
        (c) => c.verdict === "satisfied" || c.verdict === "not-applicable",
      );
      return node(
        ctx,
        allSatisfied ? "satisfied" : "failed",
        allSatisfied ? "all declared fields matched" : "at least one declared field differs",
        [],
        children,
      );
    }

    case "ordered-collection": {
      const arrayTypeCheck = requireBothArrays(ctx);
      if (arrayTypeCheck) return arrayTypeCheck;
      const refArr = ctx.referenceValue as unknown[];
      const candArr = ctx.candidateValue as unknown[];
      if (refArr.length !== candArr.length) {
        return node(
          ctx,
          "failed",
          `ordered collection length differs: reference=${refArr.length}, candidate=${candArr.length}`,
        );
      }
      const children = refArr.map((v, i) =>
        evaluateRule(rule.item, {
          ...ctx,
          path: `${ctx.path}/${i}`,
          referenceValue: v,
          candidateValue: candArr[i],
        }),
      );
      const ok = children.every((c) => c.verdict === "satisfied");
      return node(
        ctx,
        ok ? "satisfied" : "failed",
        ok ? "ordered collection matched item-by-item" : "an item mismatched at its position",
        [],
        children,
      );
    }

    case "unordered-collection": {
      const arrayTypeCheck = requireBothArrays(ctx);
      if (arrayTypeCheck) return arrayTypeCheck;
      const refArr = ctx.referenceValue as unknown[];
      const candArr = ctx.candidateValue as unknown[];
      if (refArr.length !== candArr.length) {
        return node(
          ctx,
          "failed",
          `unordered collection cardinality differs: reference=${refArr.length}, candidate=${candArr.length}`,
        );
      }
      if (rule.key) {
        const keyOf = (item: unknown): unknown => {
          const k = rule.key!.replace(/^\//, "");
          return (item as Record<string, unknown>)?.[k];
        };
        // One-to-one matching (§7.6, workstream 6): a duplicate key on either side makes the
        // match ambiguous by construction — one candidate item could then satisfy two
        // reference items — so it fails closed instead of silently picking one association.
        const dup = firstDuplicateKey(refArr, candArr, keyOf);
        if (dup !== undefined) {
          return node(
            ctx,
            "failed",
            `duplicate key ${JSON.stringify(dup)} makes one-to-one matching ambiguous — fails closed rather than picking an association`,
          );
        }
        const candByKey = new Map(candArr.map((v) => [keyOf(v), v]));
        const children: ExplanationNode[] = [];
        let allOk = true;
        for (const refItem of refArr) {
          const k = keyOf(refItem);
          const candItem = candByKey.get(k);
          if (candItem === undefined) {
            allOk = false;
            children.push(
              node(ctx, "failed", `no candidate item found with key ${JSON.stringify(k)}`),
            );
            continue;
          }
          const child = evaluateRule(rule.item, {
            ...ctx,
            path: `${ctx.path}[key=${String(k)}]`,
            referenceValue: refItem,
            candidateValue: candItem,
          });
          if (child.verdict !== "satisfied") allOk = false;
          children.push(child);
        }
        return node(
          ctx,
          allOk ? "satisfied" : "failed",
          allOk ? "unordered collection matched by key" : "at least one keyed item mismatched",
          [],
          children,
        );
      }
      // No key: match as a multiset by canonical form (transformation: order ignored).
      const refCanon = refArr.map((v) => sha256OfCanonicalJson(v as JsonValue)).sort();
      const candCanon = candArr.map((v) => sha256OfCanonicalJson(v as JsonValue)).sort();
      const ok = deepEqual(refCanon, candCanon);
      return node(
        ctx,
        ok ? "satisfied" : "failed",
        ok
          ? "unordered collection matched as a multiset (order ignored)"
          : "multiset contents differ",
        [{ kind: "order-ignored", description: "collection compared without regard to order" }],
      );
    }

    case "subset": {
      const arrayTypeCheck = requireBothArrays(ctx);
      if (arrayTypeCheck) return arrayTypeCheck;
      const expected =
        rule.expectedSide === "reference"
          ? (ctx.referenceValue as unknown[])
          : (ctx.candidateValue as unknown[]);
      const actual =
        rule.expectedSide === "reference"
          ? (ctx.candidateValue as unknown[])
          : (ctx.referenceValue as unknown[]);
      // The `item` sub-rule judges equivalence (§7.1) — it is NOT raw/canonical equality.
      // Multiplicity is preserved with one-to-one matching: one actual item can satisfy at
      // most one expected item, so a short actual array can never "cover" a longer expected
      // one by reusing the same item.
      const usedActualIndices = new Set<number>();
      const missing: number[] = [];
      for (let i = 0; i < expected.length; i++) {
        const expectedItem = expected[i];
        let found = false;
        for (let j = 0; j < actual.length; j++) {
          if (usedActualIndices.has(j)) continue;
          const child = evaluateRule(rule.item, {
            ...ctx,
            path: `${ctx.path}/${i}`,
            referenceValue: rule.expectedSide === "reference" ? expectedItem : actual[j],
            candidateValue: rule.expectedSide === "reference" ? actual[j] : expectedItem,
          });
          if (child.verdict === "satisfied") {
            usedActualIndices.add(j);
            found = true;
            break;
          }
        }
        if (!found) missing.push(i);
      }
      const ok = missing.length === 0;
      return node(
        ctx,
        ok ? "satisfied" : "failed",
        ok
          ? `every expected item from ${rule.expectedSide} has a distinct matching item under the declared item rule`
          : `${missing.length} expected item(s) from ${rule.expectedSide} have no distinct matching item under the declared item rule`,
      );
    }

    case "error-category": {
      const ok = deepEqual(ctx.referenceValue, ctx.candidateValue);
      return node(
        ctx,
        ok ? "satisfied" : "failed",
        ok ? "same error category" : "different error category",
        [
          {
            kind: "error-taxonomy",
            description: `classified under ${rule.taxonomy.id}@${rule.taxonomy.version}`,
          },
        ],
      );
    }

    case "relationship": {
      const refFact = findRelationship(ctx.referenceObservation, rule.predicate);
      const candFact = findRelationship(ctx.candidateObservation, rule.predicate);
      if (refFact === undefined || candFact === undefined) {
        return node(
          ctx,
          "failed",
          `relationship "${rule.predicate}" is missing on at least one side`,
        );
      }
      // The predicate existing on both sides is not enough (§7.1, §15.3): the logical
      // subject and object must actually correspond, not merely share a predicate name.
      // e.g. reference session.belongs-to-actor(sessionA, alice) vs candidate
      // session.belongs-to-actor(sessionB, bob) MUST fail — same predicate, different
      // subject/object.
      const ok = refFact.subject === candFact.subject && refFact.object === candFact.object;
      return node(
        ctx,
        ok ? "satisfied" : "failed",
        ok
          ? `relationship "${rule.predicate}" holds on both sides with the same subject/object (no token equality required)`
          : `relationship "${rule.predicate}" holds on both sides but with different subject/object (reference: ${refFact.subject}->${refFact.object}, candidate: ${candFact.subject}->${candFact.object})`,
      );
    }

    case "invariant": {
      const facts = {
        reference: pointerMapToTree(ctx.referenceObservation.contractFields),
        candidate: pointerMapToTree(ctx.candidateObservation.contractFields),
      } as unknown as Record<string, JsonValue>;
      const ok = evaluatePredicate(rule.predicate, facts);
      return node(
        ctx,
        ok ? "satisfied" : "failed",
        ok ? "invariant predicate satisfied" : "invariant predicate failed",
      );
    }

    case "token-claims": {
      const refClaims = (ctx.referenceValue ?? {}) as Record<string, unknown>;
      const candClaims = (ctx.candidateValue ?? {}) as Record<string, unknown>;
      const failures = rule.claims.filter((c) => {
        if (c.predicate === "present")
          return refClaims[c.claim] === undefined || candClaims[c.claim] === undefined;
        if (c.predicate === "absent")
          return refClaims[c.claim] !== undefined || candClaims[c.claim] !== undefined;
        return !deepEqual(refClaims[c.claim], c.value) || !deepEqual(candClaims[c.claim], c.value);
      });
      const ok = failures.length === 0;
      return node(
        ctx,
        ok ? "satisfied" : "failed",
        ok ? "declared claim rules hold on both sides" : `${failures.length} claim rule(s) failed`,
      );
    }

    case "temporal-invariant": {
      const facts = {
        reference: pointerMapToTree(ctx.referenceObservation.contractFields),
        candidate: pointerMapToTree(ctx.candidateObservation.contractFields),
      } as unknown as Record<string, JsonValue>;
      const ok = evaluatePredicate(rule.expression, facts);
      return node(
        ctx,
        ok ? "satisfied" : "failed",
        ok ? "temporal invariant satisfied" : "temporal invariant failed",
      );
    }

    case "url-redemption": {
      // Judges redemption *behavior* against the declared RedemptionContract — never the URL
      // string itself, which is never present in a semantic observation to begin with (§6.3,
      // §7.1). `ctx.referenceValue`/`ctx.candidateValue` are the status category at this
      // path; the byte digest (when required) is read from the sibling `bytesDigest` pointer.
      const refStatus = ctx.referenceValue;
      const candStatus = ctx.candidateValue;
      const expected = rule.expected.expectStatusCategory;
      if (refStatus !== expected || candStatus !== expected) {
        return node(
          ctx,
          "failed",
          `redemption did not resolve to the expected status category "${expected}" (reference=${JSON.stringify(refStatus)}, candidate=${JSON.stringify(candStatus)})`,
        );
      }
      if (rule.expected.bytesMustMatch) {
        const parent = ctx.path.replace(/\/[^/]*$/, "");
        const bytesPath = `${parent}/bytesDigest`;
        const refBytes = ctx.referenceObservation.contractFields[bytesPath];
        const candBytes = ctx.candidateObservation.contractFields[bytesPath];
        if (refBytes === undefined || !deepEqual(refBytes, candBytes)) {
          return node(
            ctx,
            "failed",
            `redeemed byte digest differs though bytesMustMatch is required at "${bytesPath}"`,
            [
              {
                kind: "bytes-digest-compared",
                description: "compared content digest, never the signed URL",
              },
            ],
          );
        }
      }
      return node(
        ctx,
        "satisfied",
        `both sides redeemed with status category "${expected}"${rule.expected.bytesMustMatch ? " and matching bytes" : ""} — URL strings were never compared`,
      );
    }

    case "state-readback": {
      // Uses the declared `before`/`after` snapshot pointers and the DeltaContract
      // explicitly — not mere presence (§7.1, workstream 6). Snapshots are resolved against
      // each side's own full contract-field tree (rebuilt from the flat pointer map).
      const refTree = pointerMapToTree(ctx.referenceObservation.contractFields);
      const candTree = pointerMapToTree(ctx.candidateObservation.contractFields);
      const refBefore = jsonPointerGet(refTree, rule.before);
      const refAfter = jsonPointerGet(refTree, rule.after);
      const candBefore = jsonPointerGet(candTree, rule.before);
      const candAfter = jsonPointerGet(candTree, rule.after);
      if (
        refBefore === undefined ||
        refAfter === undefined ||
        candBefore === undefined ||
        candAfter === undefined
      ) {
        return node(
          ctx,
          "failed",
          `state-readback requires a "${rule.before}" and "${rule.after}" observation on both sides; at least one is missing`,
        );
      }
      const problems: string[] = [];
      for (const p of rule.delta.expectedChangedPaths) {
        if (deepEqual(jsonPointerGet(refBefore, p), jsonPointerGet(refAfter, p))) {
          problems.push(`expected "${p}" to change on reference but it did not`);
        }
        if (deepEqual(jsonPointerGet(candBefore, p), jsonPointerGet(candAfter, p))) {
          problems.push(`expected "${p}" to change on candidate but it did not`);
        }
      }
      for (const p of rule.delta.expectedUnchangedPaths) {
        if (!deepEqual(jsonPointerGet(refBefore, p), jsonPointerGet(refAfter, p))) {
          problems.push(`expected "${p}" to remain unchanged on reference but it changed`);
        }
        if (!deepEqual(jsonPointerGet(candBefore, p), jsonPointerGet(candAfter, p))) {
          problems.push(`expected "${p}" to remain unchanged on candidate but it changed`);
        }
      }
      const ok = problems.length === 0;
      return node(
        ctx,
        ok ? "satisfied" : "failed",
        ok
          ? "before/after delta matched the declared DeltaContract on both sides"
          : problems.join("; "),
      );
    }

    case "explicit-ignore": {
      return node(ctx, "not-applicable", `explicitly ignored: ${rule.reason}`);
    }
  }
}
