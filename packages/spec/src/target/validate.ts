import { issue, SpecValidationError, type ValidationIssue } from "../errors.js";
import { validateAgainstSchema } from "../schema-registry.js";
import "./schema.js";
import { TARGET_CONFIG_SCHEMA_BY_KIND } from "./schema.js";
import type { JsonValue } from "../json-value.js";
import type { TargetSpec } from "./types.js";

/**
 * Parses and validates a `TargetSpec`. `config` is re-validated against the closed,
 * versioned schema selected by `kind` (§2.7) — unknown keys and credential literals
 * are rejected by that nested schema being `additionalProperties: false`.
 */
export function parseTargetSpec(data: JsonValue): TargetSpec {
  const target = validateAgainstSchema<TargetSpec>("supadiff://schema/target-spec.json", data);
  const issues: ValidationIssue[] = [];

  const configSchemaId = TARGET_CONFIG_SCHEMA_BY_KIND[target.kind];
  if (!configSchemaId) {
    issues.push(
      issue(
        "/kind",
        "unsupported-target-kind",
        `target kind "${target.kind}" has no driver in this build (L6+)`,
      ),
    );
  } else {
    try {
      validateAgainstSchema(configSchemaId, target.config as unknown as JsonValue);
    } catch (e) {
      if (e instanceof SpecValidationError) {
        for (const i of e.issues) issues.push(issue(`/config${i.path}`, i.code, i.message));
      } else {
        throw e;
      }
    }
  }

  if (issues.length > 0) throw new SpecValidationError(issues);
  return target;
}
