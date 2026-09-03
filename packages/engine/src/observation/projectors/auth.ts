import type { RawObservation, SemanticObservation } from "@supadiff/spec";
import { computeCoverage } from "../coverage.js";
import { jsonPointerGet } from "../../values/json-pointer.js";
import type { Projector } from "./types.js";

/** Shared shape for auth.signUp@1 / auth.signInWithPassword@1 / auth.refreshSession@1 (§6.3). */
function projectAuthSessionOperation(projectorId: string): Projector {
  return (raw: RawObservation): SemanticObservation => {
    const body = raw.transport.responseBody;
    const status = jsonPointerGet(body, "/status");
    const userId = jsonPointerGet(body, "/user/id");
    const userEmail = jsonPointerGet(body, "/user/email");
    const sessionPresent = jsonPointerGet(body, "/session") !== undefined;

    const contractual = ["/status", "/user/id", "/user/email", "/session"];
    const coverage = computeCoverage(body, { contractual, diagnostic: [], ignored: [] });

    return {
      format: "supadiff.semantic-observation",
      projector: { id: projectorId, version: "1" },
      sourceRawDigest: `sha256:${"0".repeat(64)}`,
      service: "auth",
      operation: raw.operation,
      contractFields: {
        "/status": (status ?? null) as never,
        "/user/id": (userId ?? null) as never,
        "/user/email": (userEmail ?? null) as never,
      },
      ignoredFields: [],
      relationships:
        raw.actor.actorId && sessionPresent
          ? [
              {
                predicate: "session.belongs-to-actor",
                subject: `${raw.stepId}-session`,
                object: `actor:${raw.actor.actorId}`,
              },
            ]
          : [],
      stateFacts: [{ label: "session-presence", value: sessionPresent }],
      coverage,
    };
  };
}

export const authSignUpProjector = projectAuthSessionOperation("auth.signUp");
export const authSignInWithPasswordProjector =
  projectAuthSessionOperation("auth.signInWithPassword");
export const authRefreshSessionProjector = projectAuthSessionOperation("auth.refreshSession");
