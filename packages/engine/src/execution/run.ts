import {
  isKnownOperation,
  validateOperationInput,
  type ActorSpec,
  type CleanupSpec,
  type ComparisonPolicy,
  type ExecutionPlan,
  type IsoDateTime,
  type JsonObject,
  type ResolvedStep,
  type ScenarioSpec,
  type StableId,
  type TargetCapability,
  type TargetIdentity,
  type TargetLifecycleRecord,
  type TargetSpec,
} from "@supadiff/spec";
import { getOperationDefinition } from "@supadiff/spec";
import { buildExecutionPlan, TargetIdentityMismatchError } from "../planning/build-plan.js";
import type {
  ActorBinding,
  RawOperationResult,
  SecretHandle,
  TargetDriver,
  TargetSession,
} from "../spi/types.js";
import { InMemorySecretVault } from "../values/vault.js";
import { CapturedValueStore, type CapturedValueRecord } from "../values/store.js";
import { jsonPointerGet } from "../values/json-pointer.js";
import { resolveRefs } from "../values/resolve-refs.js";
import { RecoveryJournal } from "../recovery/journal.js";
import { EventLog, type RunEvent, type StepExecutionStatus } from "./events.js";
import { TargetLifecycleFsm } from "./lifecycle-fsm.js";
import {
  collectRequirements,
  resolveCapability,
  type CapabilityResolution,
} from "./capabilities.js";
import { buildRawObservation } from "../observation/raw.js";
import { hasProjector, project } from "../observation/registry.js";
import type { RawObservation, SemanticObservation } from "@supadiff/spec";

export interface TargetHandle {
  slot: StableId;
  spec: TargetSpec;
  driver: TargetDriver;
}

export type RunTerminalState =
  | "complete"
  | "unsupported"
  | "invalid"
  | "cancelled"
  | "inconclusive-cleanup"
  | "inconclusive";

export interface StepAttemptRecord {
  stepId: StableId;
  attempt: number;
  status: StepExecutionStatus;
  result?: RawOperationResult;
}

export interface TargetRunResult {
  slot: StableId;
  identity?: TargetIdentity;
  declaredCapabilities: TargetCapability[];
  probedCapabilities: TargetCapability[];
  capabilityResolution: CapabilityResolution[];
  events: readonly RunEvent[];
  attempts: StepAttemptRecord[];
  observerResults: Map<string, RawOperationResult>;
  lifecycle: TargetLifecycleRecord;
  recoveryLeaks: string[];
  teardownStatus: "complete" | "partial" | "leaked" | "not-started";
  cleanupResults: Array<{ cleanupId: StableId; ok: boolean }>;
  rawObservations: Map<string, RawObservation>;
  semanticObservations: Map<string, SemanticObservation>;
  redactionFailures: string[];
}

export interface MultiTargetRunResult {
  runId: StableId;
  state: RunTerminalState;
  targets: Map<StableId, TargetRunResult>;
  capturedValueStore: CapturedValueStore;
  /**
   * The frozen `ExecutionPlan` (§2.3, §5.1), present whenever every target reached
   * runtime-capability-probed with a real observed identity and no identity mismatch was
   * found. Absent for `invalid`/`unsupported` runs that never reached that point, and for
   * an `inconclusive` run caused specifically by a target identity mismatch (§2.7).
   */
  plan?: ExecutionPlan;
}

export interface RunOptions {
  clock?: () => IsoDateTime;
  signal?: AbortSignal;
  /** Author-configured secret literals scanned for by the structural detector (§6.4). */
  configuredSecretLiterals?: string[];
  /**
   * The comparison policy to freeze into the `ExecutionPlan`'s `policyDigest` (§2.3). When
   * omitted, a policy identified by the scenario's own declared `comparison` ref but with
   * zero rules is used ONLY for plan digesting — this never substitutes for a real
   * comparison policy at the CLI layer (see `loadPolicy`'s fail-closed contract).
   */
  policy?: ComparisonPolicy;
}

function defaultClock(): () => IsoDateTime {
  let counter = 0;
  return () => new Date(Date.UTC(2026, 0, 1, 0, 0, 0, counter++)).toISOString();
}

class TargetLostError extends Error {}
class OperationTimeoutError extends Error {}

