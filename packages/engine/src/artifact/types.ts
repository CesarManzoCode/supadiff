import type {
  ComparisonPolicy,
  ComparisonResult,
  DivergenceSignature,
  KnownDivergence,
  RawObservation,
  ScenarioSpec,
  SemanticObservation,
  TargetIdentity,
  TargetSpec,
} from "@supadiff/spec";
import type { RunEvent } from "../execution/events.js";
import type { TargetCapability } from "@supadiff/spec";

export interface BundleTargetRun {
  slot: string;
  role: "reference" | "candidate";
  targetSpec: TargetSpec;
  identity: TargetIdentity | undefined;
  capabilities: TargetCapability[];
  events: readonly RunEvent[];
  /** Keyed by `${stepId}:${attempt}`. */
  rawObservations: ReadonlyMap<string, RawObservation>;
  semanticObservations: ReadonlyMap<string, SemanticObservation>;
}

export interface BuildBundleInput {
  scenario: ScenarioSpec;
  policy: ComparisonPolicy;
  knownDivergences: readonly KnownDivergence[];
  targets: BundleTargetRun[];
  comparisonResults: ComparisonResult[];
  divergenceSignatures: DivergenceSignature[];
  toolchain: { name: string; version: string; node: string };
  recoverySummary: { leaks: string[] };
  configuredSecretLiterals: string[];
  /** Fixed timestamp for deterministic ZIP entry metadata (RFC3339). */
  createdAt: string;
}
