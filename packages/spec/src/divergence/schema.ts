import { registerSchema } from "../schema-registry.js";

const STABLE_ID = { type: "string", pattern: "^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$" };
const ISO_DATETIME = { type: "string", format: "date-time" };

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
    // Version range MUST NOT be a bare "*" wildcard (§2.12); bounded ranges only.
    versionRange: { type: "string", not: { const: "*" } },
  },
  required: ["kind"],
};

export const KNOWN_DIVERGENCE_SCHEMA = {
  $id: "supadiff://schema/known-divergence.json",
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  additionalProperties: false,
  properties: {
    format: { const: "supadiff.known-divergence" },
    formatVersion: { type: "string", pattern: "^\\d+\\.\\d+$" },
    id: STABLE_ID,
    title: { type: "string", minLength: 1 },
    status: { enum: ["active", "fixed-pending-verification", "resolved", "wont-fix"] },
    referenceSelector: targetSelectorSchema,
    candidateSelector: targetSelectorSchema,
    capability: STABLE_ID,
    scenarioSelector: {
      type: "object",
      additionalProperties: false,
      properties: { scenarioId: STABLE_ID, revisionRange: { type: "string", not: { const: "*" } } },
      required: ["scenarioId"],
    },
    stepSelector: {
      type: "object",
      additionalProperties: false,
      properties: { stepId: STABLE_ID },
      required: ["stepId"],
    },
    // observableSelector MUST NOT be "*" (§2.12): exact JSON Pointer only.
    observableSelector: { type: "string", minLength: 1, not: { const: "*" } },
    rule: {
      type: "object",
      additionalProperties: false,
      properties: { id: STABLE_ID, version: { type: "string", not: { const: "*" } } },
      required: ["id", "version"],
    },
    expectedFailure: {
      type: "object",
      additionalProperties: false,
      properties: { predicate: { type: "object" } },
      required: ["predicate"],
    },
    rationale: { type: "string", minLength: 1 },
    evidence: { type: "array", items: evidenceRefSchema, minItems: 1 },
    upstream: {
      type: "object",
      additionalProperties: false,
      properties: { url: { type: "string" }, issueOrPr: { type: "string" } },
      required: ["url"],
    },
    introduced: { type: "string" },
    verifiedAt: ISO_DATETIME,
    expiresAt: ISO_DATETIME,
    owner: { type: "string", minLength: 1 },
  },
  required: [
    "format",
    "formatVersion",
    "id",
    "title",
    "status",
    "referenceSelector",
    "candidateSelector",
    "scenarioSelector",
    "stepSelector",
    "observableSelector",
    "rule",
    "expectedFailure",
    "rationale",
    "evidence",
    "verifiedAt",
    "expiresAt",
    "owner",
  ],
} as const;

registerSchema(KNOWN_DIVERGENCE_SCHEMA);
