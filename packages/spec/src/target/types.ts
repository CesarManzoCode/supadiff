import type { DurationMs, IsoDateTime, Sha256, StableId } from "../ids.js";
import type { JsonObject } from "../json-value.js";

export type TargetKind =
  | "supabase-hosted"
  | "supabase-local"
  | "supalite-sqlite"
  | "supalite-sqlite-postgres"
  | "supalite-pglite"
  | "supalite-postgres"
  | "fake";

export interface ExactPackageIdentity {
  name: string;
  version: string;
  integrity?: string;
}

export interface ExactRuntimeIdentity {
  runtime: string;
  version: string;
}

export interface ExactBackendIdentity {
  backend: string;
  version?: string;
}

export interface TargetLifecyclePolicy {
  allocation: "provision-new" | "attach-explicit";
  isolation: "fresh-instance";
  readinessTimeoutMs: DurationMs;
  teardownTimeoutMs: DurationMs;
  cleanup: "always";
  keepOnFailure: "deny" | "local-opt-in";
}

export interface TargetSafetyPolicy {
  allowHosted: boolean;
  allowHostedCreate: boolean;
  allowHostedDestructive: boolean;
  maxHostedCostUsd: number;
}

export interface TargetSpec {
  id: StableId;
  kind: TargetKind;
  package?: ExactPackageIdentity;
  runtime: ExactRuntimeIdentity;
  backend?: ExactBackendIdentity;
  config: JsonObject;
  credentialRefs: StableId[];
  lifecycle: TargetLifecyclePolicy;
  safety: TargetSafetyPolicy;
}

export interface PlatformIdentity {
  os: string;
  arch: string;
}

export interface TargetIdentity {
  targetKind: TargetKind;
  implementation: string;
  implementationVersion: string;
  packageIntegrity?: string;
  artifactHashes?: Sha256[];
  sourceRevision?: string;
  unknownSourceRevisionReason?: string;
  runtime: ExactRuntimeIdentity;
  backend?: ExactBackendIdentity;
  clientVersion: string;
  cliVersion?: string;
  serviceVersions?: Record<string, string>;
  containerDigests?: Record<string, string>;
  platform: PlatformIdentity;
  effectiveConfigDigest: Sha256;
  observedAt: IsoDateTime;
}

export type TargetLifecycleState =
  | "declared"
  | "preflighted"
  | "allocating"
  | "provisioned"
  | "identified"
  | "capability-probed"
  | "ready"
  | "executing"
  | "quiescing"
  | "tearing-down"
  | "closed"
  | "recovering"
  | "leaked";

export interface RecoveryResourceRecord {
  resourceType: string;
  nonSecretIdentifier: string;
  creationIntent: string;
  cleanupAction: string;
  createdAt: IsoDateTime;
  tombstonedAt?: IsoDateTime;
}

export interface TargetLifecycleRecord {
  targetSlot: StableId;
  transitions: Array<{
    sequence: number;
    from: TargetLifecycleState;
    to: TargetLifecycleState;
    at: IsoDateTime;
    reason: string;
  }>;
  ownedResources: RecoveryResourceRecord[];
  teardown: "not-started" | "complete" | "partial" | "leaked";
}
