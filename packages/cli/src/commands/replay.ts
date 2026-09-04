import path from "node:path";
import {
  buildBundle,
  buildDivergenceSignatures,
  compareStep,
  runScenario,
  type BundleTargetRun,
  type TargetHandle,
} from "@supadiff/engine";
import {
  computeScenarioDigest,
  sha256OfCanonicalJson,
  type ComparisonResult,
  type DivergenceSignature,
} from "@supadiff/spec";
import type { ParsedArgs } from "../config/parse-args.js";
import { readRunArtifact } from "../bundle-read.js";
import { loadKnownDivergences, loadPolicy } from "../load-inputs.js";
import { buildDriverForSpec } from "../driver-registry.js";
import { candidateRecipes, recipeToTargetSpec, type SanitizedRecipeJson } from "../recipe.js";
import { writeBundleDirectory } from "../artifact-io.js";
import { verifyChecksums } from "../verify-checksums.js";
import { renderResult, type CliResult } from "../output/render.js";
import {
  EXIT_INCONCLUSIVE,
  EXIT_INVALID,
  EXIT_OK,
  EXIT_BEHAVIORAL_POLICY_VIOLATION,
} from "../exit-codes.js";

function signatureDigest(sig: DivergenceSignature): string {
  return sha256OfCanonicalJson(sig as never);
}

/**
 * `supadiff replay <artifact>` (§9.2, §14.1): validates a prior comparison artifact
 * offline, reconstructs fresh targets from its sanitized recipes (never reusing the
 * original run's live endpoints/credentials), re-executes the same canonical scenario,
 * recomputes the divergence signature, and reports whether the SAME semantic
 * incompatibility reproduced.
 */
