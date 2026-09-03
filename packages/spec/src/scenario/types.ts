import type { DurationMs, StableId } from "../ids.js";
import type { JsonObject, JsonValue } from "../json-value.js";
import type { CapabilityRequirement } from "../capability/types.js";

export interface ClientContract {
  library: "supabase-js" | "raw-http";
  version: string;
}

export interface ResourceDeclaration {
  id: StableId;
  mediaType: string;
  sha256: `sha256:${string}`;
  length: number;
  source: { kind: "inline"; value: string } | { kind: "content"; path: string };
  sensitivity: "public-fixture" | "generated-fixture";
}

export interface ActorSpec {
  id: StableId;
  kind: "anonymous" | "user" | "service";
  identity?: {
    emailTemplate?: string;
    stableSubject?: boolean;
    metadata?: JsonValue;
  };
  credentialSource:
    | { kind: "generated"; recipe: { id: StableId; version: string } }
    | { kind: "external"; secretRef: StableId }
    | { kind: "none" };
  initialContext: "anonymous" | "service-key";
  sessionPolicy: "fresh-per-target" | "refresh-within-target" | "transition-reauth";
}

export type ValueType =
  | "string"
  | "number"
  | "boolean"
  | "object"
  | "array"
  | "null"
  | "identifier"
  | "secret-handle";

export interface JsonPointerSelector {
  kind: "json-pointer";
  pointer: string;
}
export interface HeaderSelector {
  kind: "header";
  name: string;
}
export interface SemanticSelector {
  kind: "semantic";
  field: string;
}
export type CaptureFrom = JsonPointerSelector | HeaderSelector | SemanticSelector;

export interface CaptureSpec {
  name: StableId;
  from: CaptureFrom;
  valueType: ValueType;
  sensitivity: "public" | "identifier" | "secret";
  required: boolean;
}

export interface ValueRef {
  $ref: `capture:${string}`;
}

export interface ObservationRequest {
  id: StableId;
  operation: { id: StableId; version: string };
  input: JsonObject;
}

export type OnUnsupported = "skip-step" | "skip-scenario";

export interface RetrySpec {
  maxAttempts: number;
  retryableCategories: string[];
  backoffMs: DurationMs;
  idempotencyProof: "catalog-idempotent" | "stable-idempotency-key";
}

export type StepPhase = "bootstrap" | "exercise" | "probe";

interface StepBase<K extends string, I> {
  id: StableId;
  kind: K;
  phase: StepPhase;
  actor?: StableId;
  requires?: CapabilityRequirement[];
  dependsOn?: StableId[];
  input: I;
  capture?: CaptureSpec[];
  observe?: ObservationRequest[];
  timeoutMs?: DurationMs;
  retry?: RetrySpec;
  onUnsupported?: OnUnsupported;
}

export type SchemaApplyStep = StepBase<"schema.apply", JsonObject>;
export type MigrationApplyStep = StepBase<"migration.apply", JsonObject>;
export type SeedStep = StepBase<"data.seed", JsonObject>;
export type AuthOperationStep = StepBase<
  | "auth.signUp"
  | "auth.signInWithPassword"
  | "auth.getUser"
  | "auth.updateUser"
  | "auth.refreshSession"
  | "auth.signOut",
  JsonObject
>;
export type DataOperationStep = StepBase<
  "data.select" | "data.insert" | "data.update" | "data.upsert" | "data.delete" | "http.preflight",
  JsonObject
>;
export type StorageOperationStep = StepBase<
  | "storage.createBucket"
  | "storage.upload"
  | "storage.download"
  | "storage.list"
  | "storage.remove"
  | "storage.move"
  | "storage.copy"
  | "storage.createSignedUrl"
  | "storage.redeemUrl",
  JsonObject
>;
export type CliOperationStep = StepBase<"cli.invoke", JsonObject>;
export type ObserveStep = StepBase<
  | "observe.dataReadback"
  | "observe.authSession"
  | "observe.storageObject"
  | "observe.schemaSurface"
  | "observe.projectTree",
  JsonObject
>;
export type AssertInvariantStep = StepBase<"assert.invariant", JsonObject>;
export type BarrierStep = StepBase<"control.barrier", JsonObject>;

export type StepSpec =
  | SchemaApplyStep
  | MigrationApplyStep
  | SeedStep
  | AuthOperationStep
  | DataOperationStep
  | StorageOperationStep
  | CliOperationStep
  | ObserveStep
  | AssertInvariantStep
  | BarrierStep;

export interface CleanupSpec {
  id: StableId;
  operation: { id: StableId; version: string };
  input: JsonObject;
  timeoutMs: DurationMs;
}

export interface ComparisonPolicyRef {
  policyId: StableId;
  policyVersion: string;
}

export interface ExpectedOutcomeRef {
  kind: "known-divergence" | "accepted-approximation";
  id: StableId;
}

export interface ScenarioLimits {
  maxSteps: number;
  maxWallTimeMs: number;
  maxArtifactBytes: number;
  maxRequestsPerTarget: number;
  maxHostedCostUsd: number;
  maxParallelOperations: number;
}

export interface ScenarioProvenance {
  origin: "authored" | "generated" | "reduced" | "imported" | "upstream-derived";
  createdAt: string;
  author?: string;
  generatedBy?: { id: StableId; version: string };
}

export interface ScenarioSpec {
  format: "supadiff.scenario";
  formatVersion: "1.0";
  id: StableId;
  revision: string;
  title: string;
  description?: string;
  tags: string[];
  seed: string;
  client: ClientContract;
  requirements: CapabilityRequirement[];
  resources: ResourceDeclaration[];
  actors: ActorSpec[];
  steps: StepSpec[];
  cleanup: CleanupSpec[];
  comparison: ComparisonPolicyRef;
  expectedOutcomes: ExpectedOutcomeRef[];
  limits: ScenarioLimits;
  provenance: ScenarioProvenance;
}
