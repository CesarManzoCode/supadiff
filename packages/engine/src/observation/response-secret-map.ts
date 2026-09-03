import type { JsonPointer } from "@supadiff/spec";
import type { RedactionSecretClass } from "@supadiff/spec";

export interface ResponseSecretField {
  pointer: JsonPointer;
  secretClass: RedactionSecretClass;
}

/**
 * Declares which response-body JSON Pointers carry secret bytes for each catalog
 * operation whose fake fixtures exercise this pipeline (§6.2, §6.4). Request-side
 * secret fields are already declared per-operation in the spec catalog
 * (`secretBearingInputFields`); this table is the response-side counterpart, since
 * the contract's secret classes (JWT, refresh token, signed URL, ...) are returned
 * in service responses, not requests.
 */
export const RESPONSE_SECRET_FIELDS: Record<string, ResponseSecretField[]> = {
  "auth.signUp@1": [
    { pointer: "/session/access_token", secretClass: "jwt-access-token" },
    { pointer: "/session/refresh_token", secretClass: "refresh-token" },
  ],
  "auth.signInWithPassword@1": [
    { pointer: "/session/access_token", secretClass: "jwt-access-token" },
    { pointer: "/session/refresh_token", secretClass: "refresh-token" },
  ],
  "auth.refreshSession@1": [
    { pointer: "/session/access_token", secretClass: "jwt-access-token" },
    { pointer: "/session/refresh_token", secretClass: "refresh-token" },
  ],
  "storage.createSignedUrl@1": [{ pointer: "/signedUrl", secretClass: "signed-url" }],
};
