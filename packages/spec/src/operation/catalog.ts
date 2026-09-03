import type { OperationDefinition } from "./types.js";
import { ajv, registerSchema, validateAgainstSchema } from "../schema-registry.js";
import type { JsonValue } from "../json-value.js";

const jsonSchemaObject = (props: object, required: string[] = []) => ({
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  additionalProperties: false,
  properties: props,
  required,
});

/**
 * Initial operation catalog (Architecture Contract §2.4). The catalog knows every ID
 * listed in the contract; only the subset exercised by fake targets in L0-L5 tests has
 * projectors/fixtures implemented downstream. No operation here requires a real Supabase
 * backend to be *declared* — driver support is a separate, later concern (L6+).
 */
const CATALOG_ENTRIES: OperationDefinition[] = [
  {
    id: "schema.apply",
    version: "1",
    service: "schema",
    inputSchema: jsonSchemaObject(
      { resourceId: { type: "string" }, mode: { enum: ["authoritative", "migration"] } },
      ["resourceId", "mode"],
    ),
    secretBearingInputFields: [],
    outputRawCategory: "schema-apply",
    projectorId: "schema.apply@1",
    idempotency: { idempotent: false },
    capabilitiesRequired: ["schema.apply"],
  },
  {
    id: "migration.apply",
    version: "1",
    service: "schema",
    inputSchema: jsonSchemaObject({ resourceId: { type: "string" } }, ["resourceId"]),
    secretBearingInputFields: [],
    outputRawCategory: "schema-apply",
    projectorId: "migration.apply@1",
    idempotency: { idempotent: false },
    capabilitiesRequired: ["migration.apply"],
  },
  {
    id: "data.seed",
    version: "1",
    service: "data",
    inputSchema: jsonSchemaObject(
      { table: { type: "string" }, rows: { type: "array", items: { type: "object" } } },
      ["table", "rows"],
    ),
    secretBearingInputFields: [],
    outputRawCategory: "data-http",
    projectorId: "data.seed@1",
    idempotency: { idempotent: false },
    capabilitiesRequired: ["data.seed"],
  },
  {
    id: "auth.signUp",
    version: "1",
    service: "auth",
    inputSchema: jsonSchemaObject(
      {
        email: { type: "string" },
        password: { $ref: "#/$defs/secretRef" },
        metadata: { type: "object" },
      },
      ["email", "password"],
      // $defs merged below
    ),
    secretBearingInputFields: ["/password"],
    outputRawCategory: "auth-http",
    projectorId: "auth.signUp@1",
    idempotency: { idempotent: false },
    capabilitiesRequired: ["auth.password.signup"],
  },
  {
    id: "auth.signInWithPassword",
    version: "1",
    service: "auth",
    inputSchema: jsonSchemaObject(
      { email: { type: "string" }, password: { $ref: "#/$defs/secretRef" } },
      ["email", "password"],
    ),
    secretBearingInputFields: ["/password"],
    outputRawCategory: "auth-http",
    projectorId: "auth.signInWithPassword@1",
    idempotency: { idempotent: false },
    capabilitiesRequired: ["auth.password.signin"],
  },
  {
    id: "auth.getUser",
    version: "1",
    service: "auth",
    inputSchema: jsonSchemaObject({}, []),
    secretBearingInputFields: [],
    outputRawCategory: "auth-http",
    projectorId: "auth.getUser@1",
    idempotency: { idempotent: true },
    capabilitiesRequired: ["auth.session.read"],
  },
  {
    id: "auth.updateUser",
    version: "1",
    service: "auth",
    inputSchema: jsonSchemaObject({ metadata: { type: "object" } }, []),
    secretBearingInputFields: [],
    outputRawCategory: "auth-http",
    projectorId: "auth.updateUser@1",
    idempotency: { idempotent: false },
    capabilitiesRequired: ["auth.user.update"],
  },
  {
    id: "auth.refreshSession",
    version: "1",
    service: "auth",
    inputSchema: jsonSchemaObject({ refreshToken: { $ref: "#/$defs/secretRef" } }, [
      "refreshToken",
    ]),
    secretBearingInputFields: ["/refreshToken"],
    outputRawCategory: "auth-http",
    projectorId: "auth.refreshSession@1",
    idempotency: { idempotent: false },
    capabilitiesRequired: ["auth.session.refresh"],
  },
  {
    id: "auth.signOut",
    version: "1",
    service: "auth",
    inputSchema: jsonSchemaObject({}, []),
    secretBearingInputFields: [],
    outputRawCategory: "auth-http",
    projectorId: "auth.signOut@1",
    idempotency: { idempotent: true },
    capabilitiesRequired: ["auth.session.revoke"],
  },
  {
    id: "data.select",
    version: "1",
    service: "data",
    inputSchema: jsonSchemaObject(
      {
        table: { type: "string" },
        filters: { type: "array", items: { type: "object" } },
        order: { type: "array", items: { type: "object" } },
        limit: { type: "integer", minimum: 0 },
      },
      ["table"],
    ),
    secretBearingInputFields: [],
    outputRawCategory: "data-http",
    projectorId: "data.select@1",
    idempotency: { idempotent: true },
    capabilitiesRequired: ["data.select"],
  },
  {
    id: "data.insert",
    version: "1",
    service: "data",
    inputSchema: jsonSchemaObject(
      {
        table: { type: "string" },
        rows: { type: "array", items: { type: "object" } },
        returning: { type: "boolean" },
      },
      ["table", "rows"],
    ),
    secretBearingInputFields: [],
    outputRawCategory: "data-http",
    projectorId: "data.insert@1",
    idempotency: { idempotent: false },
    capabilitiesRequired: ["data.insert"],
  },
  {
    id: "data.update",
    version: "1",
    service: "data",
    inputSchema: jsonSchemaObject(
      {
        table: { type: "string" },
        filters: { type: "array", items: { type: "object" } },
        patch: { type: "object" },
      },
      ["table", "filters", "patch"],
    ),
    secretBearingInputFields: [],
    outputRawCategory: "data-http",
    projectorId: "data.update@1",
    idempotency: { idempotent: false },
    capabilitiesRequired: ["data.update"],
  },
  {
    id: "data.upsert",
    version: "1",
    service: "data",
    inputSchema: jsonSchemaObject(
      {
        table: { type: "string" },
        rows: { type: "array", items: { type: "object" } },
        onConflict: { type: "string" },
      },
      ["table", "rows"],
    ),
    secretBearingInputFields: [],
    outputRawCategory: "data-http",
    projectorId: "data.upsert@1",
    idempotency: { idempotent: true, idempotencyKeyField: "/onConflict" },
    capabilitiesRequired: ["data.upsert"],
  },
  {
    id: "data.delete",
    version: "1",
    service: "data",
    inputSchema: jsonSchemaObject(
      { table: { type: "string" }, filters: { type: "array", items: { type: "object" } } },
      ["table", "filters"],
    ),
    secretBearingInputFields: [],
    outputRawCategory: "data-http",
    projectorId: "data.delete@1",
    idempotency: { idempotent: false },
    capabilitiesRequired: ["data.delete"],
  },
  {
    id: "http.preflight",
    version: "1",
    service: "data",
    inputSchema: jsonSchemaObject({ service: { enum: ["data", "auth", "storage"] } }, ["service"]),
    secretBearingInputFields: [],
    outputRawCategory: "data-http",
    projectorId: "http.preflight@1",
    idempotency: { idempotent: true },
    capabilitiesRequired: ["http.preflight"],
  },
  {
    id: "storage.createBucket",
    version: "1",
    service: "storage",
    inputSchema: jsonSchemaObject({ bucket: { type: "string" }, public: { type: "boolean" } }, [
      "bucket",
    ]),
    secretBearingInputFields: [],
    outputRawCategory: "storage-http",
    projectorId: "storage.createBucket@1",
    idempotency: { idempotent: false },
    capabilitiesRequired: ["storage.bucket.create"],
  },
  {
    id: "storage.upload",
    version: "1",
    service: "storage",
    inputSchema: jsonSchemaObject(
      { bucket: { type: "string" }, path: { type: "string" }, resourceId: { type: "string" } },
      ["bucket", "path", "resourceId"],
    ),
    secretBearingInputFields: [],
    outputRawCategory: "storage-http",
    projectorId: "storage.upload@1",
    idempotency: { idempotent: false },
    capabilitiesRequired: ["storage.object.write"],
  },
  {
    id: "storage.download",
    version: "1",
    service: "storage",
    inputSchema: jsonSchemaObject({ bucket: { type: "string" }, path: { type: "string" } }, [
      "bucket",
      "path",
    ]),
    secretBearingInputFields: [],
    outputRawCategory: "storage-http",
    projectorId: "storage.download@1",
    idempotency: { idempotent: true },
    capabilitiesRequired: ["storage.object.read"],
  },
  {
    id: "storage.list",
    version: "1",
    service: "storage",
    inputSchema: jsonSchemaObject({ bucket: { type: "string" }, prefix: { type: "string" } }, [
      "bucket",
    ]),
    secretBearingInputFields: [],
    outputRawCategory: "storage-http",
    projectorId: "storage.list@1",
    idempotency: { idempotent: true },
    capabilitiesRequired: ["storage.object.read"],
  },
  {
    id: "storage.remove",
    version: "1",
    service: "storage",
    inputSchema: jsonSchemaObject(
      { bucket: { type: "string" }, paths: { type: "array", items: { type: "string" } } },
      ["bucket", "paths"],
    ),
    secretBearingInputFields: [],
    outputRawCategory: "storage-http",
    projectorId: "storage.remove@1",
    idempotency: { idempotent: true },
    capabilitiesRequired: ["storage.object.write"],
  },
  {
    id: "storage.move",
    version: "1",
    service: "storage",
    inputSchema: jsonSchemaObject(
      { bucket: { type: "string" }, from: { type: "string" }, to: { type: "string" } },
      ["bucket", "from", "to"],
    ),
    secretBearingInputFields: [],
    outputRawCategory: "storage-http",
    projectorId: "storage.move@1",
    idempotency: { idempotent: false },
    capabilitiesRequired: ["storage.object.write"],
  },
  {
    id: "storage.copy",
    version: "1",
    service: "storage",
    inputSchema: jsonSchemaObject(
      { bucket: { type: "string" }, from: { type: "string" }, to: { type: "string" } },
      ["bucket", "from", "to"],
    ),
    secretBearingInputFields: [],
    outputRawCategory: "storage-http",
    projectorId: "storage.copy@1",
    idempotency: { idempotent: false },
    capabilitiesRequired: ["storage.object.write"],
  },
  {
    id: "storage.createSignedUrl",
    version: "1",
    service: "storage",
    inputSchema: jsonSchemaObject(
      {
        bucket: { type: "string" },
        path: { type: "string" },
        expiresInSeconds: { type: "integer", minimum: 1 },
      },
      ["bucket", "path", "expiresInSeconds"],
    ),
    secretBearingInputFields: [],
    outputRawCategory: "storage-http",
    projectorId: "storage.createSignedUrl@1",
    idempotency: { idempotent: false },
    capabilitiesRequired: ["storage.signed-url.create"],
  },
  {
    id: "storage.redeemUrl",
    version: "1",
    service: "storage",
    inputSchema: jsonSchemaObject({ signedUrlHandle: { $ref: "#/$defs/secretRef" } }, [
      "signedUrlHandle",
    ]),
    secretBearingInputFields: ["/signedUrlHandle"],
    outputRawCategory: "storage-http",
    projectorId: "storage.redeemUrl@1",
    idempotency: { idempotent: false },
    capabilitiesRequired: ["storage.signed-url.redeem"],
  },
  {
    id: "cli.invoke",
    version: "1",
    service: "cli",
    inputSchema: jsonSchemaObject(
      {
        executable: { type: "string" },
        argv: { type: "array", items: { type: "string" } },
        cwd: { type: "string" },
        envRefs: { type: "array", items: { type: "string" } },
      },
      ["executable", "argv"],
    ),
    secretBearingInputFields: [],
    outputRawCategory: "cli-invocation",
    projectorId: "cli.invoke@1",
    idempotency: { idempotent: false },
    capabilitiesRequired: ["cli.invoke"],
  },
  {
    id: "observe.dataReadback",
    version: "1",
    service: "data",
    inputSchema: jsonSchemaObject(
      { table: { type: "string" }, filters: { type: "array", items: { type: "object" } } },
      ["table"],
    ),
    secretBearingInputFields: [],
    outputRawCategory: "observer",
    projectorId: "observe.dataReadback@1",
    idempotency: { idempotent: true },
    capabilitiesRequired: ["data.select"],
  },
  {
    id: "observe.authSession",
    version: "1",
    service: "auth",
    inputSchema: jsonSchemaObject({}, []),
    secretBearingInputFields: [],
    outputRawCategory: "observer",
    projectorId: "observe.authSession@1",
    idempotency: { idempotent: true },
    capabilitiesRequired: ["auth.session.read"],
  },
  {
    id: "observe.storageObject",
    version: "1",
    service: "storage",
    inputSchema: jsonSchemaObject({ bucket: { type: "string" }, path: { type: "string" } }, [
      "bucket",
      "path",
    ]),
    secretBearingInputFields: [],
    outputRawCategory: "observer",
    projectorId: "observe.storageObject@1",
    idempotency: { idempotent: true },
    capabilitiesRequired: ["storage.object.read"],
  },
  {
    id: "observe.schemaSurface",
    version: "1",
    service: "schema",
    inputSchema: jsonSchemaObject({ table: { type: "string" } }, []),
    secretBearingInputFields: [],
    outputRawCategory: "observer",
    projectorId: "observe.schemaSurface@1",
    idempotency: { idempotent: true },
    capabilitiesRequired: ["schema.introspect"],
  },
  {
    id: "observe.projectTree",
    version: "1",
    service: "cli",
    inputSchema: jsonSchemaObject({ paths: { type: "array", items: { type: "string" } } }, [
      "paths",
    ]),
    secretBearingInputFields: [],
    outputRawCategory: "observer",
    projectorId: "observe.projectTree@1",
    idempotency: { idempotent: true },
    capabilitiesRequired: ["cli.projectTree.read"],
  },
  {
    id: "assert.invariant",
    version: "1",
    service: "data",
    inputSchema: jsonSchemaObject({ predicate: { type: "object" } }, ["predicate"]),
    secretBearingInputFields: [],
    outputRawCategory: "assertion",
    projectorId: "assert.invariant@1",
    idempotency: { idempotent: true },
    capabilitiesRequired: [],
  },
  {
    id: "control.barrier",
    version: "1",
    service: "control",
    inputSchema: jsonSchemaObject({ label: { type: "string" } }, ["label"]),
    secretBearingInputFields: [],
    outputRawCategory: "control",
    projectorId: "control.barrier@1",
    idempotency: { idempotent: true },
    capabilitiesRequired: ["execution.controlled-concurrency"],
  },
];

