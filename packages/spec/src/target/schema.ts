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

/**
 * Closed config schema shared by all four Supalite backends (§4.4: "Admin mode,
 * `forceRollback`, experimental feature flags, key mode, and route prefixes are
 * mandatory explicit config fields. Defaults may be expanded by the compiler but are
 * always written to the plan."). Every field here is REQUIRED — no implicit engine
 * default is allowed to silently decide RLS/privilege-relevant behavior.
 */
function supaliteConfigSchema(id: string) {
  return {
    $id: id,
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    additionalProperties: false,
    properties: {
      admin: {
        type: "boolean",
        description:
          "Local admin mode (§4.4, README ServerOptions.admin): keyless same-origin/loopback " +
          "requests are elevated to service_role. MUST be false for any RLS/privilege-relevant scenario.",
      },
      forceRollback: {
        type: "boolean",
        description:
          "Test-only PostgREST mode: wraps each request in a transaction and rolls it back.",
      },
      experimentalFeatures: {
        type: "array",
        items: { enum: ["storage"] },
        description: "Feature-gated surfaces to enable, e.g. EXPERIMENTAL_STORAGE.",
      },
      keyMode: {
        const: "opaque-v1",
        description:
          "Opaque sb_publishable_*/sb_secret_* keys only (§2.4 GT); legacy JWT-as-apikey is not " +
          "supported by this package version and is never modeled as a config option.",
      },
      routePrefixes: {
        type: "object",
        additionalProperties: false,
        properties: {
          auth: { type: "string", minLength: 1 },
          rest: { type: "string", minLength: 1 },
          storage: { type: "string", minLength: 1 },
        },
        required: ["auth", "rest", "storage"],
      },
      transport: {
        enum: ["socket-server"],
        description:
          "§4.4: in-process Fetch and socket-server transports are distinct capabilities; this " +
          "build only implements socket-server (a real spawned `lite start` process on a leased port).",
      },
      readinessTimeoutMs: { type: "integer", minimum: 1000 },
    },
    required: [
      "admin",
      "forceRollback",
      "experimentalFeatures",
      "keyMode",
      "routePrefixes",
      "transport",
      "readinessTimeoutMs",
    ],
  } as const;
}

export const SUPALITE_SQLITE_CONFIG_SCHEMA = supaliteConfigSchema(
  "supadiff://schema/target-config/supalite-sqlite.json",
);
export const SUPALITE_SQLITE_POSTGRES_CONFIG_SCHEMA = supaliteConfigSchema(
  "supadiff://schema/target-config/supalite-sqlite-postgres.json",
);
export const SUPALITE_PGLITE_CONFIG_SCHEMA = supaliteConfigSchema(
  "supadiff://schema/target-config/supalite-pglite.json",
);
export const SUPALITE_POSTGRES_CONFIG_SCHEMA = supaliteConfigSchema(
  "supadiff://schema/target-config/supalite-postgres.json",
);
registerSchema(SUPALITE_SQLITE_CONFIG_SCHEMA);
registerSchema(SUPALITE_SQLITE_POSTGRES_CONFIG_SCHEMA);
registerSchema(SUPALITE_PGLITE_CONFIG_SCHEMA);
registerSchema(SUPALITE_POSTGRES_CONFIG_SCHEMA);

/**
 * Closed config schema for the `supabase-local` target kind (§2.7, §4.4; L7). A real
 * Supabase local stack provisioned by a pinned `supabase` CLI over Docker Compose
 * (Postgres + GoTrue + PostgREST + Storage API + Kong). Every field is REQUIRED for the
 * same reason the Supalite schema requires all of its own: no implicit engine default may
 * silently decide an RLS/privilege/version-relevant fact, and the compiler always writes
 * the resolved value into the plan.
 */
export const SUPABASE_LOCAL_CONFIG_SCHEMA = {
  $id: "supadiff://schema/target-config/supabase-local.json",
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  additionalProperties: false,
  properties: {
    dbMajorVersion: {
      type: "integer",
      minimum: 13,
      maximum: 17,
      description:
        "PostgreSQL major version the local stack runs (`[db].major_version` in the generated " +
        "config.toml). Explicit because it is the axis L8's upgrade verification moves along.",
    },
    excludedServices: {
      type: "array",
      items: {
        enum: [
          "realtime",
          "imgproxy",
          "mailpit",
          "postgres-meta",
          "studio",
          "edge-runtime",
          "logflare",
          "vector",
          "supavisor",
        ],
      },
      description:
        "Compose services the driver passes to `supabase start -x`. `db`, `kong`, `gotrue`, " +
        "`postgrest`, and (when storage is enabled) `storage-api` are never excludable — they are " +
        "the observable surface this build compares.",
    },
    experimentalFeatures: {
      type: "array",
      items: { enum: ["storage"] },
      description: "Feature surfaces to enable; `storage` starts the Storage API container.",
    },
    keyMode: {
      const: "opaque-v1",
      description:
        "Opaque sb_publishable_*/sb_secret_* API keys (the CLI's current default). Legacy " +
        "JWT-as-apikey is not modeled as a config option, matching the Supalite schema.",
    },
    routePrefixes: {
      type: "object",
      additionalProperties: false,
      properties: {
        auth: { type: "string", minLength: 1 },
        rest: { type: "string", minLength: 1 },
        storage: { type: "string", minLength: 1 },
      },
      required: ["auth", "rest", "storage"],
    },
    analytics: {
      type: "boolean",
      description:
        "Whether the Logflare/Vector analytics pipeline is enabled. `false` for a lean, " +
        "reproducible comparison stack; the CLI otherwise requires it and it drags in two more " +
        "containers plus a fixed 4000/tcp port.",
    },
    readinessTimeoutMs: { type: "integer", minimum: 1000 },
  },
  required: [
    "dbMajorVersion",
    "excludedServices",
    "experimentalFeatures",
    "keyMode",
    "routePrefixes",
    "analytics",
    "readinessTimeoutMs",
  ],
} as const;
registerSchema(SUPABASE_LOCAL_CONFIG_SCHEMA);

/** Per-`TargetKind` closed config schema `$id`s. `supabase-hosted` remains L13 (not registered). */
export const TARGET_CONFIG_SCHEMA_BY_KIND: Record<string, string> = {
  fake: FAKE_TARGET_CONFIG_SCHEMA.$id,
  "supalite-sqlite": SUPALITE_SQLITE_CONFIG_SCHEMA.$id,
  "supalite-sqlite-postgres": SUPALITE_SQLITE_POSTGRES_CONFIG_SCHEMA.$id,
  "supalite-pglite": SUPALITE_PGLITE_CONFIG_SCHEMA.$id,
  "supalite-postgres": SUPALITE_POSTGRES_CONFIG_SCHEMA.$id,
  "supabase-local": SUPABASE_LOCAL_CONFIG_SCHEMA.$id,
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
