import type {
  ComparisonPolicy,
  DivergenceSignature,
  KnownDivergence,
  ScenarioSpec,
  TargetSpec,
} from "@supadiff/spec";
import type { TargetDriver } from "@supadiff/engine/spi";

/**
 * Everything the reducer needs to try one candidate on FRESH target state (§11.2: "The
 * oracle runs on fresh target state. Reusing a mutated target between candidates is
 * forbidden."). `buildDriver` is supplied by the caller (the CLI layer, which alone may
 * import `@supadiff/targets` — §13.2) so this package never imports concrete target
 * internals.
 */
export interface ReductionContext {
  referenceSpec: TargetSpec;
  candidateSpec: TargetSpec;
  buildDriver: (spec: TargetSpec, resources: ScenarioSpec["resources"]) => TargetDriver;
  policy: ComparisonPolicy;
  knownDivergences: readonly KnownDivergence[];
  expectedSignature: DivergenceSignature;
  toolchainId: string;
}

export type AcceptanceOutcome = { accepted: true } | { accepted: false; reason: string };

export interface AcceptanceOracle {
  (candidate: ScenarioSpec, ctx: ReductionContext): Promise<AcceptanceOutcome>;
}
