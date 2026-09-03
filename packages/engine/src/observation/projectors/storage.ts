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

/** observe.storageObject@1 — object metadata readback: owner, byte digest, length (§6.2 Storage row). */
export const observeStorageObjectProjector: Projector = (
  raw: RawObservation,
): SemanticObservation => {
  const body = raw.transport.responseBody;
  const owner = jsonPointerGet(body, "/owner");
  const bytesDigest = jsonPointerGet(body, "/bytesDigest");
  const contentLength = jsonPointerGet(body, "/contentLength");

  const contractual = ["/owner", "/bytesDigest", "/contentLength"];
  const coverage = computeCoverage(body, { contractual, diagnostic: [], ignored: [] });

  return {
    format: "supadiff.semantic-observation",
    projector: { id: "observe.storageObject", version: "1" },
    sourceRawDigest: `sha256:${"0".repeat(64)}`,
    service: "storage",
    operation: raw.operation,
    contractFields: {
      "/owner": (owner ?? null) as never,
      "/bytesDigest": (bytesDigest ?? null) as never,
      "/contentLength": (contentLength ?? null) as never,
    },
    ignoredFields: [],
    relationships: owner
      ? [
          {
            predicate: "storage.owner-equals",
            subject: `${raw.stepId}-object`,
            object: String(owner),
          },
        ]
      : [],
    stateFacts: [],
    coverage,
  };
};

/** storage.createBucket@1. */
export const storageCreateBucketProjector: Projector = (
  raw: RawObservation,
): SemanticObservation => {
  const body = raw.transport.responseBody;
  const status = jsonPointerGet(body, "/status");
  const name = jsonPointerGet(body, "/name");
  const contractual = ["/status", "/name"];
  const coverage = computeCoverage(body, { contractual, diagnostic: [], ignored: [] });
  return {
    format: "supadiff.semantic-observation",
    projector: { id: "storage.createBucket", version: "1" },
    sourceRawDigest: `sha256:${"0".repeat(64)}`,
    service: "storage",
    operation: raw.operation,
    contractFields: { "/status": (status ?? null) as never, "/name": (name ?? null) as never },
    ignoredFields: [],
    relationships: [],
    stateFacts: [],
    coverage,
  };
};

/** storage.upload@1 — byte identity via digest, ownership via the metadata row (§6.2). */
export const storageUploadProjector: Projector = (raw: RawObservation): SemanticObservation => {
  const body = raw.transport.responseBody;
  const status = jsonPointerGet(body, "/status");
  const path = jsonPointerGet(body, "/path");
  const bytesDigest = jsonPointerGet(body, "/bytesDigest");
  const contentLength = jsonPointerGet(body, "/contentLength");
  const owner = jsonPointerGet(body, "/owner");
  const contractual = ["/status", "/path", "/bytesDigest", "/contentLength", "/owner"];
  const coverage = computeCoverage(body, { contractual, diagnostic: [], ignored: [] });
  return {
    format: "supadiff.semantic-observation",
    projector: { id: "storage.upload", version: "1" },
    sourceRawDigest: `sha256:${"0".repeat(64)}`,
    service: "storage",
    operation: raw.operation,
    contractFields: {
      "/status": (status ?? null) as never,
      "/path": (path ?? null) as never,
      "/bytesDigest": (bytesDigest ?? null) as never,
      "/contentLength": (contentLength ?? null) as never,
      "/owner": (owner ?? null) as never,
    },
    ignoredFields: [],
    relationships: owner
      ? [
          {
            predicate: "storage.owner-equals",
            subject: `${raw.stepId}-upload`,
            object: String(owner),
          },
        ]
      : [],
    stateFacts: [],
    coverage,
  };
};

