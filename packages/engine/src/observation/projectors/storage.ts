import type { RawObservation, SemanticObservation } from "@supadiff/spec";
import { computeCoverage } from "../coverage.js";
import { jsonPointerGet } from "../../values/json-pointer.js";
import type { Projector } from "./types.js";

/** storage.createSignedUrl@1 — never outputs the URL string itself (§6.3). */
export const storageCreateSignedUrlProjector: Projector = (
  raw: RawObservation,
): SemanticObservation => {
  const body = raw.transport.responseBody;
  const path = jsonPointerGet(body, "/path");
  const expiresAt = jsonPointerGet(body, "/expiresAt");
  const issued = jsonPointerGet(body, "/signedUrl") !== undefined;

  const contractual = ["/path", "/expiresAt"];
  const diagnostic = ["/signedUrl"]; // present only as a redacted `{$secret,handle}` marker
  const coverage = computeCoverage(body, { contractual, diagnostic, ignored: [] });

  return {
    format: "supadiff.semantic-observation",
    projector: { id: "storage.createSignedUrl", version: "1" },
    sourceRawDigest: `sha256:${"0".repeat(64)}`,
    service: "storage",
    operation: raw.operation,
    contractFields: {
      "/path": (path ?? null) as never,
      "/expiresAt": (expiresAt ?? null) as never,
    },
    ignoredFields: [],
    relationships: issued
      ? [
          {
            predicate: "storage.signedurl-issued-for-path",
            subject: `${raw.stepId}-signedurl`,
            object: String(path),
          },
        ]
      : [],
    stateFacts: [{ label: "issued", value: issued }],
    coverage,
  };
};

/** storage.redeemUrl@1 — judges redemption behavior, not the URL itself (§6.3, §6.5). */
export const storageRedeemUrlProjector: Projector = (raw: RawObservation): SemanticObservation => {
  const body = raw.transport.responseBody;
  const status = jsonPointerGet(body, "/status");
  const bytesDigest = jsonPointerGet(body, "/bytesDigest");
  const contentLength = jsonPointerGet(body, "/contentLength");

  const contractual = ["/status", "/bytesDigest", "/contentLength"];
  const coverage = computeCoverage(body, { contractual, diagnostic: [], ignored: [] });

  return {
    format: "supadiff.semantic-observation",
    projector: { id: "storage.redeemUrl", version: "1" },
    sourceRawDigest: `sha256:${"0".repeat(64)}`,
    service: "storage",
    operation: raw.operation,
    contractFields: {
      "/status": (status ?? null) as never,
      "/bytesDigest": (bytesDigest ?? null) as never,
      "/contentLength": (contentLength ?? null) as never,
    },
    ignoredFields: [],
    relationships: [
      {
        predicate: "storage.redeemed-signed-url",
        subject: `${raw.stepId}-redemption`,
        object: String(status),
      },
    ],
    stateFacts: [],
    coverage,
  };
};
