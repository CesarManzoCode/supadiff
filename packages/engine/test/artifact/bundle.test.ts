import { describe, expect, it } from "vitest";
import { buildBundle, type BuildBundleInput, type BundleTargetRun } from "../../src/index.js";
import type {
  ComparisonPolicy,
  RawObservation,
  ScenarioSpec,
  SemanticObservation,
} from "@supadiff/spec";

function minimalScenario(): ScenarioSpec {
  return {
    format: "supadiff.scenario",
    formatVersion: "1.0",
    id: "scn.artifact-test",
    revision: "1",
    title: "Artifact test scenario",
    tags: [],
    seed: "1",
    client: { library: "supabase-js", version: "2.97.0" },
    requirements: [],
    resources: [],
    actors: [],
    steps: [],
    cleanup: [],
    comparison: { policyId: "policy.x", policyVersion: "1" },
    expectedOutcomes: [],
    limits: {
      maxSteps: 10,
      maxWallTimeMs: 1000,
      maxArtifactBytes: 1000,
      maxRequestsPerTarget: 10,
      maxHostedCostUsd: 0,
      maxParallelOperations: 1,
    },
    provenance: { origin: "authored", createdAt: "2026-09-03T00:00:00.000Z" },
  };
}

function emptyPolicy(): ComparisonPolicy {
  return {
    format: "supadiff.comparison-policy",
    formatVersion: "1.0",
    policyId: "policy.x",
    policyVersion: "1",
    rules: [],
  };
}

function rawObs(overrides: Partial<RawObservation> = {}): RawObservation {
  return {
    format: "supadiff.raw-observation",
    observer: { id: "engine.execute", version: "1" },
    observationId: "step.a.1",
    origin: "primary",
    runId: "run-x",
    targetSlot: "reference",
    stepId: "step.a",
    attempt: 1,
    operation: { id: "data.select", version: "1" },
    actor: { role: "anon" },
    startedAt: "2026-09-03T00:00:00.000Z",
    durationMs: 1,
    transport: { requestHeaders: {}, responseHeaders: {}, responseBody: { status: "success" } },
    outcome: { category: "success" },
    attachments: [],
    redaction: { entries: [], structuralDetectorHits: 0 },
    ...overrides,
  };
}

function semanticObs(overrides: Partial<SemanticObservation> = {}): SemanticObservation {
  return {
    format: "supadiff.semantic-observation",
    projector: { id: "data.select", version: "1" },
    sourceRawDigest: `sha256:${"1".repeat(64)}`,
    service: "data",
    operation: { id: "data.select", version: "1" },
    contractFields: { "/status": "success" },
    ignoredFields: [],
    relationships: [],
    stateFacts: [],
    coverage: {
      contractualFields: ["/status"],
      diagnosticFields: [],
      ignoredFields: [],
      unassessedFields: [],
    },
    ...overrides,
  };
}

function baseInput(): BuildBundleInput {
  const target: BundleTargetRun = {
    slot: "reference",
    role: "reference",
    targetSpec: {
      id: "target.reference",
      kind: "fake",
      runtime: { runtime: "node", version: "22.10.0" },
      config: { scriptId: "x" },
      credentialRefs: [],
      lifecycle: {
        allocation: "provision-new",
        isolation: "fresh-instance",
        readinessTimeoutMs: 1,
        teardownTimeoutMs: 1,
        cleanup: "always",
        keepOnFailure: "deny",
      },
      safety: {
        allowHosted: false,
        allowHostedCreate: false,
        allowHostedDestructive: false,
        maxHostedCostUsd: 0,
      },
    },
    identity: undefined,
    capabilities: [],
    events: [],
    rawObservations: new Map([["step.a:1", rawObs()]]),
    semanticObservations: new Map([["step.a:1", semanticObs()]]),
  };
  return {
    scenario: minimalScenario(),
    policy: emptyPolicy(),
    knownDivergences: [],
    targets: [target],
    comparisonResults: [],
    divergenceSignatures: [],
    toolchain: { name: "supadiff", version: "0.1.0", node: "v22.10.0" },
    recoverySummary: { leaks: [] },
    configuredSecretLiterals: [],
    createdAt: "2026-09-03T00:00:00.000Z",
  };
}

describe("buildBundle determinism", () => {
  it("produces byte-identical files for the same input assembled twice", () => {
    const a = buildBundle(baseInput());
    const b = buildBundle(baseInput());
    expect(a.artifactId).toBe(b.artifactId);
    expect([...a.files.keys()].sort()).toEqual([...b.files.keys()].sort());
    for (const [path, buf] of a.files) {
      expect(buf.equals(b.files.get(path)!)).toBe(true);
    }
  });

  it("produces a different artifactId when a payload changes", () => {
    const a = buildBundle(baseInput());
    const changed = baseInput();
    changed.targets[0]!.rawObservations = new Map([
      [
        "step.a:1",
        rawObs({
          transport: { requestHeaders: {}, responseHeaders: {}, responseBody: { status: "error" } },
        }),
      ],
    ]);
    const b = buildBundle(changed);
    expect(a.artifactId).not.toBe(b.artifactId);
  });

  it("blocks a successful artifact when the structural detector finds an unexplained secret", () => {
    const input = baseInput();
    input.targets[0]!.rawObservations = new Map([
      [
        "step.a:1",
        rawObs({
          transport: {
            requestHeaders: {},
            responseHeaders: {},
            responseBody: {
              note: "-----BEGIN PRIVATE KEY-----\nMIIBleaked\n-----END PRIVATE KEY-----",
            },
          },
        }),
      ],
    ]);
    const result = buildBundle(input);
    expect(result.secretScanPassed).toBe(false);
    expect(result.findings.some((f) => f.detector === "pem-block")).toBe(true);
  });

  it("does not flag legitimate content-hash digests and opaque handles as leaked secrets", () => {
    // Digests and handles are pervasive by design (manifest content refs, checksums,
    // sourceRawDigest, redaction handles) and must never trip the secret scan.
    const result = buildBundle(baseInput());
    expect(result.secretScanPassed).toBe(true);
    expect(result.findings).toHaveLength(0);
  });

  it("checksums.sha256 covers every payload file plus manifest.json, excluding only itself", () => {
    const result = buildBundle(baseInput());
    const checksumText = result.files.get("checksums.sha256")!.toString("utf8");
    const listedPaths = checksumText
      .trim()
      .split("\n")
      .map((l) => l.split("  ")[1]);
    expect(listedPaths).toContain("manifest.json");
    expect(listedPaths).not.toContain("checksums.sha256");
    for (const path of result.files.keys()) {
      if (path === "checksums.sha256") continue;
      expect(listedPaths).toContain(path);
    }
  });
});
