import { registerSchema } from "../schema-registry.js";

const STABLE_ID = { type: "string", pattern: "^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$" };
const SHA256 = { type: "string", pattern: "^sha256:[0-9a-f]{64}$" };
// See comparison/schema.ts for why operation catalog IDs get their own, case-permitting
// pattern distinct from author-chosen StableIds (§2.1 vs §2.4's literal catalog names).
const OPERATION_ID = { type: "string", pattern: "^[a-zA-Z][a-zA-Z0-9]*(?:[._-][a-zA-Z0-9]+)*$" };

const capabilityRequirementSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    capability: STABLE_ID,
    range: { type: "string", minLength: 1 },
    accept: {
      type: "array",
      items: { enum: ["exact", "approximation", "experimental"] },
      minItems: 1,
    },
    constraints: { type: "object" },
  },
  required: ["capability", "range", "accept"],
};

const resourceDeclarationSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    id: STABLE_ID,
    mediaType: { type: "string" },
    sha256: SHA256,
    length: { type: "integer", minimum: 0 },
    source: {
      oneOf: [
        {
          type: "object",
          additionalProperties: false,
          properties: { kind: { const: "inline" }, value: { type: "string" } },
          required: ["kind", "value"],
        },
        {
          type: "object",
          additionalProperties: false,
          properties: { kind: { const: "content" }, path: { type: "string" } },
          required: ["kind", "path"],
        },
      ],
    },
    sensitivity: { enum: ["public-fixture", "generated-fixture"] },
  },
  required: ["id", "mediaType", "sha256", "length", "source", "sensitivity"],
};

const actorSpecSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    id: STABLE_ID,
    kind: { enum: ["anonymous", "user", "service"] },
    identity: {
      type: "object",
      additionalProperties: false,
      properties: {
        emailTemplate: { type: "string" },
        stableSubject: { type: "boolean" },
        metadata: {},
      },
    },
    credentialSource: {
      oneOf: [
        {
          type: "object",
          additionalProperties: false,
          properties: {
            kind: { const: "generated" },
            recipe: {
              type: "object",
              additionalProperties: false,
              properties: { id: STABLE_ID, version: { type: "string" } },
              required: ["id", "version"],
            },
          },
          required: ["kind", "recipe"],
        },
        {
          type: "object",
          additionalProperties: false,
          properties: { kind: { const: "external" }, secretRef: STABLE_ID },
          required: ["kind", "secretRef"],
        },
        {
          type: "object",
          additionalProperties: false,
          properties: { kind: { const: "none" } },
          required: ["kind"],
        },
      ],
    },
    initialContext: { enum: ["anonymous", "service-key"] },
    sessionPolicy: { enum: ["fresh-per-target", "refresh-within-target", "transition-reauth"] },
  },
  required: ["id", "kind", "credentialSource", "initialContext", "sessionPolicy"],
};

const captureFromSchema = {
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      properties: { kind: { const: "json-pointer" }, pointer: { type: "string" } },
      required: ["kind", "pointer"],
    },
    {
      type: "object",
      additionalProperties: false,
      properties: { kind: { const: "header" }, name: { type: "string" } },
      required: ["kind", "name"],
    },
    {
      type: "object",
      additionalProperties: false,
      properties: { kind: { const: "semantic" }, field: { type: "string" } },
      required: ["kind", "field"],
    },
  ],
};

const captureSpecSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    name: STABLE_ID,
    from: captureFromSchema,
    valueType: {
      enum: [
        "string",
        "number",
        "boolean",
        "object",
        "array",
        "null",
        "identifier",
        "secret-handle",
      ],
    },
    sensitivity: { enum: ["public", "identifier", "secret"] },
    required: { type: "boolean" },
  },
  required: ["name", "from", "valueType", "sensitivity", "required"],
};

const observationRequestSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    id: STABLE_ID,
    operation: {
      type: "object",
      additionalProperties: false,
      properties: { id: OPERATION_ID, version: { type: "string" } },
      required: ["id", "version"],
    },
    input: { type: "object" },
  },
  required: ["id", "operation", "input"],
};

const retrySpecSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    maxAttempts: { type: "integer", minimum: 0 },
    retryableCategories: { type: "array", items: { type: "string" } },
    backoffMs: { type: "integer", minimum: 0 },
    idempotencyProof: { enum: ["catalog-idempotent", "stable-idempotency-key"] },
  },
  required: ["maxAttempts", "retryableCategories", "backoffMs", "idempotencyProof"],
};

