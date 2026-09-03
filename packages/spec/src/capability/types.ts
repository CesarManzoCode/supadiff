import type { StableId } from "../ids.js";
import type { JsonObject } from "../json-value.js";

/** Atomic, namespaced capability levels (§2.8). Broad claims such as `auth: true` are forbidden. */
export type CapabilityLevel = "exact" | "approximation" | "experimental" | "unsupported";

export interface CapabilityRequirement {
  capability: StableId;
  /** semver range the requirement accepts, e.g. "^1.0.0". */
  range: string;
  accept: Array<"exact" | "approximation" | "experimental">;
  constraints?: JsonObject;
}

export interface EvidenceRef {
  kind: "url" | "artifact" | "note";
  value: string;
}

export interface TargetCapability {
  id: StableId;
  version: string;
  level: CapabilityLevel;
  constraints: JsonObject;
  evidence: EvidenceRef[];
  observed: boolean;
}

export type CapabilityResolutionStatus =
  | "satisfied"
  | "accepted-approximation"
  | "unsupported"
  | "identity-mismatch";
