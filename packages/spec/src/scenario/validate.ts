import { createHash } from "node:crypto";
import { issue, SpecValidationError, type ValidationIssue } from "../errors.js";
import { validateAgainstSchema } from "../schema-registry.js";
import { isKnownOperation } from "../operation/catalog.js";
import type { JsonValue } from "../json-value.js";
import "./schema.js";
import type { ScenarioSpec, StepSpec } from "./types.js";

const CREDENTIAL_LITERAL_KEYS = new Set([
  "password",
  "apikey",
  "api_key",
  "secret",
  "token",
  "access_token",
  "refresh_token",
  "service_role_key",
  "anon_key",
]);

function scanForCredentialLiterals(value: unknown, path: string, out: ValidationIssue[]): void {
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((v, i) => scanForCredentialLiterals(v, `${path}/${i}`, out));
    return;
  }
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    const childPath = `${path}/${key}`;
    if (
      CREDENTIAL_LITERAL_KEYS.has(key.toLowerCase()) &&
      typeof v === "string" &&
      v.length > 0 &&
      !(typeof v === "object")
    ) {
      // A bare secret-ref object like {"$secretRef": "..."} is legal; a raw string literal is not.
      out.push(
        issue(
          childPath,
          "credential-literal",
          `field "${key}" looks like a credential literal; only secretRef/$secretRef indirection is valid`,
        ),
      );
    }
    scanForCredentialLiterals(v, childPath, out);
  }
}

