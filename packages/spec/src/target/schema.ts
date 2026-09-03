import { registerSchema } from "../schema-registry.js";

const STABLE_ID = { type: "string", pattern: "^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$" };

/** Closed config schema for the `fake` target kind, used by L0-L5 tests only (§4.4 analogue). */
export const FAKE_TARGET_CONFIG_SCHEMA = {
  $id: "supadiff://schema/target-config/fake.json",
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  additionalProperties: false,
  properties: {
    scriptId: { type: "string", minLength: 1 },
    declaredCapabilities: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: STABLE_ID,
          version: { type: "string" },
          level: { enum: ["exact", "approximation", "experimental", "unsupported"] },
        },
        required: ["id", "version", "level"],
      },
    },
    // Test-only inline fixture script (§15.2). Not a durable driver contract; only the
    // fake target consumes it. Its inner shape is intentionally not schema-validated
    // here — it is engine test infrastructure, never a real target configuration.
    script: { type: "object" },
  },
  required: ["scriptId"],
} as const;

registerSchema(FAKE_TARGET_CONFIG_SCHEMA);

/** Per-`TargetKind` closed config schema `$id`s. Real Supalite/Supabase kinds are L6+ (not yet registered). */
export const TARGET_CONFIG_SCHEMA_BY_KIND: Record<string, string> = {
  fake: FAKE_TARGET_CONFIG_SCHEMA.$id,
};

export const TARGET_SPEC_SCHEMA = {
  $id: "supadiff://schema/target-spec.json",
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  additionalProperties: false,
  properties: {
    id: STABLE_ID,
    kind: {
      enum: [
        "supabase-hosted",
        "supabase-local",
        "supalite-sqlite",
        "supalite-sqlite-postgres",
        "supalite-pglite",
        "supalite-postgres",
        "fake",
      ],
    },
    package: {
      type: "object",
      additionalProperties: false,
      properties: {
        name: { type: "string" },
        version: { type: "string" },
        integrity: { type: "string" },
      },
      required: ["name", "version"],
    },
    runtime: {
      type: "object",
      additionalProperties: false,
      properties: { runtime: { type: "string" }, version: { type: "string" } },
      required: ["runtime", "version"],
    },
    backend: {
      type: "object",
      additionalProperties: false,
      properties: { backend: { type: "string" }, version: { type: "string" } },
      required: ["backend"],
    },
    config: { type: "object" },
    credentialRefs: { type: "array", items: STABLE_ID },
    lifecycle: {
      type: "object",
      additionalProperties: false,
      properties: {
        allocation: { enum: ["provision-new", "attach-explicit"] },
        isolation: { const: "fresh-instance" },
        readinessTimeoutMs: { type: "integer", minimum: 0 },
        teardownTimeoutMs: { type: "integer", minimum: 0 },
        cleanup: { const: "always" },
        keepOnFailure: { enum: ["deny", "local-opt-in"] },
      },
      required: [
        "allocation",
        "isolation",
        "readinessTimeoutMs",
        "teardownTimeoutMs",
        "cleanup",
        "keepOnFailure",
      ],
    },
    safety: {
      type: "object",
      additionalProperties: false,
      properties: {
        allowHosted: { type: "boolean" },
        allowHostedCreate: { type: "boolean" },
        allowHostedDestructive: { type: "boolean" },
        maxHostedCostUsd: { type: "number", minimum: 0 },
      },
      required: ["allowHosted", "allowHostedCreate", "allowHostedDestructive", "maxHostedCostUsd"],
    },
  },
  required: ["id", "kind", "runtime", "config", "credentialRefs", "lifecycle", "safety"],
} as const;

registerSchema(TARGET_SPEC_SCHEMA);
