import type { RawObservation, SemanticObservation } from "@supadiff/spec";
import { computeCoverage } from "../coverage.js";
import { jsonPointerGet } from "../../values/json-pointer.js";
import type { Projector } from "./types.js";

/** cli.invoke@1 — exit category is contractual; stdout/stderr are diagnostic unless structured (§6.3). */
export const cliInvokeProjector: Projector = (raw: RawObservation): SemanticObservation => {
  const body = raw.transport.responseBody;
  const exitCode = jsonPointerGet(body, "/exitCode");
  const contractual = ["/exitCode"];
  const diagnostic = ["/stdout", "/stderr"];
  const coverage = computeCoverage(body, { contractual, diagnostic, ignored: [] });

  return {
    format: "supadiff.semantic-observation",
    projector: { id: "cli.invoke", version: "1" },
    sourceRawDigest: `sha256:${"0".repeat(64)}`,
    service: "cli",
    operation: raw.operation,
    contractFields: { "/exitCode": (exitCode ?? null) as never },
    ignoredFields: [],
    relationships: [],
    stateFacts: [],
    coverage,
  };
};

/** observe.authSession@1 — session presence and role, never the token itself (§6.3). */
export const observeAuthSessionProjector: Projector = (
  raw: RawObservation,
): SemanticObservation => {
  const body = raw.transport.responseBody;
  const active = jsonPointerGet(body, "/active");
  const subject = jsonPointerGet(body, "/subject");
  const role = jsonPointerGet(body, "/role");
  const contractual = ["/active", "/subject", "/role"];
  const coverage = computeCoverage(body, { contractual, diagnostic: [], ignored: [] });

  return {
    format: "supadiff.semantic-observation",
    projector: { id: "observe.authSession", version: "1" },
    sourceRawDigest: `sha256:${"0".repeat(64)}`,
    service: "auth",
    operation: raw.operation,
    contractFields: {
      "/active": (active ?? null) as never,
      "/subject": (subject ?? null) as never,
      "/role": (role ?? null) as never,
    },
    ignoredFields: [],
    relationships: subject
      ? [
          {
            predicate: "session.belongs-to-actor",
            subject: String(subject),
            object: String(subject),
          },
        ]
      : [],
    stateFacts: [],
    coverage,
  };
};

/** assert.invariant@1 — the predicate outcome is contractual; detail is diagnostic (§3.6). */
export const assertInvariantProjector: Projector = (raw: RawObservation): SemanticObservation => {
  const body = raw.transport.responseBody;
  const satisfied = jsonPointerGet(body, "/satisfied");
  const contractual = ["/satisfied"];
  const diagnostic = ["/detail"];
  const coverage = computeCoverage(body, { contractual, diagnostic, ignored: [] });

  return {
    format: "supadiff.semantic-observation",
    projector: { id: "assert.invariant", version: "1" },
    sourceRawDigest: `sha256:${"0".repeat(64)}`,
    service: "data",
    operation: raw.operation,
    contractFields: { "/satisfied": (satisfied ?? null) as never },
    ignoredFields: [],
    relationships: [],
    stateFacts: [],
    coverage,
  };
};