function isUnsafeResourcePath(p: string): boolean {
  if (p.startsWith("/")) return true;
  if (p.startsWith("~")) return true;
  if (/^[a-zA-Z]:[\\/]/.test(p)) return true;
  if (p.split(/[\\/]/).includes("..")) return true;
  if (/^[a-zA-Z]+:\/\//.test(p)) return true; // scheme:// external URL
  return false;
}

/**
 * Validates and parses untrusted scenario JSON into a `ScenarioSpec`. Throws
 * `SpecValidationError` aggregating every issue found; never returns a partially
 * invalid value (§1.2 invariant 9, Implementation DAG L1).
 */
export function parseScenarioSpec(data: JsonValue): ScenarioSpec {
  const scenario = validateAgainstSchema<ScenarioSpec>("supadiff://schema/scenario.json", data);
  const issues: ValidationIssue[] = [];

  if (scenario.formatVersion !== "1.0") {
    issues.push(
      issue(
        "/formatVersion",
        "unknown-major-version",
        `unsupported formatVersion "${scenario.formatVersion}"`,
      ),
    );
  }

  // Duplicate step IDs.
  const stepIds = new Set<string>();
  scenario.steps.forEach((s, i) => {
    if (stepIds.has(s.id)) {
      issues.push(issue(`/steps/${i}/id`, "duplicate-step-id", `duplicate step id "${s.id}"`));
    }
    stepIds.add(s.id);
  });

  // Duplicate capture names, across the whole scenario (capture names are globally addressed by `capture:<name>`).
  const captureProducers = new Map<string, { stepIndex: number; step: StepSpec }>();
  scenario.steps.forEach((step, stepIndex) => {
    for (const capture of step.capture ?? []) {
      if (captureProducers.has(capture.name)) {
        issues.push(
          issue(
            `/steps/${stepIndex}/capture`,
            "duplicate-capture",
            `capture "${capture.name}" already produced by an earlier step`,
          ),
        );
      } else {
        captureProducers.set(capture.name, { stepIndex, step });
      }
    }
  });

  // Actor declaration set.
  const actorIds = new Set(scenario.actors.map((a) => a.id));

  // Unknown operation catalog entries (kind implies operation id at version "1" in this catalog).
  scenario.steps.forEach((step, i) => {
    if (!isKnownOperation(step.kind, "1")) {
      issues.push(
        issue(`/steps/${i}/kind`, "unknown-operation", `unknown operation "${step.kind}"`),
      );
    }
    if (step.actor !== undefined && !actorIds.has(step.actor)) {
      issues.push(
        issue(
          `/steps/${i}/actor`,
          "unknown-actor",
          `step references undeclared actor "${step.actor}"`,
        ),
      );
    }
  });

  // dependsOn: forward-reference and unknown-id rejection (edges may only point backward, §3.3).
  scenario.steps.forEach((step, i) => {
    for (const dep of step.dependsOn ?? []) {
      const depIndex = scenario.steps.findIndex((s) => s.id === dep);
      if (depIndex === -1) {
        issues.push(
          issue(
            `/steps/${i}/dependsOn`,
            "unknown-dependency",
            `dependsOn references unknown step "${dep}"`,
          ),
        );
      } else if (depIndex >= i) {
        issues.push(
          issue(
            `/steps/${i}/dependsOn`,
            "forward-reference",
            `dependsOn "${dep}" is not an earlier step`,
          ),
        );
      }
    }
  });

  // Capture $ref resolution inside step.input: forward-ref rejection + cycle-free by construction
  // because refs may only resolve to captures produced by strictly earlier steps.
  function walkForRefs(value: unknown, path: string, stepIndex: number): void {
    if (value === null || typeof value !== "object") return;
    if (Array.isArray(value)) {
      value.forEach((v, i) => walkForRefs(v, `${path}/${i}`, stepIndex));
      return;
    }
    const obj = value as Record<string, unknown>;
    if (typeof obj["$ref"] === "string" && obj["$ref"].startsWith("capture:")) {
      const captureName = obj["$ref"].slice("capture:".length);
      const producer = captureProducers.get(captureName);
      if (!producer) {
        issues.push(
          issue(path, "unknown-capture-ref", `reference to undeclared capture "${captureName}"`),
        );
      } else if (producer.stepIndex >= stepIndex) {
        issues.push(
          issue(
            path,
            "forward-capture-ref",
            `reference to capture "${captureName}" is not from an earlier step`,
          ),
        );
      }
      return;
    }
    for (const [k, v] of Object.entries(obj)) walkForRefs(v, `${path}/${k}`, stepIndex);
  }
  scenario.steps.forEach((step, i) => walkForRefs(step.input, `/steps/${i}/input`, i));

  // Dependency-cycle rejection over the explicit dependsOn graph (defense in depth beyond
  // the backward-only rule above, in case duplicate IDs previously confused index lookup).
  {
    const idToIndex = new Map(scenario.steps.map((s, i) => [s.id, i] as const));
    const visiting = new Set<string>();
    const visited = new Set<string>();
    let cycleFound = false;
    function visit(stepId: string): void {
      if (visited.has(stepId) || cycleFound) return;
      if (visiting.has(stepId)) {
        cycleFound = true;
        return;
      }
      visiting.add(stepId);
      const idx = idToIndex.get(stepId);
      const step = idx === undefined ? undefined : scenario.steps[idx];
      for (const dep of step?.dependsOn ?? []) visit(dep);
      visiting.delete(stepId);
      visited.add(stepId);
    }
    for (const s of scenario.steps) visit(s.id);
    if (cycleFound) {
      issues.push(issue("/steps", "dependency-cycle", "step dependsOn graph contains a cycle"));
    }
  }

  // Resource hash/path safety.
  scenario.resources.forEach((r, i) => {
    if (r.source.kind === "content" && isUnsafeResourcePath(r.source.path)) {
      issues.push(
        issue(
          `/resources/${i}/source/path`,
          "unsafe-resource-path",
          `unsafe resource path "${r.source.path}"`,
        ),
      );
    }
    if (r.source.kind === "inline") {
      const bytes = Buffer.from(r.source.value, "utf8");
      const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
      if (digest !== r.sha256) {
        issues.push(
          issue(
            `/resources/${i}/sha256`,
            "resource-digest-mismatch",
            `declared sha256 does not match inline bytes`,
          ),
        );
      }
      if (bytes.length !== r.length) {
        issues.push(
          issue(
            `/resources/${i}/length`,
            "resource-length-mismatch",
            `declared length does not match inline bytes`,
          ),
        );
      }
    }
  });

  // Cleanup restrictions: no captures, cannot depend on normal steps, must reference known operations.
  scenario.cleanup.forEach((c, i) => {
    if (!isKnownOperation(c.operation.id, c.operation.version)) {
      issues.push(
        issue(
          `/cleanup/${i}/operation`,
          "unknown-operation",
          `unknown cleanup operation "${c.operation.id}"`,
        ),
      );
    }
    walkForRefs(c.input, `/cleanup/${i}/input`, scenario.steps.length);
  });

  // No credential literals anywhere in the scenario (§2.2 invariant).
  scanForCredentialLiterals(scenario.actors, "/actors", issues);
  scenario.steps.forEach((step, i) =>
    scanForCredentialLiterals(step.input, `/steps/${i}/input`, issues),
  );

  if (issues.length > 0) throw new SpecValidationError(issues);
  return scenario;
}