const STEP_KINDS = [
  "schema.apply",
  "migration.apply",
  "data.seed",
  "auth.signUp",
  "auth.signInWithPassword",
  "auth.getUser",
  "auth.updateUser",
  "auth.refreshSession",
  "auth.signOut",
  "data.select",
  "data.insert",
  "data.update",
  "data.upsert",
  "data.delete",
  "http.preflight",
  "storage.createBucket",
  "storage.upload",
  "storage.download",
  "storage.list",
  "storage.remove",
  "storage.move",
  "storage.copy",
  "storage.createSignedUrl",
  "storage.redeemUrl",
  "cli.invoke",
  "observe.dataReadback",
  "observe.authSession",
  "observe.storageObject",
  "observe.schemaSurface",
  "observe.projectTree",
  "assert.invariant",
  "control.barrier",
];

const stepSpecSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    id: STABLE_ID,
    kind: { enum: STEP_KINDS },
    phase: { enum: ["bootstrap", "exercise", "probe"] },
    actor: STABLE_ID,
    requires: { type: "array", items: capabilityRequirementSchema },
    dependsOn: { type: "array", items: STABLE_ID },
    input: { type: "object" },
    capture: { type: "array", items: captureSpecSchema },
    observe: { type: "array", items: observationRequestSchema },
    timeoutMs: { type: "integer", minimum: 0 },
    retry: retrySpecSchema,
    onUnsupported: { enum: ["skip-step", "skip-scenario"] },
  },
  required: ["id", "kind", "phase", "input"],
};

const cleanupSpecSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    id: STABLE_ID,
    operation: {
      type: "object",
      additionalProperties: false,
      properties: { id: OPERATION_ID, version: { type: "string" } },
      required: ["id", "version"],
    },
    input: { type: "object" },
    timeoutMs: { type: "integer", minimum: 0 },
  },
  required: ["id", "operation", "input", "timeoutMs"],
};

export const SCENARIO_SCHEMA = {
  $id: "supadiff://schema/scenario.json",
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  additionalProperties: false,
  properties: {
    format: { const: "supadiff.scenario" },
    formatVersion: { type: "string", pattern: "^\\d+\\.\\d+$" },
    id: STABLE_ID,
    revision: { type: "string", minLength: 1 },
    title: { type: "string", minLength: 1 },
    description: { type: "string" },
    tags: { type: "array", items: { type: "string" } },
    seed: { type: "string", pattern: "^(0|[1-9][0-9]{0,19})$" },
    client: {
      type: "object",
      additionalProperties: false,
      properties: {
        library: { enum: ["supabase-js", "raw-http"] },
        version: { type: "string" },
      },
      required: ["library", "version"],
    },
    requirements: { type: "array", items: capabilityRequirementSchema },
    resources: { type: "array", items: resourceDeclarationSchema },
    actors: { type: "array", items: actorSpecSchema },
    steps: { type: "array", items: stepSpecSchema },
    cleanup: { type: "array", items: cleanupSpecSchema },
    comparison: {
      type: "object",
      additionalProperties: false,
      properties: { policyId: STABLE_ID, policyVersion: { type: "string" } },
      required: ["policyId", "policyVersion"],
    },
    expectedOutcomes: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          kind: { enum: ["known-divergence", "accepted-approximation"] },
          id: STABLE_ID,
        },
        required: ["kind", "id"],
      },
    },
    limits: {
      type: "object",
      additionalProperties: false,
      properties: {
        maxSteps: { type: "integer", minimum: 1 },
        maxWallTimeMs: { type: "integer", minimum: 1 },
        maxArtifactBytes: { type: "integer", minimum: 1 },
        maxRequestsPerTarget: { type: "integer", minimum: 1 },
        maxHostedCostUsd: { type: "number", minimum: 0 },
        maxParallelOperations: { type: "integer", minimum: 1, maximum: 1 },
      },
      required: [
        "maxSteps",
        "maxWallTimeMs",
        "maxArtifactBytes",
        "maxRequestsPerTarget",
        "maxHostedCostUsd",
        "maxParallelOperations",
      ],
    },
    provenance: {
      type: "object",
      additionalProperties: false,
      properties: {
        origin: { enum: ["authored", "generated", "reduced", "imported", "upstream-derived"] },
        createdAt: { type: "string" },
        author: { type: "string" },
        generatedBy: {
          type: "object",
          additionalProperties: false,
          properties: { id: STABLE_ID, version: { type: "string" } },
          required: ["id", "version"],
        },
      },
      required: ["origin", "createdAt"],
    },
  },
  required: [
    "format",
    "formatVersion",
    "id",
    "revision",
    "title",
    "tags",
    "seed",
    "client",
    "requirements",
    "resources",
    "actors",
    "steps",
    "cleanup",
    "comparison",
    "expectedOutcomes",
    "limits",
    "provenance",
  ],
} as const;

registerSchema(SCENARIO_SCHEMA);