/** storage.download@1 — same byte-identity shape as redeemUrl, distinct operation id (§6.2). */
export const storageDownloadProjector: Projector = (raw: RawObservation): SemanticObservation => {
  const body = raw.transport.responseBody;
  const status = jsonPointerGet(body, "/status");
  const bytesDigest = jsonPointerGet(body, "/bytesDigest");
  const contentLength = jsonPointerGet(body, "/contentLength");
  const contractual = ["/status", "/bytesDigest", "/contentLength"];
  const coverage = computeCoverage(body, { contractual, diagnostic: [], ignored: [] });
  return {
    format: "supadiff.semantic-observation",
    projector: { id: "storage.download", version: "1" },
    sourceRawDigest: `sha256:${"0".repeat(64)}`,
    service: "storage",
    operation: raw.operation,
    contractFields: {
      "/status": (status ?? null) as never,
      "/bytesDigest": (bytesDigest ?? null) as never,
      "/contentLength": (contentLength ?? null) as never,
    },
    ignoredFields: [],
    relationships: [],
    stateFacts: [],
    coverage,
  };
};

/** storage.list@1 — unordered by default; scenario rules decide ordering semantics. */
export const storageListProjector: Projector = (raw: RawObservation): SemanticObservation => {
  const body = raw.transport.responseBody;
  const status = jsonPointerGet(body, "/status");
  const entries = jsonPointerGet(body, "/entries");
  const contractual = ["/status", "/entries"];
  const coverage = computeCoverage(body, { contractual, diagnostic: [], ignored: [] });
  return {
    format: "supadiff.semantic-observation",
    projector: { id: "storage.list", version: "1" },
    sourceRawDigest: `sha256:${"0".repeat(64)}`,
    service: "storage",
    operation: raw.operation,
    contractFields: {
      "/status": (status ?? null) as never,
      "/entries": (entries ?? null) as never,
    },
    ignoredFields: [],
    relationships: [],
    stateFacts: [],
    coverage,
  };
};

/** storage.remove@1. */
export const storageRemoveProjector: Projector = (raw: RawObservation): SemanticObservation => {
  const body = raw.transport.responseBody;
  const status = jsonPointerGet(body, "/status");
  const removed = jsonPointerGet(body, "/removed");
  const contractual = ["/status", "/removed"];
  const coverage = computeCoverage(body, { contractual, diagnostic: [], ignored: [] });
  return {
    format: "supadiff.semantic-observation",
    projector: { id: "storage.remove", version: "1" },
    sourceRawDigest: `sha256:${"0".repeat(64)}`,
    service: "storage",
    operation: raw.operation,
    contractFields: {
      "/status": (status ?? null) as never,
      "/removed": (removed ?? null) as never,
    },
    ignoredFields: [],
    relationships: [],
    stateFacts: [],
    coverage,
  };
};

/** storage.move@1. */
export const storageMoveProjector: Projector = (raw: RawObservation): SemanticObservation => {
  const body = raw.transport.responseBody;
  const status = jsonPointerGet(body, "/status");
  const contractual = ["/status"];
  const coverage = computeCoverage(body, { contractual, diagnostic: [], ignored: [] });
  return {
    format: "supadiff.semantic-observation",
    projector: { id: "storage.move", version: "1" },
    sourceRawDigest: `sha256:${"0".repeat(64)}`,
    service: "storage",
    operation: raw.operation,
    contractFields: { "/status": (status ?? null) as never },
    ignoredFields: [],
    relationships: [],
    stateFacts: [],
    coverage,
  };
};

/** storage.copy@1 — byte identity of the new copy (§6.2). */
export const storageCopyProjector: Projector = (raw: RawObservation): SemanticObservation => {
  const body = raw.transport.responseBody;
  const status = jsonPointerGet(body, "/status");
  const bytesDigest = jsonPointerGet(body, "/bytesDigest");
  const contractual = ["/status", "/bytesDigest"];
  const coverage = computeCoverage(body, { contractual, diagnostic: [], ignored: [] });
  return {
    format: "supadiff.semantic-observation",
    projector: { id: "storage.copy", version: "1" },
    sourceRawDigest: `sha256:${"0".repeat(64)}`,
    service: "storage",
    operation: raw.operation,
    contractFields: {
      "/status": (status ?? null) as never,
      "/bytesDigest": (bytesDigest ?? null) as never,
    },
    ignoredFields: [],
    relationships: [],
    stateFacts: [],
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
