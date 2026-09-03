import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import type { Sha256 } from "./ids.js";
import type { JsonValue } from "./json-value.js";

// `canonicalize` (RFC 8785 JSON Canonicalization Scheme) ships CJS-only typings that
// do not interoperate cleanly with NodeNext ESM default-import type checking; loading
// it via createRequire keeps both the runtime behavior and the type surface exact.
const require = createRequire(import.meta.url);
const canonicalizeImpl = require("canonicalize") as (value: unknown) => string | undefined;

/**
 * Produces the RFC 8785 canonical JSON serialization of a value.
 * Digests cover this canonical form, never source formatting (§3.1).
 */
export function canonicalizeJson(value: JsonValue): string {
  const result = canonicalizeImpl(value);
  if (result === undefined) {
    throw new TypeError("canonicalizeJson: value is not representable as JSON (undefined)");
  }
  return result;
}

/** SHA-256 digest of raw bytes, formatted as the persisted `sha256:<hex>` form (§2.1). */
export function sha256OfBytes(bytes: Uint8Array | string): Sha256 {
  const hash = createHash("sha256").update(bytes).digest("hex");
  return `sha256:${hash}`;
}

/** SHA-256 digest of the RFC 8785 canonical form of a JSON value. */
export function sha256OfCanonicalJson(value: JsonValue): Sha256 {
  return sha256OfBytes(canonicalizeJson(value));
}
