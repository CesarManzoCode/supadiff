import {
  computeScenarioDigest,
  sha256OfCanonicalJson,
  type ComparisonPolicy,
  type ExecutionPlan,
  type IsoDateTime,
  type PlanCapabilityResolution,
  type ResolvedStep,
  type ResolvedTargetSlot,
  type ScenarioSpec,
  type StableId,
  type TargetCapability,
  type TargetIdentity,
  type TargetSpec,
} from "@supadiff/spec";
import { resolveCapability, type CapabilityResolution } from "../execution/capabilities.js";

/**
 * Raised when a target's *observed* identity (collected during provisioning, §2.7) does
 * not agree with what the scenario/target spec requested. A mismatch between requested
 * and observed version is an inconclusive infrastructure outcome, never silently accepted
 * — there is currently no modeled target-policy field that explicitly permits a version
 * range here, so any declared `TargetSpec.package.version` must match exactly.
 */
export class TargetIdentityMismatchError extends Error {
  constructor(slot: StableId, requested: string, observed: string) {
    super(
      `target "${slot}": requested package version "${requested}" does not match observed ` +
        `implementation version "${observed}" — this is an inconclusive infrastructure outcome ` +
        `(§2.7), never a silently accepted drift`,
    );
    this.name = "TargetIdentityMismatchError";
  }
}

/** Raised when plan construction is attempted before every input it requires actually exists. */
export class IncompletePlanInputError extends Error {
  constructor(reason: string) {
    super(`cannot freeze an ExecutionPlan: ${reason} (§5.1: plan-frozen requires this first)`);
    this.name = "IncompletePlanInputError";
  }
}

export interface PlanTargetInput {
  slot: StableId;
  spec: TargetSpec;
  role: "reference" | "candidate";
  /** MUST be the identity actually observed during provisioning (§2.7) — never assumed. */
  identity: TargetIdentity | undefined;
  /** Per-requirement resolution computed from BOTH declared and probed capabilities (§2.8). */
  capabilityResolution: CapabilityResolution[];
  /**
   * This target's declared/probed capabilities, used ONLY here — once, during planning — to
   * resolve each step's own `requires` (§3.5) into a frozen `ResolvedStepTargetRequirement`.
   * The executor consumes that frozen decision and MUST NOT call `resolveCapability` again.
   * Optional only so callers that pass scenarios with no step-level `requires` (nothing to
   * resolve) need not supply them; `runScenario` always provides the real values.
   */
  declaredCapabilities?: TargetCapability[];
  probedCapabilities?: TargetCapability[];
}

export interface BuildExecutionPlanInput {
  scenario: ScenarioSpec;
  policy: ComparisonPolicy;
  mode: ExecutionPlan["mode"];
  targets: PlanTargetInput[];
  maxParallelOperations: number;
  now: () => IsoDateTime;
}

/** Verifies a requested identity was not silently drifted from what was observed (§2.7). */
function checkIdentityAgreement(target: PlanTargetInput): void {
  if (!target.identity) {
    throw new IncompletePlanInputError(
      `target "${target.slot}" has no observed TargetIdentity — runtime identification and ` +
        `capability probing must complete before the plan can be frozen`,
    );
  }
  const requestedVersion = target.spec.package?.version;
  if (
    requestedVersion !== undefined &&
    requestedVersion !== target.identity.implementationVersion
  ) {
    throw new TargetIdentityMismatchError(
      target.slot,
      requestedVersion,
      target.identity.implementationVersion,
    );
  }
}

/**
 * Builds the frozen `ExecutionPlan` for one run (§2.3, §5.1). This is the ONLY place a
 * plan is constructed: it MUST be called after scenario validation, declared-capability
 * preflight, provisioning, target identification, and runtime capability probing all
 * completed for every target — enforced here by requiring each target's real observed
 * `TargetIdentity` and post-probe `CapabilityResolution[]`, not optional/inferred values.
 * The returned plan is a plain frozen value object: the executor consumes it as input and
 * MUST NOT re-decide target identity or capability resolution afterward. It is
 * deterministic given the same scenario/policy/identities (aside from `createdAt`, and
 * `planId` only insofar as it is derived from that same deterministic content) and
 * contains no secrets or live endpoints — only sanitized `TargetIdentity` facts.
 */
