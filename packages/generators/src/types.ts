import type { CapabilityRequirement, ScenarioSpec, StableId, VersionedRef } from "@supadiff/spec";

/**
 * Generation seam (Architecture Contract §10): the engine does not know whether a
 * scenario was authored or generated, so `ScenarioGenerator`/`GeneratedScenario` mirror
 * the contract's own interfaces exactly — no `fast-check` type ever appears here (§10.1:
 * "SupaDiff MUST NOT expose fast-check types in the public scenario or generator
 * interfaces").
 */
export interface GenerationRequest {
  /** Uint64-decimal seed string (§2.2 `ScenarioSpec.seed` shape) driving this generator run. */
  seed: string;
  /** How many `GeneratedScenario`s to produce from this seed, in order. */
  count: number;
  /** Capability intersection generation must stay inside (§10.2: "not from all SQL or all supabase-js"). */
  capabilityEnvelope: CapabilityRequirement[];
  /** Budget caps on schema objects, actors, rows, policy clauses, operation count (§10.2). */
  budget?: GenerationBudget;
}

export interface GenerationBudget {
  maxTables?: number;
  maxColumnsPerTable?: number;
  maxOperations?: number;
}

/**
 * One decision the generator's model interpreter made while walking a raw draw:
 * an operation that was requested by the underlying arbitrary but whose precondition
 * did not hold against the current model state, and so was skipped rather than emitted
 * as an invalid step (§10.2: "An operation is emitted only when its preconditions are
 * satisfied") — or an operation that was emitted, recorded for the same auditability.
 */
export interface GenerationDecision {
  kind: "emitted" | "skipped-precondition";
  operation: string;
  reason: string;
  stepId?: StableId;
}

export interface GeneratedScenario {
  scenario: ScenarioSpec;
  generation: {
    seed: string;
    /**
     * Ordinal position of this scenario within the deterministic seeded draw sequence
     * for its `GenerationRequest` (index into `fast-check`'s `sample(arbitrary, {seed,
     * numRuns})` output) — an opaque string per §10.1, not `fast-check`'s internal
     * shrink-path notation, since nothing here is shrunk (shrinking is L10's job,
     * applied afterward to a persisted artifact, never during generation itself).
     */
    path: string;
    model: VersionedRef;
    capabilityEnvelope: CapabilityRequirement[];
    decisions: GenerationDecision[];
  };
}

export interface ScenarioGenerator {
  readonly id: VersionedRef;
  generate(input: GenerationRequest): AsyncIterable<GeneratedScenario>;
}
