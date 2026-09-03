/**
 * Target Service Provider Interface (§2.9, §13.2). Imports only `@supadiff/spec`
 * so `@supadiff/targets` can depend on this entrypoint without reaching into
 * engine business logic (scheduling, comparison, artifact assembly).
 */
import type {
  ActorSpec,
  DurationMs,
  IsoDateTime,
  JsonObject,
  StableId,
  TargetCapability,
  TargetIdentity,
  TargetSpec,
} from "@supadiff/spec";

export type SecretHandle = `sec-${string}`;
export type CapturedValueHandle = `cap-${string}`;

/**
 * Opaque runtime handle store. Secret bytes never leave the vault except through
 * `reveal`, which only driver code may call at dispatch time (§2.6, §4.5, §6.4).
 */
export interface SecretVault {
  put(secretClass: string, value: string): SecretHandle;
  reveal(handle: SecretHandle): string;
  /** Run-local keyed fingerprint for high-entropy secrets; never persisted (§2.6). */
  fingerprint(handle: SecretHandle): string;
  has(handle: SecretHandle): boolean;
}

export interface ActorBinding {
  actorId: StableId;
  targetSlot: StableId;
  subject?: string;
  session?: SecretHandle;
  refreshToken?: SecretHandle;
  role: "anon" | "authenticated" | "service_role";
  state: "unbound" | "active" | "expired" | "revoked" | "closed";
}

export interface OperationRequest {
  stepId: StableId;
  attempt: number;
  operation: { id: StableId; version: string };
  actor?: ActorBinding;
  /** Step input with every `$ref`/secret-ref already resolved to concrete values or handles. */
  input: JsonObject;
}

export type RawOutcomeCategory = "success" | "application-error" | "harness-failure";
export type HarnessFailureReason =
  | "timeout"
  | "disconnect"
  | "process-death"
  | "driver-invariant"
  | "target-lost";

export interface RawOperationResult {
  category: RawOutcomeCategory;
  status?: number;
  requestHeaders?: Record<string, string>;
  requestBody?: unknown;
  responseHeaders?: Record<string, string>;
  responseBody?: unknown;
  harnessFailureReason?: HarnessFailureReason;
  durationMs: DurationMs;
}

export interface ProvisionContext {
  runNamespace: string;
  vault: SecretVault;
}

export interface RecoveryResourceEntry {
  resourceType: string;
  nonSecretIdentifier: string;
  creationIntent: string;
  cleanupAction: string;
  createdAt: IsoDateTime;
  tombstonedAt?: IsoDateTime;
}

export interface RecoveryRecord {
  runNamespace: string;
  entries: RecoveryResourceEntry[];
}

export type TeardownReason = "success" | "cancelled" | "failure" | "recovery";

export interface TeardownReport {
  status: "complete" | "partial" | "leaked";
  leaks: string[];
}

export interface TargetSession {
  readonly handleId: StableId;
  identify(signal: AbortSignal): Promise<TargetIdentity>;
  probeCapabilities(signal: AbortSignal): Promise<TargetCapability[]>;
  openActor(actor: ActorSpec, vault: SecretVault, signal: AbortSignal): Promise<ActorBinding>;
  execute(request: OperationRequest, signal: AbortSignal): Promise<RawOperationResult>;
  observe(request: OperationRequest, signal: AbortSignal): Promise<RawOperationResult>;
  teardown(reason: TeardownReason, signal: AbortSignal): Promise<TeardownReport>;
}

export interface TargetDriver {
  readonly kind: string;
  declareCapabilities(spec: TargetSpec): Promise<TargetCapability[]>;
  provision(spec: TargetSpec, ctx: ProvisionContext): Promise<TargetSession>;
  recover(record: RecoveryRecord): Promise<void>;
}
