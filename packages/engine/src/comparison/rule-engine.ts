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

export interface RuleEvalContext {
  ruleRef: { id: StableId; version: string };
  path: string;
  referenceValue: unknown;
  candidateValue: unknown;
  referenceObservation: SemanticObservation;
  candidateObservation: SemanticObservation;
}

function digestsOf(ctx: RuleEvalContext): { reference: Sha256; candidate: Sha256 } {
  return {
    reference: sha256OfCanonicalJson(ctx.referenceValue as JsonValue),
    candidate: sha256OfCanonicalJson(ctx.candidateValue as JsonValue),
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
      const refObj = (ctx.referenceValue ?? {}) as Record<string, unknown>;
      const candObj = (ctx.candidateValue ?? {}) as Record<string, unknown>;
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
      const refArr = Array.isArray(ctx.referenceValue) ? ctx.referenceValue : [];
      const candArr = Array.isArray(ctx.candidateValue) ? ctx.candidateValue : [];
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
      const refArr = Array.isArray(ctx.referenceValue) ? ctx.referenceValue : [];
      const candArr = Array.isArray(ctx.candidateValue) ? ctx.candidateValue : [];
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
      const expected = rule.expectedSide === "reference" ? ctx.referenceValue : ctx.candidateValue;
      const actual = rule.expectedSide === "reference" ? ctx.candidateValue : ctx.referenceValue;
      const expectedArr = Array.isArray(expected) ? expected : [];
      const actualArr = Array.isArray(actual) ? actual : [];
      const actualCanon = new Set(actualArr.map((v) => sha256OfCanonicalJson(v as JsonValue)));
      const missing = expectedArr.filter(
        (v) => !actualCanon.has(sha256OfCanonicalJson(v as JsonValue)),
      );
      const ok = missing.length === 0;
      return node(
        ctx,
        ok ? "satisfied" : "failed",
        ok
          ? `every expected item from ${rule.expectedSide} is present`
          : `${missing.length} expected item(s) missing`,
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
      const ok = refFact !== undefined && candFact !== undefined;
      return node(
        ctx,
        ok ? "satisfied" : "failed",
        ok
          ? `relationship "${rule.predicate}" holds on both sides (no token equality required)`
          : `relationship "${rule.predicate}" is missing on at least one side`,
      );
    }

    case "invariant": {
      const facts = {
        reference: ctx.referenceObservation.contractFields,
        candidate: ctx.candidateObservation.contractFields,
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
        reference: ctx.referenceObservation.contractFields,
        candidate: ctx.candidateObservation.contractFields,
      } as unknown as Record<string, JsonValue>;
      const ok = evaluatePredicate(rule.expression, facts);
      return node(
        ctx,
        ok ? "satisfied" : "failed",
        ok ? "temporal invariant satisfied" : "temporal invariant failed",
      );
    }

    case "url-redemption": {
      const refStatus = (ctx.referenceValue as Record<string, unknown>)?.["status"];
      const candStatus = (ctx.candidateValue as Record<string, unknown>)?.["status"];
      const ok = refStatus === candStatus;
      return node(
        ctx,
        ok ? "satisfied" : "failed",
        ok
          ? `both sides redeemed with status category "${String(refStatus)}"`
          : "redemption status category differs",
      );
    }

    case "state-readback": {
      // Minimal support: presence of the declared before/after selectors on both sides.
      const ok = ctx.referenceValue !== undefined && ctx.candidateValue !== undefined;
      return node(
        ctx,
        ok ? "satisfied" : "failed",
        ok ? "before/after state readback present on both sides" : "state readback missing",
      );
    }

    case "explicit-ignore": {
      return node(ctx, "not-applicable", `explicitly ignored: ${rule.reason}`);
    }
  }
}
