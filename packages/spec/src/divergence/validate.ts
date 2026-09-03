import { issue, SpecValidationError, type ValidationIssue } from "../errors.js";
import { validateAgainstSchema } from "../schema-registry.js";
import "./schema.js";
import type { JsonValue } from "../json-value.js";
import type { KnownDivergence } from "./types.js";

export function parseKnownDivergence(data: JsonValue): KnownDivergence {
  const entry = validateAgainstSchema<KnownDivergence>(
    "supadiff://schema/known-divergence.json",
    data,
  );
  const issues: ValidationIssue[] = [];
  if (Date.parse(entry.expiresAt) <= Date.parse(entry.verifiedAt)) {
    issues.push(issue("/expiresAt", "invalid-expiry", "expiresAt must be after verifiedAt"));
  }
  if (issues.length > 0) throw new SpecValidationError(issues);
  return entry;
}
