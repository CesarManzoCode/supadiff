/**
 * Deterministic fake target driver — test infrastructure only (§15.2). Never accepted
 * as evidence about Supabase or Supalite. Scripted at the semantic operation level so
 * L2-L5 tests can exercise the engine without any real backend.
 */
import type {
  ActorSpec,
  StableId,
  TargetCapability,
  TargetIdentity,
  TargetSpec,
} from "@supadiff/spec";
import type {
  ActorBinding,
  HarnessFailureReason,
  OperationRequest,
  ProvisionContext,
  RawOperationResult,
  RecoveryRecord,
  SecretVault,
  TargetDriver,
  TargetSession,
  TeardownReason,
  TeardownReport,
} from "../spi/types.js";

export interface FakeStepScript {
  category?: "success" | "application-error" | "harness-failure";
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
  harnessFailureReason?: HarnessFailureReason;
  delayMs?: number;
  /** Fails as harness-failure on attempts before this one, then succeeds (flakiness). */
  flakyUntilAttempt?: number;
}

export interface FakeScript {
  identity: TargetIdentity;
  declaredCapabilities: TargetCapability[];
  /** Overrides declared capabilities at runtime-probe time (simulates downgrade). */
  probedCapabilities?: TargetCapability[];
  steps: Record<string, FakeStepScript>;
  cleanupRefusal?: string[];
  teardownStatus?: "complete" | "partial" | "leaked";
  /** If true, the very first `execute()` call throws to simulate provisioning-time death. */
  diesOnFirstExecute?: boolean;
}

const DEFAULT_STEP_SCRIPT: FakeStepScript = { category: "success", status: 200, body: {} };

class FakeTargetSession implements TargetSession {
  readonly handleId: StableId;
  #script: FakeScript;
  #attemptCounts = new Map<string, number>();
  #executed = false;

  constructor(handleId: StableId, script: FakeScript) {
    this.handleId = handleId;
    this.#script = script;
  }

  async identify(): Promise<TargetIdentity> {
    return this.#script.identity;
  }

  async probeCapabilities(): Promise<TargetCapability[]> {
    return this.#script.probedCapabilities ?? this.#script.declaredCapabilities;
  }

  async openActor(actor: ActorSpec, vault: SecretVault): Promise<ActorBinding> {
    const handle = vault.put("session", `fake-session-${actor.id}`);
    return {
      actorId: actor.id,
      targetSlot: this.handleId,
      role:
        actor.kind === "service"
          ? "service_role"
          : actor.kind === "user"
            ? "authenticated"
            : "anon",
      session: handle,
      state: "active",
    };
  }

  async #run(request: OperationRequest): Promise<RawOperationResult> {
    if (this.#script.diesOnFirstExecute && !this.#executed) {
      this.#executed = true;
      return { category: "harness-failure", harnessFailureReason: "process-death", durationMs: 0 };
    }
    this.#executed = true;
    const stepScript = this.#script.steps[request.stepId] ?? DEFAULT_STEP_SCRIPT;
    const count = (this.#attemptCounts.get(request.stepId) ?? 0) + 1;
    this.#attemptCounts.set(request.stepId, count);

    if (stepScript.delayMs) await new Promise((r) => setTimeout(r, stepScript.delayMs));

    if (stepScript.flakyUntilAttempt && request.attempt < stepScript.flakyUntilAttempt) {
      return { category: "harness-failure", harnessFailureReason: "disconnect", durationMs: 0 };
    }

    return {
      category: stepScript.category ?? "success",
      status: stepScript.status,
      responseHeaders: stepScript.headers ?? {},
      responseBody: stepScript.body ?? {},
      harnessFailureReason: stepScript.harnessFailureReason,
      durationMs: stepScript.delayMs ?? 0,
    };
  }

  async execute(request: OperationRequest, signal: AbortSignal): Promise<RawOperationResult> {
    if (signal.aborted) {
      return { category: "harness-failure", harnessFailureReason: "timeout", durationMs: 0 };
    }
    return this.#run(request);
  }

  async observe(request: OperationRequest, signal: AbortSignal): Promise<RawOperationResult> {
    return this.execute(request, signal);
  }

  async teardown(_reason: TeardownReason): Promise<TeardownReport> {
    return { status: this.#script.teardownStatus ?? "complete", leaks: [] };
  }
}

export class FakeTargetDriver implements TargetDriver {
  readonly kind = "fake";
  #scripts: Record<string, FakeScript>;

  constructor(scripts: Record<string, FakeScript>) {
    this.#scripts = scripts;
  }

  #scriptFor(spec: TargetSpec): FakeScript {
    const scriptId = (spec.config as { scriptId?: string }).scriptId;
    const script = scriptId ? this.#scripts[scriptId] : undefined;
    if (!script)
      throw new Error(`FakeTargetDriver: no script registered for scriptId "${scriptId}"`);
    return script;
  }

  async declareCapabilities(spec: TargetSpec): Promise<TargetCapability[]> {
    return this.#scriptFor(spec).declaredCapabilities;
  }

  async provision(spec: TargetSpec, _ctx: ProvisionContext): Promise<TargetSession> {
    const script = this.#scriptFor(spec);
    return new FakeTargetSession(spec.id, script);
  }

  async recover(_record: RecoveryRecord): Promise<void> {
    // Fake provider: nothing external to reconcile.
  }
}
