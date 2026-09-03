import { isValueRef, captureNameOf, type JsonObject, type JsonValue } from "@supadiff/spec";
import type { SecretHandle } from "../spi/types.js";
import type { CapturedValueStore } from "./store.js";

export interface RefResolutionContext {
  targetSlot: string;
  captures: CapturedValueStore;
  /** Named secret refs resolvable in this step's actor scope: credential recipe ids and external secretRefs. */
  namedSecrets: ReadonlyMap<string, SecretHandle>;
}

export class RefResolutionError extends Error {}

function isSecretRefNode(value: unknown): value is { $secretRef: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as Record<string, unknown>)["$secretRef"] === "string"
  );
}

/**
 * Resolves every `{$ref: "capture:<name>"}` and `{$secretRef: "<name>"}` node in `input`
 * against the current target-local value store, producing a plain payload ready for
 * dispatch. Secret-bearing fields are never revealed here — they are normalized to
 * `{$secretRef: <opaque handle>}`, which only driver code may `vault.reveal()` (§2.6).
 */
export function resolveRefs(input: JsonValue, ctx: RefResolutionContext): JsonValue {
  if (isValueRef(input)) {
    const name = captureNameOf(input);
    const record = ctx.captures.get(ctx.targetSlot, name);
    if (!record) throw new RefResolutionError(`unresolved capture reference "${name}"`);
    if (record.sensitivity === "secret") {
      if (!record.secretHandle)
        throw new RefResolutionError(`capture "${name}" is secret but has no handle`);
      return { $secretRef: record.secretHandle };
    }
    return record.persistedValue ?? null;
  }
  if (isSecretRefNode(input)) {
    const handle = ctx.namedSecrets.get(input.$secretRef);
    if (!handle) throw new RefResolutionError(`unresolved named secret "${input.$secretRef}"`);
    return { $secretRef: handle };
  }
  if (Array.isArray(input)) {
    return input.map((v) => resolveRefs(v, ctx));
  }
  if (typeof input === "object" && input !== null) {
    const out: JsonObject = {};
    for (const [k, v] of Object.entries(input)) out[k] = resolveRefs(v, ctx);
    return out;
  }
  return input;
}
