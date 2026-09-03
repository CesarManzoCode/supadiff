import type { DurationMs, IsoDateTime, Sha256, StableId } from "../ids.js";
import type { CapabilityResolutionStatus, CapabilityLevel } from "../capability/types.js";
import type { TargetIdentity, TargetKind } from "../target/types.js";
import type {
  CaptureSpec,
  ObservationRequest,
  OnUnsupported,
  RetrySpec,
  StepPhase,
} from "../scenario/types.js";
import type { JsonObject } from "../json-value.js";

/**
 * One target's resolved slot in a frozen `ExecutionPlan` (§2.3). Carries the *observed*
 * identity collected during provisioning — never a live endpoint or credential — so the
 * executor consumes fixed, already-verified target facts instead of re-deriving them.
 */
export interface ResolvedTargetSlot {
  slot: StableId;
  kind: TargetKind;
  role: "reference" | "candidate";
  identity: TargetIdentity;
}

/**
 * One target's frozen capability-aware disposition for one step (§2.8, §3.5). Computed once
 * during planning from that target's declared/probed capabilities, so the executor never
 * calls `resolveCapability` again to decide whether a step runs.
 */
export interface ResolvedStepTargetRequirement {
  targetSlot: StableId;
  /** true when this step's own `requires` resolved to `unsupported` on this target. */
  unsupported: boolean;
}

/**
 * One scenario step as it will actually execute, in fixed lockstep order (§5.2). Carries
 * everything the executor needs to run the step from the plan alone — it MUST NOT go back
 * to `ScenarioSpec.steps` for scheduling or execution parameters. `input` keeps its `$ref`
 * placeholders intact: capture values are resolved at runtime as earlier steps produce them,
 * never during planning (§2.6).
 */
export interface ResolvedStep {
  stepId: StableId;
  operationId: StableId;
  operationVersion: string;
  phase: StepPhase;
  actor?: StableId;
  dependsOn: StableId[];
  input: JsonObject;
  capture: CaptureSpec[];
  observe: ObservationRequest[];
  timeoutMs?: DurationMs;
  retry?: RetrySpec;
  onUnsupported: OnUnsupported;
  targetRequirements: ResolvedStepTargetRequirement[];
}

/** One requirement's frozen resolution, carried into the plan so the executor never re-decides it. */
export interface PlanCapabilityResolution {
  targetSlot: StableId;
  capability: StableId;
  status: CapabilityResolutionStatus;
  level?: CapabilityLevel;
}

export interface ResolvedExecutionPolicy {
  schedule: "lockstep";
  maxParallelOperations: number;
}

/**
 * The validated and capability-resolved plan for one run (§2.3). Produced exactly once,
 * after scenario validation, capability declaration, provisioning, target identification,
 * and runtime capability probing — and BEFORE any scenario step mutates target state.
 * Immutable and secret-free: `ExecutionPlan.targetSlots[].identity` carries only the
 * sanitized `TargetIdentity` facts (versions, platform, a config digest), never live
 * endpoints or credentials.
 */
export interface ExecutionPlan {
  format: "supadiff.plan";
  formatVersion: "1.0";
  planId: StableId;
  scenarioDigest: Sha256;
  policyDigest: Sha256;
  mode: "peer" | "transition" | "replay" | "reduction-candidate";
  targetSlots: ResolvedTargetSlot[];
  orderedSteps: ResolvedStep[];
  capabilityResolution: PlanCapabilityResolution[];
  executionPolicy: ResolvedExecutionPolicy;
  createdAt: IsoDateTime;
}
