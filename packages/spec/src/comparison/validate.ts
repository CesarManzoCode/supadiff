import { issue, SpecValidationError, type ValidationIssue } from "../errors.js";
import { validateAgainstSchema } from "../schema-registry.js";
import "./schema.js";
import type { JsonValue } from "../json-value.js";
import type { ComparisonPolicy } from "./types.js";

function selectorKey(r: ComparisonPolicy["rules"][number]): string {
  const s = r.selector;
  return JSON.stringify([
    s.service,
    s.operationId,
    s.operationVersion,
    s.observablePath,
    s.referenceTargetSelector,
    s.candidateTargetSelector,
    s.capabilityContext ?? null,
  ]);
}

/**
 * Parses and validates a comparison policy file. Rejects observable-path wildcards and
 * two rules registered under an identical, equally specific selector — ambiguous rule
 * selection is a compile error, never "first registered wins" (§7.2).
 */
export function parseComparisonPolicy(data: JsonValue): ComparisonPolicy {
  const policy = validateAgainstSchema<ComparisonPolicy>(
    "supadiff://schema/comparison-policy.json",
    data,
  );
  const issues: ValidationIssue[] = [];

  policy.rules.forEach((r, i) => {
    if (r.selector.observablePath === "*") {
      issues.push(
        issue(
          `/rules/${i}/selector/observablePath`,
          "forbidden-wildcard",
          `"*" is forbidden as an observable path selector`,
        ),
      );
    }
  });

  const seen = new Map<string, number>();
  policy.rules.forEach((r, i) => {
    const key = selectorKey(r);
    const prior = seen.get(key);
    if (prior !== undefined) {
      issues.push(
        issue(
          `/rules/${i}`,
          "ambiguous-rule-selector",
          `rule "${r.id}" has an identically specific selector to rule at index ${prior}`,
        ),
      );
    } else {
      seen.set(key, i);
    }
  });

  if (issues.length > 0) throw new SpecValidationError(issues);
  return policy;
}
