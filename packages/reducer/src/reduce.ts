import type { ScenarioSpec, StableId } from "@supadiff/spec";
import { dependencyClosure } from "./graph/types.js";
import { buildReductionGraph } from "./graph/build.js";
import { applyStepRemoval } from "./passes/apply.js";
import { ddmin } from "./passes/ddmin.js";
import { runAcceptanceOracle } from "./oracle/accept.js";
import { createOracleCache, cacheKey } from "./cache/index.js";
import { BudgetTracker, DEFAULT_BUDGET, type ReductionBudget } from "./budget/index.js";
import type { ReductionContext } from "./oracle/types.js";

export type { ReductionContext, AcceptanceOutcome, AcceptanceOracle } from "./oracle/types.js";
export { runAcceptanceOracle } from "./oracle/accept.js";
export { buildReductionGraph } from "./graph/build.js";
export * from "./graph/types.js";
export { DEFAULT_BUDGET, type ReductionBudget } from "./budget/index.js";

export type ReductionMinimality = "minimal" | "best-within-budget" | "inconclusive-flaky";

export interface ReduceResult {
  minimality: ReductionMinimality;
  original: ScenarioSpec;
  reduced: ScenarioSpec;
  originalStepCount: number;
  reducedStepCount: number;
  candidateExecutions: number;
  cacheHits: number;
  flakeReplayCount: number;
}

/**
 * Reduces one reproducible divergence (§11): three fresh-target flake-check replays,
 * then fixed dependency-safe passes (currently: suffix removal via delta-debugging over
 * the step list, then actor/resource/observer/cleanup pruning of whatever becomes
 * unreferenced) until a fixed point or the budget is exhausted. Every accepted candidate
 * ran on fresh target state (§11.2); nothing here ever reuses a mutated target.
 */
export async function reduceArtifact(
  scenario: ScenarioSpec,
  failingStepId: StableId,
  ctx: ReductionContext,
  budget: ReductionBudget = DEFAULT_BUDGET,
): Promise<ReduceResult> {
  const tracker = new BudgetTracker(budget);
  const cache = createOracleCache();
  let cacheHits = 0;

  async function tryCandidate(candidate: ScenarioSpec): Promise<boolean> {
    const key = cacheKey(candidate, ctx);
    const cached = cache.get(key);
    if (cached) {
      cacheHits++;
      return cached.accepted;
    }
    tracker.recordCandidateExecution();
    const outcome = await runAcceptanceOracle(candidate, ctx);
    cache.set(key, outcome);
    return outcome.accepted;
  }

  // §11.4: flake gate — replay the ORIGINAL three times on fresh targets before reducing.
  let flakeReplayCount = 0;
  let reproduceCount = 0;
  for (let i = 0; i < 3; i++) {
    flakeReplayCount++;
    const outcome = await runAcceptanceOracle(scenario, ctx);
    if (outcome.accepted) reproduceCount++;
  }
  if (reproduceCount < 3) {
    return {
      minimality: "inconclusive-flaky",
      original: scenario,
      reduced: scenario,
      originalStepCount: scenario.steps.length,
      reducedStepCount: scenario.steps.length,
      candidateExecutions: tracker.candidateExecutions,
      cacheHits,
      flakeReplayCount,
    };
  }

  const graph = buildReductionGraph(scenario);
  const mustKeepSteps = dependencyClosure(graph, [failingStepId]);

  let current = scenario;
  let ordinal = 0;
  let anyChangeThisRound = true;

  while (!tracker.exhausted() && !tracker.fixedPoint() && anyChangeThisRound) {
    anyChangeThisRound = false;

    const currentRemovable = current.steps.map((s) => s.id).filter((id) => !mustKeepSteps.has(id));
    if (currentRemovable.length > 0) {
      const kept = await ddmin(currentRemovable, async (removed) => {
        if (tracker.exhausted()) return false;
        ordinal++;
        const candidate = applyStepRemoval(current, removed, ordinal);
        return tryCandidate(candidate);
      });
      const removedSet = new Set(currentRemovable.filter((id) => !kept.includes(id)));
      if (removedSet.size > 0) {
        ordinal++;
        current = applyStepRemoval(current, removedSet, ordinal);
        anyChangeThisRound = true;
      }
    }

    // Prune now-unreferenced actors/resources/observers/cleanup without removing any
    // step (§11.3 passes 4/7 at this build's step/actor/resource granularity).
    ordinal++;
    const pruned = applyStepRemoval(current, new Set(), ordinal);
    if (
      pruned.actors.length !== current.actors.length ||
      pruned.resources.length !== current.resources.length ||
      pruned.cleanup.length !== current.cleanup.length
    ) {
      if (await tryCandidate(pruned)) {
        current = pruned;
        anyChangeThisRound = true;
      }
    }

    tracker.recordPassOutcome(anyChangeThisRound);
  }

  return {
    minimality: tracker.exhausted() ? "best-within-budget" : "minimal",
    original: scenario,
    reduced: current,
    originalStepCount: scenario.steps.length,
    reducedStepCount: current.steps.length,
    candidateExecutions: tracker.candidateExecutions,
    cacheHits,
    flakeReplayCount,
  };
}
