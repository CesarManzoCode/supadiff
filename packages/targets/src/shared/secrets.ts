import type { SecretVault } from "@supadiff/engine/spi";
import type { JsonValue } from "@supadiff/spec";

function isSecretRefMarker(v: unknown): v is { $secretRef: string } {
  return (
    typeof v === "object" &&
    v !== null &&
    !Array.isArray(v) &&
    typeof (v as Record<string, unknown>)["$secretRef"] === "string"
  );
}

/**
 * Reveals every `{$secretRef: <handle>}` marker in a resolved step input into its real
 * secret value (§2.6, §4.5: "only driver code may call `vault.reveal()` at dispatch
 * time"). The result is dispatch-only — it MUST NOT be persisted, logged, or returned
 * as part of a `RawOperationResult`; only the engine's own redaction pipeline decides
 * what response-side data is safe to keep (via `RESPONSE_SECRET_FIELDS`).
 */
export function revealSecretRefs(input: JsonValue, vault: SecretVault): JsonValue {
  if (isSecretRefMarker(input)) {
    return vault.reveal(input.$secretRef as `sec-${string}`);
  }
  if (Array.isArray(input)) {
    return input.map((v) => revealSecretRefs(v, vault));
  }
  if (input !== null && typeof input === "object") {
    const out: Record<string, JsonValue> = {};
    for (const [k, v] of Object.entries(input)) out[k] = revealSecretRefs(v, vault);
    return out;
  }
  return input;
}
