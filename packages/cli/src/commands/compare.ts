import {
  compareStep,
  buildDivergenceSignatures,
  buildBundle,
  type BundleTargetRun,
} from "@supadiff/engine";
import {
  computeScenarioDigest,
  sha256OfCanonicalJson,
  type ComparisonResult,
} from "@supadiff/spec";
import type { ParsedArgs } from "../config/parse-args.js";
import { readRunArtifact } from "../bundle-read.js";
import { loadKnownDivergences, loadPolicy } from "../load-inputs.js";
import { writeBundleDirectory } from "../artifact-io.js";
import { renderResult, type CliResult } from "../output/render.js";
import {
  EXIT_INVALID,
  EXIT_OK,
  EXIT_BEHAVIORAL_POLICY_VIOLATION,
  EXIT_INCONCLUSIVE,
  DEFAULT_FAIL_ON,
} from "../exit-codes.js";
import path from "node:path";

/**
 * `supadiff compare` is offline (§14.1): it never contacts a target. Given two run
 * artifacts, it verifies compatible scenario/policy identity and compares them.
 */
export async function compareCommand(args: ParsedArgs): Promise<number> {
  const [pathA, pathB] = args.positionals;
  if (!pathA) {
    process.stderr.write("supadiff compare: missing <run-or-comparison-artifact>\n");
    return EXIT_INVALID;
  }
  if (!pathB) {
    // Single-artifact mode: re-render an existing comparison artifact's results offline.
    const artifact = await readRunArtifact(pathA);
    const resultsPath = "comparison/results.json";
    if (!artifact.files.has(resultsPath)) {
      process.stderr.write(
        `supadiff compare: "${pathA}" has no comparison/results.json to re-render\n`,
      );
      return EXIT_INVALID;
    }
    const results = JSON.parse(
      artifact.files.get(resultsPath)!.toString("utf8"),
    ) as ComparisonResult[];
    return emit(args, results, undefined);
  }

  const [a, b] = await Promise.all([readRunArtifact(pathA), readRunArtifact(pathB)]);

  const digestA = computeScenarioDigest(a.scenario);
  const digestB = computeScenarioDigest(b.scenario);
  if (digestA !== digestB) {
    process.stderr.write(
      `supadiff compare: scenario digests differ between "${pathA}" and "${pathB}"; artifacts are not comparable\n`,
    );
    return EXIT_INVALID;
  }

  const knownDivergences = await loadKnownDivergences(args.flags.divergences);
  const policy = await loadPolicy(args.flags.policy, a.scenario);

  const referenceKind = (a.targetRecipe as { kind?: string }).kind ?? "unknown";
  const candidateKind = (b.targetRecipe as { kind?: string }).kind ?? "unknown";

  const results: ComparisonResult[] = [];
  for (const step of a.scenario.steps) {
    const refObs = a.finalSemanticByStep.get(step.id);
    const candObs = b.finalSemanticByStep.get(step.id);
    if (!refObs || !candObs) continue;
    const refRaw = a.finalRawByStep.get(step.id);
    const candRaw = b.finalRawByStep.get(step.id);
    if (!refRaw || !candRaw) continue;
    results.push(
      ...compareStep({
        scenarioId: a.scenario.id,
        scenarioDigest: digestA,
        stepId: step.id,
        referenceSlot: "reference",
        candidateSlot: "candidate",
        referenceTargetKind: referenceKind,
        candidateTargetKind: candidateKind,
        referenceObservation: refObs,
        candidateObservation: candObs,
        referenceRawDigest: sha256OfCanonicalJson(refRaw as never),
        candidateRawDigest: sha256OfCanonicalJson(candRaw as never),
        policy,
        registry: knownDivergences,
        now: new Date(),
      }),
    );
  }

  if (args.flags.out) {
    const bundleTargets: BundleTargetRun[] = [
      {
        slot: "reference",
        role: "reference",
        targetSpec: a.targetRecipe as never,
        identity: a.identity,
        capabilities: [],
        events: [],
        rawObservations: new Map([...a.finalRawByStep].map(([k, v]) => [`${k}:1`, v])),
        semanticObservations: new Map([...a.finalSemanticByStep].map(([k, v]) => [`${k}:1`, v])),
      },
      {
        slot: "candidate",
        role: "candidate",
        targetSpec: b.targetRecipe as never,
        identity: b.identity,
        capabilities: [],
        events: [],
        rawObservations: new Map([...b.finalRawByStep].map(([k, v]) => [`${k}:1`, v])),
        semanticObservations: new Map([...b.finalSemanticByStep].map(([k, v]) => [`${k}:1`, v])),
      },
    ];
    const bundle = buildBundle({
      scenario: a.scenario,
      policy,
      knownDivergences,
      targets: bundleTargets,
      comparisonResults: results,
      divergenceSignatures: buildDivergenceSignatures(
        a.scenario,
        results,
        referenceKind,
        candidateKind,
      ),
      toolchain: { name: "supadiff", version: "0.1.0", node: process.version },
      recoverySummary: { leaks: [] },
      configuredSecretLiterals: [],
      createdAt: new Date().toISOString(),
    });
    if (!bundle.secretScanPassed) {
      process.stderr.write(
        "supadiff compare: secret scan failed on the assembled bundle; refusing to write it\n",
      );
      return EXIT_INCONCLUSIVE;
    }
    await writeBundleDirectory(bundle.files, path.resolve(args.flags.out));
  }

  return emit(args, results, args.flags.out);
}

function emit(
  args: ParsedArgs,
  results: ComparisonResult[],
  artifactPath: string | undefined,
): number {
  const failOn = args.flags.failOn.length > 0 ? args.flags.failOn : DEFAULT_FAIL_ON;
  const hasInconclusive = results.some((r) => r.outcome === "inconclusive");
  const hasNew = results.some((r) => r.outcome === "new-divergence");
  const hasKnown = results.some((r) => r.outcome === "known-divergence");

  let exitCode = EXIT_OK;
  if (failOn.includes("inconclusive") && hasInconclusive)
    exitCode = Math.max(exitCode, EXIT_INCONCLUSIVE);
  if (failOn.includes("new") && hasNew)
    exitCode = Math.max(exitCode, EXIT_BEHAVIORAL_POLICY_VIOLATION);
  if (failOn.includes("known") && hasKnown)
    exitCode = Math.max(exitCode, EXIT_BEHAVIORAL_POLICY_VIOLATION);

  const outcomeCounts: Record<string, number> = {};
  for (const r of results) outcomeCounts[r.outcome] = (outcomeCounts[r.outcome] ?? 0) + 1;

  const cliResult: CliResult = {
    format: "supadiff.cli-result",
    formatVersion: "1",
    command: "compare",
    ok: exitCode === EXIT_OK,
    state: "compared",
    exitCode,
    summary: `offline compare: ${results.length} result(s)`,
    outcomeCounts,
    ...(artifactPath ? { artifactPath } : {}),
  };
  renderResult(args.flags.output, cliResult);
  return exitCode;
}
