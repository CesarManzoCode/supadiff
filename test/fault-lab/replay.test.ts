import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  FakeTargetDriver,
  runScenario,
  compareStep,
  buildDivergenceSignatures,
  buildBundle,
  type BundleTargetRun,
  type TargetHandle,
} from "@supadiff/engine";
import { computeScenarioDigest, sha256OfCanonicalJson, canonicalizeJson } from "@supadiff/spec";
import { replayCommand, writeBundleDirectory, type ParsedArgs } from "supadiff";
import { FAULT_DEFINITIONS, FAULT_LAB_POLICY } from "./fixtures.js";

function targetSpecFor(slot: string, script: unknown) {
  return {
    id: slot,
    kind: "fake" as const,
    runtime: { runtime: "node", version: process.version },
    config: { scriptId: slot, script },
    credentialRefs: [],
    lifecycle: {
      allocation: "provision-new" as const,
      isolation: "fresh-instance" as const,
      readinessTimeoutMs: 2000,
      teardownTimeoutMs: 2000,
      cleanup: "always" as const,
      keepOnFailure: "deny" as const,
    },
    safety: {
      allowHosted: false,
      allowHostedCreate: false,
      allowHostedDestructive: false,
      maxHostedCostUsd: 0,
    },
  };
}

async function buildRealArtifact(faultId: string, dir: string): Promise<string> {
  const fault = FAULT_DEFINITIONS.find((f) => f.id === faultId)!;
  const referenceSpec = targetSpecFor("reference", fault.referenceScript);
  const candidateSpec = targetSpecFor("faulty", fault.faultyScript);
  const driver = new FakeTargetDriver({
    reference: fault.referenceScript,
    faulty: fault.faultyScript,
  });
  const handles: TargetHandle[] = [
    { slot: "reference", spec: referenceSpec as never, driver },
    { slot: "faulty", spec: candidateSpec as never, driver },
  ];
  const result = await runScenario(fault.scenario, handles, { policy: FAULT_LAB_POLICY });
  const scenarioDigest = computeScenarioDigest(fault.scenario);
  const ref = result.targets.get("reference")!;
  const cand = result.targets.get("faulty")!;

  const results = compareStep({
    scenarioId: fault.scenario.id,
    scenarioDigest,
    scenarioRevision: fault.scenario.revision,
    stepId: "step.probe",
    referenceSlot: "reference",
    candidateSlot: "faulty",
    referenceTarget: { kind: "fake", version: "1.0.0" },
    candidateTarget: { kind: "fake", version: "1.0.0" },
    referenceObservation: ref.semanticObservations.get("step.probe:1")!,
    candidateObservation: cand.semanticObservations.get("step.probe:1")!,
    referenceRawDigest: sha256OfCanonicalJson(ref.rawObservations.get("step.probe:1") as never),
    candidateRawDigest: sha256OfCanonicalJson(cand.rawObservations.get("step.probe:1") as never),
    policy: FAULT_LAB_POLICY,
    registry: [],
    now: new Date(),
  });

  const bundleTargets: BundleTargetRun[] = [
    {
      slot: "reference",
      role: "reference",
      targetSpec: referenceSpec as never,
      identity: ref.identity,
      capabilities: ref.probedCapabilities,
      events: ref.events,
      rawObservations: ref.rawObservations,
      semanticObservations: ref.semanticObservations,
    },
    {
      slot: "faulty",
      role: "candidate",
      targetSpec: candidateSpec as never,
      identity: cand.identity,
      capabilities: cand.probedCapabilities,
      events: cand.events,
      rawObservations: cand.rawObservations,
      semanticObservations: cand.semanticObservations,
    },
  ];
  const bundle = buildBundle({
    scenario: fault.scenario,
    policy: FAULT_LAB_POLICY,
    knownDivergences: [],
    targets: bundleTargets,
    comparisonResults: results,
    divergenceSignatures: buildDivergenceSignatures(fault.scenario, results, "fake", "fake"),
    toolchain: { name: "supadiff", version: "0.1.0", node: process.version },
    recoverySummary: { leaks: [] },
    configuredSecretLiterals: [],
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  expect(bundle.secretScanPassed).toBe(true);

  const artifactDir = path.join(dir, `${faultId}.supadiff`);
  await writeBundleDirectory(bundle.files, artifactDir);
  return artifactDir;
}

function parsedArgsFor(artifactPath: string, policyPath: string, outDir: string): ParsedArgs {
  return {
    command: "replay",
    positionals: [artifactPath],
    targets: [],
    flags: {
      out: outDir,
      output: "json",
      failOn: ["new", "inconclusive", "cleanup"],
      policy: policyPath,
      quiet: true,
      noColor: true,
    },
  };
}

describe("L9 replay (§9.2, §14.1)", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  for (const fault of FAULT_DEFINITIONS) {
    it(`replays "${fault.id}" and reproduces the same divergence signature`, async () => {
      const tmp = mkdtempSync(path.join(tmpdir(), "supadiff-fault-lab-"));
      dirs.push(tmp);
      const artifactDir = await buildRealArtifact(fault.id, tmp);

      const policyPath = path.join(tmp, "policy.json");
      writeFileSync(policyPath, canonicalizeJson(FAULT_LAB_POLICY as never));

      const outDir = path.join(tmp, "replay-out");
      const originalWrite = process.stdout.write.bind(process.stdout);
      let captured = "";
      process.stdout.write = ((chunk: string) => {
        captured += chunk;
        return true;
      }) as never;
      let exitCode: number;
      try {
        exitCode = await replayCommand(parsedArgsFor(artifactDir, policyPath, outDir));
      } finally {
        process.stdout.write = originalWrite;
      }

      const cliResult = JSON.parse(captured.trim().split("\n").at(-1)!) as {
        ok: boolean;
        state: string;
        summary: string;
      };
      expect(cliResult.state, cliResult.summary).toBe("complete");
      expect(cliResult.ok, cliResult.summary).toBe(true);
      expect(exitCode).toBe(0);
    });
  }
});