/** A zero-rules policy used only to digest a plan when no real policy was supplied (single-target runs). */
function emptyPolicyForDigest(scenario: ScenarioSpec): ComparisonPolicy {
  return {
    format: "supadiff.comparison-policy",
    formatVersion: "1.0",
    policyId: scenario.comparison.policyId,
    policyVersion: scenario.comparison.policyVersion,
    rules: [],
  };
}

/**
 * Runs one scenario in serial lockstep across N target slots (§5.2): step 1 on slot 0,
 * step 1 on slot 1, ..., step 2 on slot 0, step 2 on slot 1, and so on. Target order is
 * fixed by `targets` array order. This is the only conformance schedule in v1.
 */
export async function runScenario(
  scenario: ScenarioSpec,
  targets: TargetHandle[],
  opts: RunOptions = {},
): Promise<MultiTargetRunResult> {
  const clock = opts.clock ?? defaultClock();
  const runId = `run-${scenario.id}-${scenario.revision}`;
  const runNamespace = `sd-${scenario.id}-${runId}`;

  const perTarget = new Map<
    StableId,
    {
      handle: TargetHandle;
      fsm: TargetLifecycleFsm;
      events: EventLog;
      vault: InMemorySecretVault;
      journal: RecoveryJournal;
      session?: TargetSession;
      actorBindings: Map<StableId, ActorBinding>;
      namedSecrets: Map<string, SecretHandle>;
      declaredCapabilities: TargetCapability[];
      probedCapabilities: TargetCapability[];
      capabilityResolution: CapabilityResolution[];
      attempts: StepAttemptRecord[];
      observerResults: Map<string, RawOperationResult>;
      cleanupResults: Array<{ cleanupId: StableId; ok: boolean }>;
      identity?: TargetIdentity;
      lost: boolean;
      rawObservations: Map<string, RawObservation>;
      semanticObservations: Map<string, SemanticObservation>;
      redactionFailures: string[];
    }
  >();

  const capturedValueStore = new CapturedValueStore();
  let plan: ExecutionPlan | undefined;

  for (const handle of targets) {
    perTarget.set(handle.slot, {
      handle,
      fsm: new TargetLifecycleFsm(clock),
      events: new EventLog(clock),
      vault: new InMemorySecretVault(`${scenario.seed}-${handle.slot}`),
      journal: new RecoveryJournal(`${runNamespace}-${handle.slot}`),
      actorBindings: new Map(),
      namedSecrets: new Map(),
      declaredCapabilities: [],
      probedCapabilities: [],
      capabilityResolution: [],
      attempts: [],
      observerResults: new Map(),
      cleanupResults: [],
      lost: false,
      rawObservations: new Map(),
      semanticObservations: new Map(),
      redactionFailures: [],
    });
  }

  const stepRequirements = scenario.steps.map((s) => s.requires ?? []);
  const allRequirements = collectRequirements(scenario.requirements, stepRequirements);

  // --- retry legality validation (§3.5, §5.6): rejected during planning, before any mutation ---
  for (const step of scenario.steps) {
    if (!step.retry) continue;
    const def = getOperationDefinition(step.kind, "1");
    const catalogIdempotent = def?.idempotency.idempotent === true;
    const proofOk =
      step.retry.idempotencyProof === "catalog-idempotent"
        ? catalogIdempotent
        : step.retry.idempotencyProof === "stable-idempotency-key";
    if (!proofOk) {
      return finalize("invalid");
    }
  }

  // --- declared-capabilities-preflighted ---
  let scenarioUnsupported = false;
  for (const ctx of perTarget.values()) {
    ctx.fsm.transition("preflighted", "declared capability preflight");
    ctx.declaredCapabilities = await ctx.handle.driver.declareCapabilities(ctx.handle.spec);
    ctx.capabilityResolution = allRequirements.map((req) =>
      resolveCapability(req, ctx.declaredCapabilities, undefined),
    );
    if (ctx.capabilityResolution.some((r) => r.status === "unsupported")) {
      scenarioUnsupported = true;
    }
  }

  if (scenarioUnsupported) {
    return finalize("unsupported");
  }

  // --- provisioned (allocating -> provisioned), writing recovery intent BEFORE allocation ---
  try {
    for (const ctx of perTarget.values()) {
      ctx.fsm.transition("allocating", "provisioning target session");
      ctx.journal.recordIntent(
        "target-session",
        ctx.handle.slot,
        `provision ${ctx.handle.spec.kind} target`,
        "teardown target session",
        clock,
      );
      ctx.session = await ctx.handle.driver.provision(ctx.handle.spec, {
        runNamespace: `${runNamespace}-${ctx.handle.slot}`,
        vault: ctx.vault,
      });
      ctx.fsm.transition("provisioned", "session provisioned");
    }

    // --- identities-verified ---
    for (const ctx of perTarget.values()) {
      const signal = opts.signal ?? new AbortController().signal;
      ctx.identity = await ctx.session!.identify(signal);
      ctx.fsm.transition("identified", "identity collected");
    }

    // --- runtime-capabilities-probed ---
    for (const ctx of perTarget.values()) {
      const signal = opts.signal ?? new AbortController().signal;
      ctx.probedCapabilities = await ctx.session!.probeCapabilities(signal);
      ctx.capabilityResolution = allRequirements.map((req) =>
        resolveCapability(req, ctx.declaredCapabilities, ctx.probedCapabilities),
      );
      ctx.fsm.transition("capability-probed", "runtime capabilities probed");
      if (
        ctx.capabilityResolution.some(
          (r) => r.status === "unsupported" || r.status === "identity-mismatch",
        )
      ) {
        scenarioUnsupported = true;
      }
    }

    if (scenarioUnsupported) {
      await teardownAll("failure");
      return finalize("unsupported");
    }

    // --- plan-frozen (§2.3, §5.1): the ExecutionPlan is built exactly once here, after
    // scenario validation, capability declaration, provisioning, target identification, and
    // runtime capability probing all completed for every target (buildExecutionPlan itself
    // enforces this by requiring each target's real observed identity). From this point
    // onward the engine consumes the frozen plan as input; it never re-decides target
    // identity or capability resolution.
    const targetSlots = [...perTarget.values()];
    try {
      plan = buildExecutionPlan({
        scenario,
        policy: opts.policy ?? emptyPolicyForDigest(scenario),
        mode: "peer",
        targets: targetSlots.map((ctx, i) => ({
          slot: ctx.handle.slot,
          spec: ctx.handle.spec,
          role: i === 0 ? "reference" : "candidate",
          identity: ctx.identity,
          capabilityResolution: ctx.capabilityResolution,
          declaredCapabilities: ctx.declaredCapabilities,
          probedCapabilities: ctx.probedCapabilities,
        })),
        maxParallelOperations: scenario.limits.maxParallelOperations,
        now: clock,
      });
    } catch (err) {
      if (err instanceof TargetIdentityMismatchError) {
        await teardownAll("failure");
        return finalize("inconclusive");
      }
      throw err;
    }

    // --- plan-frozen / actors-opened ---
    for (const ctx of perTarget.values()) {
      ctx.fsm.transition("ready", "plan frozen");
    }
    for (const actor of scenario.actors) {
      for (const ctx of perTarget.values()) {
        const signal = opts.signal ?? new AbortController().signal;
        const binding = await ctx.session!.openActor(actor, ctx.vault, signal);
        ctx.actorBindings.set(actor.id, binding);
        ctx.events.push({ kind: "actor-opened", targetSlot: ctx.handle.slot, actorId: actor.id });
        if (actor.credentialSource.kind === "generated") {
          const fixtureValue = `fixture-${actor.credentialSource.recipe.id}-${scenario.seed}`;
          const handle = ctx.vault.put("password", fixtureValue);
          ctx.namedSecrets.set(actor.credentialSource.recipe.id, handle);
        } else if (actor.credentialSource.kind === "external") {
          const handle = ctx.vault.put("password", `external-${actor.credentialSource.secretRef}`);
          ctx.namedSecrets.set(actor.credentialSource.secretRef, handle);
        }
      }
    }
    for (const ctx of perTarget.values()) {
      ctx.fsm.transition("executing", "execution started");
    }

    // --- executing: lockstep by logical step, driven by the frozen plan (§5.1) ---
    // From here on the frozen plan is the scheduling authority: step order, dependencies,
    // and each step's per-target capability disposition all come from `plan.orderedSteps`,
    // not from `scenario.steps` or a fresh `resolveCapability` call.
    const blockedSteps = new Set<StableId>();
    for (const step of plan.orderedSteps) {
      const dependenciesBlocked = step.dependsOn.some((d) => blockedSteps.has(d));
      for (const ctx of perTarget.values()) {
        if (ctx.lost) {
          ctx.attempts.push({ stepId: step.stepId, attempt: 1, status: "target-lost" });
          continue;
        }
        if (dependenciesBlocked) {
          ctx.attempts.push({ stepId: step.stepId, attempt: 1, status: "blocked-dependency" });
          blockedSteps.add(step.stepId);
          continue;
        }

        const targetRequirement = step.targetRequirements.find(
          (r) => r.targetSlot === ctx.handle.slot,
        );
        if (targetRequirement?.unsupported) {
          ctx.attempts.push({ stepId: step.stepId, attempt: 1, status: "skipped-requirement" });
          if (step.onUnsupported === "skip-scenario") blockedSteps.add(step.stepId);
          continue;
        }

        await executeStepOnTarget(step, ctx, capturedValueStore, opts.signal, clock, blockedSteps);
      }
    }

    // --- traces-finalized / quiescing ---
    for (const ctx of perTarget.values()) {
      if (ctx.fsm.state === "executing") ctx.fsm.transition("quiescing", "steps complete");
    }

    // --- cleanup: reverse declaration order, independent timeouts, continues after failure ---
    for (const ctx of perTarget.values()) {
      for (const cleanup of [...scenario.cleanup].reverse()) {
        ctx.events.push({
          kind: "cleanup-started",
          targetSlot: ctx.handle.slot,
          cleanupId: cleanup.id,
        });
        const ok = await runCleanup(cleanup, ctx, capturedValueStore);
        ctx.cleanupResults.push({ cleanupId: cleanup.id, ok });
        ctx.events.push({
          kind: "cleanup-finished",
          targetSlot: ctx.handle.slot,
          cleanupId: cleanup.id,
          ok,
        });
      }
    }

    await teardownAll("success");

    const anyCleanupFailed = [...perTarget.values()].some((c) =>
      c.cleanupResults.some((r) => !r.ok),
    );
    const anyLeak = [...perTarget.values()].some((c) => c.journal.leakedEntries().length > 0);
    const anyLost = [...perTarget.values()].some((c) => c.lost);

    if (anyLost) return finalize("inconclusive");
    if (anyCleanupFailed || anyLeak) return finalize("inconclusive-cleanup");
    return finalize("complete");
  } catch (err) {
    await teardownAll("failure");
    if (err instanceof TargetLostError) return finalize("inconclusive");
    throw err;
  }

  async function attemptOnce(
    step: ResolvedStep,
    ctx: NonNullable<ReturnType<typeof perTarget.get>>,
    store: CapturedValueStore,
    attempt: number,
  ): Promise<{ status: StepExecutionStatus; result?: RawOperationResult }> {
    let status: StepExecutionStatus = "executed";
    let result: RawOperationResult | undefined;
    try {
      const resolvedInput = resolveRefs(step.input, {
        targetSlot: ctx.handle.slot,
        captures: store,
        namedSecrets: ctx.namedSecrets,
      }) as JsonObject;

      if (!isKnownOperation(step.operationId, step.operationVersion)) {
        throw new Error(
          `unknown operation "${step.operationId}" reached execution (should have been validated)`,
        );
      }
      validateOperationInput(step.operationId, step.operationVersion, resolvedInput);

      const actorBinding = step.actor ? ctx.actorBindings.get(step.actor) : undefined;
      const request = {
        stepId: step.stepId,
        attempt,
        operation: { id: step.operationId, version: step.operationVersion },
        actor: actorBinding,
        input: resolvedInput,
      };

      const controller = new AbortController();
      const timeoutMs = step.timeoutMs;
      let timer: ReturnType<typeof setTimeout> | undefined;
      // Timeouts are enforced by the engine's own race, not merely by the driver
      // honoring AbortSignal (§5.4: drivers must honor cancellation OR be terminated
      // by their provider — the engine cannot rely solely on cooperative drivers).
      const timeoutPromise =
        timeoutMs !== undefined
          ? new Promise<never>((_resolve, reject) => {
              timer = setTimeout(() => {
                controller.abort();
                reject(new OperationTimeoutError(`step "${step.stepId}" timed out`));
              }, timeoutMs);
            })
          : undefined;
      try {
        result = timeoutPromise
          ? await Promise.race([ctx.session!.execute(request, controller.signal), timeoutPromise])
          : await ctx.session!.execute(request, controller.signal);
      } finally {
        if (timer) clearTimeout(timer);
      }

      if (result.category === "harness-failure") {
        if (result.harnessFailureReason === "timeout") status = "timed-out";
        else if (
          result.harnessFailureReason === "target-lost" ||
          result.harnessFailureReason === "process-death"
        ) {
          status = "target-lost";
          ctx.lost = true;
        } else status = "harness-error";
      } else {
        status = "executed";
        applyCaptures(step, ctx, store, result);
        if (hasProjector(step.operationId, step.operationVersion)) {
          const { observation, redactionFailed } = buildRawObservation({
            observationId: `${step.stepId}.${attempt}`,
            origin: "primary",
            runId,
            targetSlot: ctx.handle.slot,
            stepId: step.stepId,
            attempt,
            operation: { id: step.operationId, version: step.operationVersion },
            actor: actorBinding,
            startedAt: clock(),
            requestBody: resolvedInput,
            result,
            vault: ctx.vault,
            configuredLiterals: opts.configuredSecretLiterals ?? [],
          });
          const key = `${step.stepId}:${attempt}`;
          ctx.rawObservations.set(key, observation);
          ctx.semanticObservations.set(key, project(observation));
          if (redactionFailed) ctx.redactionFailures.push(key);
        }
      }
    } catch (err) {
      if (err instanceof OperationTimeoutError) {
        status = "timed-out";
      } else {
        status = "harness-error";
      }
    }
    return { status, result };
  }

  async function executeStepOnTarget(
    step: ResolvedStep,
    ctx: NonNullable<ReturnType<typeof perTarget.get>>,
    store: CapturedValueStore,
    signal: AbortSignal | undefined,
    now: () => IsoDateTime,
    blocked: Set<StableId>,
  ): Promise<void> {
    const maxAttempts = step.retry ? step.retry.maxAttempts + 1 : 1;
    let status: StepExecutionStatus = "executed";
    let result: RawOperationResult | undefined;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      ctx.events.push({
        kind: "step-started",
        targetSlot: ctx.handle.slot,
        stepId: step.stepId,
        attempt,
      });
      const outcome = await attemptOnce(step, ctx, store, attempt);
      status = outcome.status;
      result = outcome.result;
      ctx.attempts.push({ stepId: step.stepId, attempt, status, result });
      ctx.events.push({
        kind: "step-finished",
        targetSlot: ctx.handle.slot,
        stepId: step.stepId,
        attempt,
        status,
      });

      const retryable =
        step.retry &&
        attempt < maxAttempts &&
        result?.harnessFailureReason &&
        step.retry.retryableCategories.includes(result.harnessFailureReason) &&
        status !== "target-lost";
      if (!retryable) break;
      if (step.retry?.backoffMs) await new Promise((r) => setTimeout(r, step.retry!.backoffMs));
    }

    if (status === "timed-out" || status === "harness-error" || status === "target-lost") {
      blocked.add(step.stepId);
    }

    if (status !== "executed") return;

    for (const observer of step.observe) {
      const obsResolved = resolveRefs(observer.input, {
        targetSlot: ctx.handle.slot,
        captures: store,
        namedSecrets: ctx.namedSecrets,
      }) as JsonObject;
      validateOperationInput(observer.operation.id, observer.operation.version, obsResolved);
      const obsResult = await ctx.session!.observe(
        {
          stepId: step.stepId,
          attempt: 1,
          operation: observer.operation,
          actor: step.actor ? ctx.actorBindings.get(step.actor) : undefined,
          input: obsResolved,
        },
        signal ?? new AbortController().signal,
      );
      ctx.observerResults.set(`${step.stepId}:${observer.id}`, obsResult);
      ctx.events.push({
        kind: "observer-finished",
        targetSlot: ctx.handle.slot,
        stepId: step.stepId,
        observationId: observer.id,
      });
    }
  }

  function applyCaptures(
    step: ResolvedStep,
    ctx: NonNullable<ReturnType<typeof perTarget.get>>,
    store: CapturedValueStore,
    result: RawOperationResult,
  ): void {
    for (const capture of step.capture) {
      let value: unknown;
      const body = result.responseBody as Record<string, unknown> | undefined;
      if (capture.from.kind === "semantic" && body && typeof body === "object") {
        value = body[capture.from.field];
      } else if (capture.from.kind === "header") {
        value = result.responseHeaders?.[capture.from.name];
      } else if (capture.from.kind === "json-pointer" && body) {
        value = jsonPointerGet(body, capture.from.pointer);
      }
      const record: CapturedValueRecord = {
        handle: capture.name,
        producerStepId: step.stepId,
        targetSlot: ctx.handle.slot,
        valueType: capture.valueType,
        sensitivity: capture.sensitivity,
        relationLabels: [],
      };
      if (capture.sensitivity === "secret") {
        record.secretHandle = ctx.vault.put("password", String(value ?? ""));
      } else {
        record.persistedValue = (value ?? null) as never;
      }
      store.set(record);
    }
  }

  async function runCleanup(
    cleanup: CleanupSpec,
    ctx: NonNullable<ReturnType<typeof perTarget.get>>,
    store: CapturedValueStore,
  ): Promise<boolean> {
    try {
      const resolved = resolveRefs(cleanup.input, {
        targetSlot: ctx.handle.slot,
        captures: store,
        namedSecrets: ctx.namedSecrets,
      }) as JsonObject;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), cleanup.timeoutMs);
      try {
        const result = await ctx.session!.execute(
          { stepId: cleanup.id, attempt: 1, operation: cleanup.operation, input: resolved },
          controller.signal,
        );
        return result.category !== "harness-failure";
      } finally {
        clearTimeout(timer);
      }
    } catch {
      return false;
    }
  }

  async function teardownAll(reason: "success" | "failure"): Promise<void> {
    for (const ctx of perTarget.values()) {
      if (!ctx.session) continue;
      if (ctx.fsm.state === "executing" || ctx.fsm.state === "ready") {
        try {
          ctx.fsm.transition("quiescing", "teardown requested");
        } catch {
          /* already past quiescing */
        }
      }
      try {
        ctx.fsm.transition("tearing-down", `teardown (${reason})`);
      } catch {
        continue;
      }
      const signal = opts.signal ?? new AbortController().signal;
      const report = await ctx.session.teardown(
        reason === "success" ? "success" : "failure",
        signal,
      );
      // Only tombstone owned resources when teardown actually reports them reclaimed;
      // a "leaked" report must keep its recovery-journal entry visible (§4.2).
      if (report.status !== "leaked") ctx.journal.tombstone(ctx.handle.slot, clock);
      ctx.fsm.transition(
        report.status === "leaked" ? "leaked" : "closed",
        `teardown ${report.status}`,
      );
    }
  }

  function finalize(state: RunTerminalState): MultiTargetRunResult {
    const targetResults = new Map<StableId, TargetRunResult>();
    for (const [slot, ctx] of perTarget) {
      targetResults.set(slot, {
        slot,
        identity: ctx.identity,
        declaredCapabilities: ctx.declaredCapabilities,
        probedCapabilities: ctx.probedCapabilities,
        capabilityResolution: ctx.capabilityResolution,
        events: ctx.events.all(),
        attempts: ctx.attempts,
        observerResults: ctx.observerResults,
        lifecycle: {
          targetSlot: slot,
          transitions: [...ctx.fsm.transitions],
          ownedResources: ctx.journal.toRecord().entries,
          teardown:
            ctx.fsm.state === "closed"
              ? "complete"
              : ctx.fsm.state === "leaked"
                ? "leaked"
                : ctx.journal.leakedEntries().length > 0
                  ? "partial"
                  : "not-started",
        },
        recoveryLeaks: ctx.journal.leakedEntries().map((e) => e.nonSecretIdentifier),
        teardownStatus:
          ctx.fsm.state === "closed"
            ? "complete"
            : ctx.fsm.state === "leaked"
              ? "leaked"
              : "not-started",
        cleanupResults: ctx.cleanupResults,
        rawObservations: ctx.rawObservations,
        semanticObservations: ctx.semanticObservations,
        redactionFailures: ctx.redactionFailures,
      });
      ctx.vault.destroy();
    }
    return { runId, state, targets: targetResults, capturedValueStore, ...(plan ? { plan } : {}) };
  }
}

export type { ActorSpec };
