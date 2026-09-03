import { createRequire } from "node:module";
import type { ValidateFunction } from "ajv";
import { issue, SpecValidationError, type ValidationIssue } from "./errors.js";
import type { JsonValue } from "./json-value.js";

// Loaded via createRequire: Ajv/ajv-formats ship CJS-only runtime entrypoints whose
// default-export typings do not interoperate cleanly with NodeNext ESM value-import
// checking. The structural interface below is the only surface this module needs.
const require = createRequire(import.meta.url);

interface AjvInstance {
  addSchema(schema: object, key?: string): void;
  getSchema(key: string): ValidateFunction | undefined;
}
interface Ajv2020Ctor {
  new (opts: {
    strict: boolean;
    allErrors: boolean;
    allowUnionTypes: boolean;
    $data: boolean;
  }): AjvInstance;
}

const Ajv2020 = require("ajv/dist/2020.js") as unknown as Ajv2020Ctor;
const addFormats = require("ajv-formats") as (ajv: AjvInstance) => void;

/**
 * Single shared Ajv instance. Every persisted-format schema is registered here so
 * `$ref` between schemas resolves and `additionalProperties: false` is enforced
 * uniformly (closed schemas per §2.2 invariants and §13.2).
 */
export const ajv: AjvInstance = new Ajv2020({
  strict: true,
  allErrors: true,
  allowUnionTypes: true,
  $data: true,
});
addFormats(ajv);

const compiledCache = new Map<string, ValidateFunction>();

export function registerSchema(schema: object & { $id: string }): void {
  if (ajv.getSchema(schema.$id)) return;
  ajv.addSchema(schema, schema.$id);
}

function ajvErrorsToIssues(errors: ValidateFunction["errors"]): ValidationIssue[] {
  if (!errors || errors.length === 0) {
    return [issue("/", "unknown", "schema validation failed with no error detail")];
  }
  return errors.map((e) =>
    issue(e.instancePath || "/", `schema.${e.keyword}`, e.message ?? "schema validation failed"),
  );
}

/**
 * Validates `data` against the schema registered under `schemaId` and throws
 * `SpecValidationError` on failure. Returns the same value narrowed to `T` on success.
 */
export function validateAgainstSchema<T>(schemaId: string, data: JsonValue): T {
  let validateFn = compiledCache.get(schemaId);
  if (!validateFn) {
    const found = ajv.getSchema(schemaId);
    if (!found) throw new Error(`schema-registry: unknown schema id "${schemaId}"`);
    validateFn = found;
    compiledCache.set(schemaId, validateFn);
  }
  const ok = validateFn(data);
  if (!ok) {
    throw new SpecValidationError(ajvErrorsToIssues(validateFn.errors));
  }
  return data as T;
}
