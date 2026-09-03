import type { IsoDateTime, Sha256, StableId } from "../ids.js";
import type { CapabilityResolutionStatus, CapabilityLevel } from "../capability/types.js";
import type { TargetIdentity, TargetKind } from "../target/types.js";

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

/** One scenario step as it will actually execute, in fixed lockstep order (§5.2). */
export interface ResolvedStep {
  stepId: StableId;
  operationId: StableId;
  operationVersion: string;
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
