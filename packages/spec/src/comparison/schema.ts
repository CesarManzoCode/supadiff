import { registerSchema } from "../schema-registry.js";

const STABLE_ID = { type: "string", pattern: "^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$" };
// Operation catalog IDs are versioned catalog constants that mirror supabase-js method
// names (§2.4 literally lists "auth.signUp", "storage.createSignedUrl", ...), not
// author-chosen StableIds (§2.1). Both contract statements are honored by giving this
// distinct identifier class its own, case-permitting pattern.
const OPERATION_ID = { type: "string", pattern: "^[a-zA-Z][a-zA-Z0-9]*(?:[._-][a-zA-Z0-9]+)*$" };

const evidenceRefSchema = {
  type: "object",
  additionalProperties: false,
  properties: { kind: { enum: ["url", "artifact", "note"] }, value: { type: "string" } },
  required: ["kind", "value"],
};

const targetSelectorSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    kind: { type: "string" },
    backend: { type: "string" },
    versionRange: { type: "string" },
  },
  required: ["kind"],
};

// The rule algebra is recursive; defined via $defs so `object`/collection rules can nest.
const ruleExpressionSchema = {
  $id: "supadiff://schema/rule-expression.json",
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $defs: {
    rule: {
      oneOf: [
        {
          type: "object",
          additionalProperties: false,
          properties: { kind: { const: "exact" } },
          required: ["kind"],
        },
        {
          type: "object",
          additionalProperties: false,
          properties: {
            kind: { const: "object" },
            unknown: { const: "fail" },
            fields: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                properties: { field: { type: "string" }, rule: { $ref: "#/$defs/rule" } },
                required: ["field", "rule"],
              },
            },
          },
          required: ["kind", "fields", "unknown"],
        },
        {
          type: "object",
          additionalProperties: false,
          properties: { kind: { const: "ordered-collection" }, item: { $ref: "#/$defs/rule" } },
          required: ["kind", "item"],
        },
        {
          type: "object",
          additionalProperties: false,
          properties: {
            kind: { const: "unordered-collection" },
            item: { $ref: "#/$defs/rule" },
            key: { type: "string" },
          },
          required: ["kind", "item"],
        },
        {
          type: "object",
          additionalProperties: false,
          properties: {
            kind: { const: "subset" },
            expectedSide: { enum: ["reference", "candidate"] },
            item: { $ref: "#/$defs/rule" },
          },
          required: ["kind", "expectedSide", "item"],
        },
        {
          type: "object",
          additionalProperties: false,
          properties: {
            kind: { const: "error-category" },
            taxonomy: {
              type: "object",
              additionalProperties: false,
              properties: { id: STABLE_ID, version: { type: "string" } },
              required: ["id", "version"],
            },
          },
          required: ["kind", "taxonomy"],
        },
        {
          type: "object",
          additionalProperties: false,
          properties: { kind: { const: "relationship" }, predicate: STABLE_ID },
          required: ["kind", "predicate"],
        },
        {
          type: "object",
          additionalProperties: false,
          properties: { kind: { const: "invariant" }, predicate: { type: "object" } },
          required: ["kind", "predicate"],
        },
        {
          type: "object",
          additionalProperties: false,
          properties: {
            kind: { const: "token-claims" },
            claims: { type: "array", items: { type: "object" } },
          },
          required: ["kind", "claims"],
        },
        {
          type: "object",
          additionalProperties: false,
          properties: { kind: { const: "temporal-invariant" }, expression: { type: "object" } },
          required: ["kind", "expression"],
        },
        {
          type: "object",
          additionalProperties: false,
          properties: {
            kind: { const: "url-redemption" },
            expected: {
              type: "object",
              additionalProperties: false,
              properties: {
                expectStatusCategory: { enum: ["success", "expired", "forbidden"] },
                bytesMustMatch: { type: "boolean" },
              },
              required: ["expectStatusCategory", "bytesMustMatch"],
            },
          },
          required: ["kind", "expected"],
        },
        {
          type: "object",
          additionalProperties: false,
          properties: {
            kind: { const: "state-readback" },
            before: { type: "string" },
            after: { type: "string" },
            delta: {
              type: "object",
              additionalProperties: false,
              properties: {
                expectedChangedPaths: { type: "array", items: { type: "string" } },
                expectedUnchangedPaths: { type: "array", items: { type: "string" } },
              },
              required: ["expectedChangedPaths", "expectedUnchangedPaths"],
            },
          },
          required: ["kind", "before", "after", "delta"],
        },
        {
          type: "object",
          additionalProperties: false,
          properties: {
            kind: { const: "explicit-ignore" },
            reason: { type: "string", minLength: 1 },
            evidence: { type: "array", items: evidenceRefSchema, minItems: 1 },
          },
          required: ["kind", "reason", "evidence"],
        },
      ],
    },
  },
  $ref: "#/$defs/rule",
} as const;

registerSchema(ruleExpressionSchema);

const comparisonRuleSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    id: STABLE_ID,
    version: { type: "string" },
    selector: {
      type: "object",
      additionalProperties: false,
      properties: {
        service: { type: "string" },
        operationId: OPERATION_ID,
        operationVersion: { type: "string" },
        observablePath: { type: "string", minLength: 1 },
        referenceTargetSelector: targetSelectorSchema,
        candidateTargetSelector: targetSelectorSchema,
        capabilityContext: STABLE_ID,
      },
      required: [
        "service",
        "operationId",
        "operationVersion",
        "observablePath",
        "referenceTargetSelector",
        "candidateTargetSelector",
      ],
    },
    inputType: { type: "string" },
    rule: { $ref: "supadiff://schema/rule-expression.json" },
    strictness: { enum: ["contract", "diagnostic"] },
    rationale: { type: "string", minLength: 1 },
    evidence: { type: "array", items: evidenceRefSchema },
  },
  required: [
    "id",
    "version",
    "selector",
    "inputType",
    "rule",
    "strictness",
    "rationale",
    "evidence",
  ],
};

export const COMPARISON_POLICY_SCHEMA = {
  $id: "supadiff://schema/comparison-policy.json",
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  additionalProperties: false,
  properties: {
    format: { const: "supadiff.comparison-policy" },
    formatVersion: { type: "string", pattern: "^\\d+\\.\\d+$" },
    policyId: STABLE_ID,
    policyVersion: { type: "string" },
    rules: { type: "array", items: comparisonRuleSchema },
  },
  required: ["format", "formatVersion", "policyId", "policyVersion", "rules"],
} as const;

registerSchema(COMPARISON_POLICY_SCHEMA);

// The observablePath "*" (bare wildcard) is forbidden as an exact rule selector value (§8.2, §2.12);
// rule selection specificity requires precise paths. This is enforced structurally in validate.ts.
