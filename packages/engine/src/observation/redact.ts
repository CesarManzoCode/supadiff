import type {
  JsonValue,
  RedactedTransportRecord,
  RedactionEntry,
  RedactionReceipt,
  RedactionSecretClass,
} from "@supadiff/spec";
import type { SecretVault } from "../spi/types.js";
import { jsonPointerGet, jsonPointerSet } from "../values/json-pointer.js";
import { scanValueForSecrets } from "./detectors.js";
import { RESPONSE_SECRET_FIELDS } from "./response-secret-map.js";

/** Maps a request-side secret field name to its persisted secret class (§6.4). */
function requestSecretClassFor(fieldName: string): RedactionSecretClass {
  const lower = fieldName.toLowerCase();
  if (lower.includes("refresh")) return "refresh-token";
  if (lower.includes("signedurl")) return "signed-url";
  if (lower.includes("password")) return "password";
  return "api-key";
}

function isSecretRefMarker(v: unknown): v is { $secretRef: string } {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as Record<string, unknown>)["$secretRef"] === "string"
  );
}

/** Deep-clones `input`, replacing every `{$secretRef: handle}` node with the persisted receipt shape. */
function redactRequestBody(
  input: JsonValue,
  entries: RedactionEntry[],
  pathPrefix: string,
): JsonValue {
  if (isSecretRefMarker(input)) {
    const handle = input.$secretRef as `sec-${string}`;
    const fieldName = pathPrefix.split("/").at(-1) ?? "secret";
    const secretClass = requestSecretClassFor(fieldName);
    entries.push({ fieldPath: pathPrefix || "/", secretClass, handle });
    return { $secret: secretClass, handle } as unknown as JsonValue;
  }
  if (Array.isArray(input)) {
    return input.map((v, i) => redactRequestBody(v, entries, `${pathPrefix}/${i}`));
  }
  if (input !== null && typeof input === "object") {
    const out: Record<string, JsonValue> = {};
    for (const [k, v] of Object.entries(input))
      out[k] = redactRequestBody(v, entries, `${pathPrefix}/${k}`);
    return out;
  }
  return input;
}

/** Redacts declared response-side secret fields (§6.2 response tables), storing bytes in the vault. */
function redactResponseBody(
  operationRefId: string,
  body: unknown,
  vault: SecretVault,
  entries: RedactionEntry[],
): unknown {
  const declared = RESPONSE_SECRET_FIELDS[operationRefId];
  if (!declared || body === null || typeof body !== "object") return body;
  const clone: Record<string, unknown> = JSON.parse(JSON.stringify(body));
  for (const field of declared) {
    const value = jsonPointerGet(clone, field.pointer);
    if (typeof value !== "string" || value.length === 0) continue;
    const handle = vault.put(field.secretClass, value);
    entries.push({ fieldPath: field.pointer, secretClass: field.secretClass, handle });
    jsonPointerSet(clone, field.pointer, { $secret: field.secretClass, handle });
  }
  return clone;
}

export interface RedactionInput {
  operationRefId: string;
  requestBody: JsonValue | undefined;
  requestHeaders: Record<string, string> | undefined;
  responseBody: unknown;
  responseHeaders: Record<string, string> | undefined;
  vault: SecretVault;
  /** Author-configured literal secret values to scan for as a secondary detector (§6.4). */
  configuredLiterals: string[];
}

export interface RedactionOutput {
  transport: RedactedTransportRecord;
  receipt: RedactionReceipt;
  /** True if a structural detector found a leak not explained by typed redaction (fail closed). */
  redactionFailed: boolean;
}

export function redactTransport(input: RedactionInput): RedactionOutput {
  const entries: RedactionEntry[] = [];

  const redactedRequestBody =
    input.requestBody !== undefined ? redactRequestBody(input.requestBody, entries, "") : undefined;
  const redactedResponseBody = redactResponseBody(
    input.operationRefId,
    input.responseBody,
    input.vault,
    entries,
  );

  const transport: RedactedTransportRecord = {
    requestHeaders: input.requestHeaders ?? {},
    responseHeaders: input.responseHeaders ?? {},
    ...(redactedRequestBody !== undefined ? { requestBody: redactedRequestBody } : {}),
    ...(redactedResponseBody !== undefined
      ? { responseBody: redactedResponseBody as JsonValue }
      : {}),
  };

  const hits = [
    ...scanValueForSecrets(
      transport.requestBody,
      "/transport/requestBody",
      input.configuredLiterals,
    ),
    ...scanValueForSecrets(
      transport.responseBody,
      "/transport/responseBody",
      input.configuredLiterals,
    ),
    ...scanValueForSecrets(
      transport.requestHeaders,
      "/transport/requestHeaders",
      input.configuredLiterals,
    ),
    ...scanValueForSecrets(
      transport.responseHeaders,
      "/transport/responseHeaders",
      input.configuredLiterals,
    ),
  ];

  return {
    transport,
    receipt: { entries, structuralDetectorHits: hits.length },
    redactionFailed: hits.length > 0,
  };
}
