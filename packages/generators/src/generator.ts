import type { VersionedRef } from "@supadiff/spec";
import { RESOLVED_BUDGET_DEFAULTS, sampleGenerationPlans } from "./model/arbitraries.js";
import { buildScenario, interpretPlan } from "./model/interpret.js";
import type { GeneratedScenario, GenerationRequest, ScenarioGenerator } from "./types.js";

export const DATA_AUTH_RLS_GENERATOR_ID: VersionedRef = {
  id: "generator.data-auth-rls",
  version: "1.0.0",
};

/**
 * `ScenarioGenerator` for the Data+Auth+RLS domain (§10, L12): an owner-scoped,
 * RLS-enabled schema (1-2 tables) plus a precondition-checked insert/select/update/
 * delete operation sequence. Deterministic under `{seed, count, budget}`: replaying
 * the same request always yields byte-identical `ScenarioSpec`s (§10.2).
 */
export class DataAuthRlsGenerator implements ScenarioGenerator {
  readonly id = DATA_AUTH_RLS_GENERATOR_ID;

  async *generate(input: GenerationRequest): AsyncIterable<GeneratedScenario> {
    const budget = { ...RESOLVED_BUDGET_DEFAULTS, ...input.budget };
    const plans = sampleGenerationPlans(input.seed, input.count, budget);
    for (let path = 0; path < plans.length; path++) {
      const plan = plans[path]!;
      const interpreted = interpretPlan(plan);
      const scenarioId = `scn.generated.${input.seed}.${path}`;
      // `computeScenarioDigest` hashes the whole canonical scenario, `provenance.createdAt`
      // included -- a real wall-clock timestamp here would make two replays of the same
      // {seed, path} produce different bytes depending on when each ran, defeating §10.2's
      // "replaying those values must yield the byte-identical canonical scenario". Fixed
      // at the epoch instead; the generation itself is what is timestamped, not fabricated
      // as an authoring time.
      const scenario = buildScenario(scenarioId, input.seed, interpreted, {
        origin: "generated",
        createdAt: new Date(0).toISOString(),
        generatedBy: this.id,
      });
      yield {
        scenario,
        generation: {
          seed: input.seed,
          path: String(path),
          model: this.id,
          capabilityEnvelope: input.capabilityEnvelope,
          decisions: interpreted.decisions,
        },
      };
    }
  }
}