export async function replayCommand(args: ParsedArgs): Promise<number> {
  const [artifactPath] = args.positionals;
  if (!artifactPath) {
    process.stderr.write("supadiff replay: missing <artifact.supadiff>\n");
    return EXIT_INVALID;
  }

  const artifact = await readRunArtifact(artifactPath);
  const checks = verifyChecksums(artifact.files);
  if (!checks.ok) {
    process.stderr.write(
      `supadiff replay: checksum validation failed — missing: [${checks.missing.join(", ")}], ` +
        `mismatched: [${checks.mismatched.join(", ")}]\n`,
    );
    return EXIT_INVALID;
  }
  if (artifact.manifest.artifactKind !== "comparison") {
    process.stderr.write(
      `supadiff replay: "${artifactPath}" is a "${artifact.manifest.artifactKind}" artifact, not a ` +
        `comparison artifact — there is no recorded divergence to reproduce\n`,
    );
    return EXIT_INVALID;
  }

  const signaturesBuf = artifact.files.get("comparison/divergence-signature.json");
  const recordedSignatures = signaturesBuf
    ? (JSON.parse(signaturesBuf.toString("utf8")) as DivergenceSignature[])
    : [];
  if (recordedSignatures.length === 0) {
    process.stderr.write(
      `supadiff replay: "${artifactPath}" recorded no divergence signature — nothing to replay ` +
        `(only known/new-divergence outcomes produce one; a clean match has nothing to reproduce)\n`,
    );
    return EXIT_INVALID;
  }
  const expectedSignature = recordedSignatures[0]!;

  const referenceSpec = recipeToTargetSpec(artifact.targetRecipe as unknown as SanitizedRecipeJson);
  const [candidateSpec] = candidateRecipes(artifact.files);
  if (!candidateSpec) {
    process.stderr.write(`supadiff replay: "${artifactPath}" has no candidate target recipe\n`);
    return EXIT_INVALID;
  }

  const policy = await loadPolicy(args.flags.policy, artifact.scenario, { required: true });
  const knownDivergences = await loadKnownDivergences(args.flags.divergences);

  const referenceDriver = buildDriverForSpec(
    referenceSpec,
    artifact.scenario.resources,
    artifact.scenario.client,
  );
  const candidateDriver = buildDriverForSpec(
    candidateSpec,
    artifact.scenario.resources,
    artifact.scenario.client,
  );
  const handles: TargetHandle[] = [
    { slot: referenceSpec.id, spec: referenceSpec, driver: referenceDriver },
    { slot: candidateSpec.id, spec: candidateSpec, driver: candidateDriver },
  ];

  const result = await runScenario(artifact.scenario, handles, { policy });
  const scenarioDigest = computeScenarioDigest(artifact.scenario);

  const referenceRun = result.targets.get(referenceSpec.id)!;
  const candidateRun = result.targets.get(candidateSpec.id)!;
  const finalSemantic = (
    t: typeof referenceRun,
  ): Map<
    string,
    typeof t.semanticObservations extends ReadonlyMap<string, infer V> ? V : never
  > => {
    const byStep = new Map<string, string>();
    for (const key of t.semanticObservations.keys()) {
      const [stepId, attemptStr] = key.split(":");
      const attempt = Number(attemptStr);
      const current = byStep.get(stepId!);
      if (!current || attempt >= Number(current.split(":")[1])) byStep.set(stepId!, key);
    }
    const out = new Map();
    for (const [stepId, key] of byStep) out.set(stepId, t.semanticObservations.get(key)!);
    return out;
  };
  const refSemantics = finalSemantic(referenceRun);
  const candSemantics = finalSemantic(candidateRun);

  const comparisonResults: ComparisonResult[] = [];
  for (const step of artifact.scenario.steps) {
    const refObs = refSemantics.get(step.id);
    const candObs = candSemantics.get(step.id);
    if (!refObs || !candObs) continue;
    comparisonResults.push(
      ...compareStep({
        scenarioId: artifact.scenario.id,
        scenarioDigest,
        scenarioRevision: artifact.scenario.revision,
        stepId: step.id,
        referenceSlot: referenceSpec.id,
        candidateSlot: candidateSpec.id,
        referenceTarget: {
          kind: referenceSpec.kind,
          backend: referenceRun.identity?.backend?.backend,
          version: referenceRun.identity?.implementationVersion ?? "0.0.0",
        },
        candidateTarget: {
          kind: candidateSpec.kind,
          backend: candidateRun.identity?.backend?.backend,
          version: candidateRun.identity?.implementationVersion ?? "0.0.0",
        },
        referenceObservation: refObs,
        candidateObservation: candObs,
        referenceRawDigest: sha256OfCanonicalJson(
          referenceRun.rawObservations.get(`${step.id}:1`) as never,
        ),
        candidateRawDigest: sha256OfCanonicalJson(
          candidateRun.rawObservations.get(`${step.id}:1`) as never,
        ),
        policy,
        registry: knownDivergences,
        now: new Date(),
      }),
    );
  }

  const newSignatures = buildDivergenceSignatures(
    artifact.scenario,
    comparisonResults,
    referenceSpec.kind,
    candidateSpec.kind,
  );
  const reproduced = newSignatures.some(
    (s) => signatureDigest(s) === signatureDigest(expectedSignature),
  );

  let artifactOutPath: string | undefined;
  if (result.state === "complete" || result.state === "inconclusive-cleanup") {
    const bundleTargets: BundleTargetRun[] = [
      {
        slot: referenceSpec.id,
        role: "reference",
        targetSpec: referenceSpec,
        identity: referenceRun.identity,
        capabilities: referenceRun.probedCapabilities,
        events: referenceRun.events,
        rawObservations: referenceRun.rawObservations,
        semanticObservations: referenceRun.semanticObservations,
      },
      {
        slot: candidateSpec.id,
        role: "candidate",
        targetSpec: candidateSpec,
        identity: candidateRun.identity,
        capabilities: candidateRun.probedCapabilities,
        events: candidateRun.events,
        rawObservations: candidateRun.rawObservations,
        semanticObservations: candidateRun.semanticObservations,
      },
    ];
    const bundle = buildBundle({
      scenario: artifact.scenario,
      policy,
      knownDivergences,
      targets: bundleTargets,
      comparisonResults,
      divergenceSignatures: newSignatures,
      toolchain: { name: "supadiff", version: "0.1.0", node: process.version },
      recoverySummary: {
        leaks: [...referenceRun.recoveryLeaks, ...candidateRun.recoveryLeaks],
      },
      configuredSecretLiterals: [],
      createdAt: new Date().toISOString(),
    });
    if (bundle.secretScanPassed) {
      artifactOutPath =
        args.flags.out ??
        path.join(process.cwd(), "supadiff-artifacts", `${result.runId}.replay.supadiff`);
      await writeBundleDirectory(bundle.files, artifactOutPath);
    }
  }

  const exitCode = reproduced ? EXIT_OK : EXIT_BEHAVIORAL_POLICY_VIOLATION;
  const cliResult: CliResult = {
    format: "supadiff.cli-result",
    formatVersion: "1",
    command: "replay",
    ok: reproduced,
    state: result.state,
    exitCode: result.state === "complete" ? exitCode : EXIT_INCONCLUSIVE,
    ...(artifactOutPath ? { artifactPath: artifactOutPath } : {}),
    summary: reproduced
      ? `replay reproduced the expected divergence signature`
      : `replay did NOT reproduce the expected divergence signature (run state: ${result.state})`,
    outcomeCounts: comparisonResults.reduce<Record<string, number>>((acc, r) => {
      acc[r.outcome] = (acc[r.outcome] ?? 0) + 1;
      return acc;
    }, {}),
  };
  renderResult(args.flags.output, cliResult);
  return result.state === "complete" ? exitCode : EXIT_INCONCLUSIVE;
}
