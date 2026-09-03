import type { Sha256, StableId } from "../ids.js";
import type { ExactPackageIdentity, TargetKind } from "../target/types.js";

export type { ExactPackageIdentity } from "../target/types.js";

/** A reference to bundled content, addressed by path and SHA-256 (§2.13, §9.1). */
export interface ContentRef {
  path: string;
  sha256: Sha256;
}

export interface SanitizedTargetRecipe {
  targetSlot: StableId;
  kind: TargetKind;
  package?: ExactPackageIdentity;
  runtime: { runtime: string; version: string };
  backend?: { backend: string; version?: string };
  config: Record<string, unknown>;
}

export interface ExternalSecretRequirement {
  secretRef: StableId;
  description: string;
}

export interface DivergenceSignature {
  scenarioDigest: Sha256;
  operationId: StableId;
  operationVersion: string;
  stepId: StableId;
  observablePath: string;
  ruleId: StableId;
  ruleVersion: string;
  outcome: string;
  referenceSelector: { kind: string; backend?: string; versionRange?: string };
  candidateSelector: { kind: string; backend?: string; versionRange?: string };
  normalizedFailurePredicateDigest: Sha256;
}

export interface ReplayEntrypoint {
  command: string;
  args: string[];
}

export interface ReproductionManifest {
  format: "supadiff.reproduction";
  formatVersion: "1.0";
  artifactId: Sha256;
  createdBy: ExactPackageIdentity;
  scenario: ContentRef;
  comparisonPolicy: ContentRef;
  targetRecipes: SanitizedTargetRecipe[];
  requiredExternalSecrets: ExternalSecretRequirement[];
  expectedSignature: DivergenceSignature;
  entrypoint: ReplayEntrypoint;
  checksums: ContentRef;
}

export interface SecretScanFinding {
  location: string;
  detector: string;
}

export interface SecretScanReceipt {
  scannedAt: string;
  filesScanned: number;
  findings: SecretScanFinding[];
  passed: boolean;
}

export interface ArtifactManifest {
  format: "supadiff.artifact";
  formatVersion: "1.0";
  artifactKind: "run" | "comparison" | "reproduction" | "reduction";
  content: ContentRef[];
  secretScan: SecretScanReceipt;
  checksums: ContentRef;
}