/** Injects the shared `$defs.secretRef` closed shape into every input schema (mechanical helper). */
const SECRET_REF_DEF = {
  type: "object",
  additionalProperties: false,
  properties: {
    $secretRef: { type: "string" },
  },
  required: ["$secretRef"],
};

for (const entry of CATALOG_ENTRIES) {
  (entry.inputSchema as Record<string, unknown>)["$defs"] = { secretRef: SECRET_REF_DEF };
}

export const OPERATION_CATALOG: ReadonlyMap<string, OperationDefinition> = new Map(
  CATALOG_ENTRIES.map((e) => [`${e.id}@${e.version}`, e]),
);

export function getOperationDefinition(
  id: string,
  version: string,
): OperationDefinition | undefined {
  return OPERATION_CATALOG.get(`${id}@${version}`);
}

export function isKnownOperation(id: string, version: string): boolean {
  return OPERATION_CATALOG.has(`${id}@${version}`);
}

/**
 * Validates `input` against the catalog operation's JSON Schema (§2.4 step 3: "validate
 * resolved input against the operation schema"). Registers the schema on first use.
 */
export function validateOperationInput(id: string, version: string, input: unknown): void {
  const def = getOperationDefinition(id, version);
  if (!def) throw new Error(`validateOperationInput: unknown operation "${id}@${version}"`);
  const schemaId = `supadiff://schema/operation-input/${id}@${version}.json`;
  if (!ajv.getSchema(schemaId)) {
    registerSchema({ ...def.inputSchema, $id: schemaId } as object & { $id: string });
  }
  validateAgainstSchema(schemaId, input as JsonValue);
}

export { CATALOG_ENTRIES as OPERATION_CATALOG_ENTRIES };
export type { OperationDefinition } from "./types.js";