export function buildExecutionPlan(input: BuildExecutionPlanInput): ExecutionPlan {
  for (const target of input.targets) checkIdentityAgreement(target);

  const scenarioDigest = computeScenarioDigest(input.scenario);
  const policyDigest = sha256OfCanonicalJson(input.policy as never);

  const targetSlots: ResolvedTargetSlot[] = input.targets
    .map((t) => ({
      slot: t.slot,
      kind: t.spec.kind,
      role: t.role,
      identity: t.identity!,
    }))
    .sort((a, b) => a.slot.localeCompare(b.slot));

  // Step requirements are resolved exactly once here, during planning, from each target's
  // frozen declared/probed capabilities (§2.8, §3.5) — never re-decided by the executor.
  const orderedSteps: ResolvedStep[] = input.scenario.steps.map((s) => ({
    stepId: s.id,
    operationId: s.kind,
    operationVersion: "1",
    phase: s.phase,
    actor: s.actor,
    dependsOn: s.dependsOn ?? [],
    input: s.input,
    capture: s.capture ?? [],
    observe: s.observe ?? [],
    timeoutMs: s.timeoutMs,
    retry: s.retry,
    onUnsupported: s.onUnsupported ?? "skip-scenario",
    targetRequirements: input.targets.map((t) => ({
      targetSlot: t.slot,
      unsupported: (s.requires ?? []).some(
        (req) =>
          resolveCapability(req, t.declaredCapabilities ?? [], t.probedCapabilities).status ===
          "unsupported",
      ),
    })),
  }));

  const capabilityResolution: PlanCapabilityResolution[] = input.targets
    .flatMap((t) =>
      t.capabilityResolution.map((r) => ({
        targetSlot: t.slot,
        capability: r.requirement.capability,
        status: r.status,
        ...(r.matchedCapability ? { level: r.matchedCapability.level } : {}),
      })),
    )
    .sort((a, b) => (a.targetSlot + a.capability).localeCompare(b.targetSlot + b.capability));

  const executionPolicy = {
    schedule: "lockstep" as const,
    maxParallelOperations: input.maxParallelOperations,
  };

  // planId is derived deterministically from the plan's own deterministic content (never
  // random), so two runs of the same scenario/policy/identities produce the same planId —
  // the only fields allowed to differ are timing (`createdAt`).
  const contentDigest = sha256OfCanonicalJson({
    scenarioDigest,
    policyDigest,
    mode: input.mode,
    targetSlots: targetSlots as never,
    orderedSteps: orderedSteps as never,
    capabilityResolution: capabilityResolution as never,
    executionPolicy,
  } as never);
  const planId = `plan-${contentDigest.slice("sha256:".length, "sha256:".length + 16)}`;

  const plan: ExecutionPlan = {
    format: "supadiff.plan",
    formatVersion: "1.0",
    planId,
    scenarioDigest,
    policyDigest,
    mode: input.mode,
    targetSlots,
    orderedSteps,
    capabilityResolution,
    executionPolicy,
    createdAt: input.now(),
  };

  return Object.freeze(plan);
}

/**
 * Scans a plan's canonical serialization for anything that looks like a secret or a live
 * endpoint. `orderedSteps[].input` now carries the scenario's own step input verbatim
 * (§2.6) — including credential-shaped keys such as `password` — but only ever as a
 * `$secretRef`/`$ref` marker, never a resolved value (the spec invariant "no actor
 * credential literal appears in the spec" already guarantees that). So a credential-shaped
 * key is only a real finding when it is paired with a literal string value, not a marker
 * object.
 */
export function scanPlanForSecretsOrEndpoints(plan: ExecutionPlan): string[] {
  const findings: string[] = [];
  const text = JSON.stringify(plan);
  if (/"\$secret":/i.test(text)) findings.push("plan JSON contains a $secret marker");
  if (/sec-[A-Za-z0-9_-]+/.test(text))
    findings.push("plan JSON contains what looks like a secret handle value");
  if (/https?:\/\//i.test(text)) findings.push("plan JSON contains a live http(s) endpoint URL");
  if (/"(?:password|refresh_token|access_token)":"/i.test(text)) {
    findings.push("plan JSON contains a credential-shaped field holding a literal value");
  }
  return findings;
}
