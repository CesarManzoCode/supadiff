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
  type RawObservation,
  type TargetSpec,
} from "@supadiff/spec";
import type { ParsedArgs } from "../config/parse-args.js";
import {
  CliInputError,
  loadKnownDivergences,
  loadPolicy,
  loadScenario,
  loadTarget,
} from "../load-inputs.js";
import { buildFakeDriverFromTargets } from "../fake-driver-wiring.js";
import { writeBundleDirectory } from "../artifact-io.js";
import { renderResult, progress, type CliResult } from "../output/render.js";
import {
  DEFAULT_FAIL_ON,
  EXIT_INCONCLUSIVE,
  EXIT_INVALID,
  EXIT_OK,
  EXIT_BEHAVIORAL_POLICY_VIOLATION,
} from "../exit-codes.js";

function finalSemanticObservationsFor(
  target: BundleTargetRun,
): Map<
  string,
  typeof target.semanticObservations extends ReadonlyMap<string, infer V> ? V : never
> {
  const byStep = new Map<string, string>(); // stepId -> best key
  for (const key of target.semanticObservations.keys()) {
    const [stepId, attemptStr] = key.split(":");
    const attempt = Number(attemptStr);
    const currentKey = byStep.get(stepId!);
    const currentAttempt = currentKey ? Number(currentKey.split(":")[1]) : -1;
    if (attempt >= currentAttempt) byStep.set(stepId!, key);
  }
  const out = new Map();
  for (const [stepId, key] of byStep) out.set(stepId, target.semanticObservations.get(key)!);
  return out;
}

function latestRawObservationFor(
  target: BundleTargetRun,
  stepId: string,
): RawObservation | undefined {
  let best: [number, RawObservation] | undefined;
  for (const [key, raw] of target.rawObservations) {
    if (!key.startsWith(`${stepId}:`)) continue;
    const attempt = Number(key.split(":")[1]);
    if (!best || attempt > best[0]) best = [attempt, raw];
  }
  return best?.[1];
}

export async function runCommand(args: ParsedArgs): Promise<number> {
  const scenarioPath = args.positionals[0];
  if (!scenarioPath) {
    process.stderr.write("supadiff run: missing <scenario.json>\n");
    return EXIT_INVALID;
  }
  if (args.targets.length === 0) {
    process.stderr.write("supadiff run: at least one --target is required\n");
    return EXIT_INVALID;
  }

  let scenario;
  let targetSpecs: TargetSpec[];
  try {
    scenario = await loadScenario(scenarioPath);
    targetSpecs = await Promise.all(args.targets.map((t) => loadTarget(t)));
  } catch (err) {
    if (err instanceof CliInputError) {
      process.stderr.write(`${err.message}\n`);
      return EXIT_INVALID;
    }
    throw err;
  }

  const referenceSpec = args.flags.reference
    ? targetSpecs.find((t) => t.id === args.flags.reference)
    : targetSpecs[0];
  if (!referenceSpec) {
    process.stderr.write(
      `supadiff run: --reference "${args.flags.reference}" does not match any --target id\n`,
    );
    return EXIT_INVALID;
  }
  const candidateSpecs = targetSpecs.filter((t) => t.id !== referenceSpec.id);

  let policy;
  let knownDivergences;
  try {
    // The comparison policy MUST be resolved and validated against a multi-target run's
    // declared scenario.comparison before any target is provisioned (§8B): never provision
    // first and discover there is no usable policy afterward.
    policy = await loadPolicy(args.flags.policy, scenario, {
      required: candidateSpecs.length > 0,
    });
    knownDivergences = await loadKnownDivergences(args.flags.divergences);
  } catch (err) {
    if (err instanceof CliInputError) {
      process.stderr.write(`${err.message}\n`);
      return EXIT_INVALID;
    }
    throw err;
  }

  const driver = buildFakeDriverFromTargets(targetSpecs);
  const handles: TargetHandle[] = targetSpecs.map((spec) => ({ slot: spec.id, spec, driver }));

  progress(args.flags.output, args.flags.quiet, `provisioning ${handles.length} target(s)...`);
  const result = await runScenario(scenario, handles);
  progress(args.flags.output, args.flags.quiet, `run finished with state "${result.state}"`);

  const bundleTargets: BundleTargetRun[] = targetSpecs.map((spec) => {
    const t = result.targets.get(spec.id)!;
    return {
      slot: spec.id,
      role: spec.id === referenceSpec.id ? "reference" : "candidate",
      targetSpec: spec,
      identity: t.identity,
      capabilities: t.probedCapabilities.length > 0 ? t.probedCapabilities : t.declaredCapabilities,
      events: t.events,
      rawObservations: t.rawObservations,
      semanticObservations: t.semanticObservations,
    };
  });

  const anyRedactionFailure = [...result.targets.values()].some(
    (t) => t.redactionFailures.length > 0,
  );
  if (anyRedactionFailure) {
    process.stderr.write(
      "supadiff run: secret redaction failed for at least one observation; refusing to write an artifact\n",
    );
    return EXIT_INCONCLUSIVE;
  }

  const scenarioDigest = computeScenarioDigest(scenario);
  const comparisonResults: ComparisonResult[] = [];
  if (candidateSpecs.length > 0) {
    const referenceTarget = bundleTargets.find((t) => t.role === "reference")!;
    const referenceSemantics = finalSemanticObservationsFor(referenceTarget);
    for (const candidateSpec of candidateSpecs) {
      const candidateTarget = bundleTargets.find((t) => t.slot === candidateSpec.id)!;
      const candidateSemantics = finalSemanticObservationsFor(candidateTarget);
      for (const step of scenario.steps) {
        const refObs = referenceSemantics.get(step.id);
        const candObs = candidateSemantics.get(step.id);
        if (!refObs || !candObs) continue;
        const refRaw = latestRawObservationFor(referenceTarget, step.id);
        const candRaw = latestRawObservationFor(candidateTarget, step.id);
        if (!refRaw || !candRaw) continue;
        comparisonResults.push(
          ...compareStep({
            scenarioId: scenario.id,
            scenarioDigest,
            stepId: step.id,
            referenceSlot: referenceTarget.slot,
            candidateSlot: candidateTarget.slot,
            referenceTargetKind: referenceSpec.kind,
            candidateTargetKind: candidateSpec.kind,
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
    }
  }

  const divergenceSignatures =
    candidateSpecs.length > 0
      ? buildDivergenceSignatures(
          scenario,
          comparisonResults,
          referenceSpec.kind,
          candidateSpecs[0]!.kind,
        )
      : [];

  const bundle = buildBundle({
    scenario,
    policy,
    knownDivergences,
    targets: bundleTargets,
    comparisonResults,
    divergenceSignatures,
    toolchain: { name: "supadiff", version: "0.1.0", node: process.version },
    recoverySummary: { leaks: [...result.targets.values()].flatMap((t) => t.recoveryLeaks) },
    configuredSecretLiterals: [],
    createdAt: new Date().toISOString(),
  });

  if (!bundle.secretScanPassed) {
    process.stderr.write(
      `supadiff run: artifact secret scan found ${bundle.findings.length} unexplained hit(s); refusing to write a successful artifact\n`,
    );
    return EXIT_INCONCLUSIVE;
  }

  const outDir =
    args.flags.out ?? path.join(process.cwd(), "supadiff-artifacts", `${result.runId}.supadiff`);
  await writeBundleDirectory(bundle.files, outDir);

  const outcomeCounts: Record<string, number> = {};
  for (const r of comparisonResults) outcomeCounts[r.outcome] = (outcomeCounts[r.outcome] ?? 0) + 1;

  const failOn = args.flags.failOn.length > 0 ? args.flags.failOn : DEFAULT_FAIL_ON;
  const hasInconclusive = comparisonResults.some((r) => r.outcome === "inconclusive");
  const hasCleanupLeak = result.state === "inconclusive-cleanup";
  const hasNew = comparisonResults.some((r) => r.outcome === "new-divergence");
  const hasKnown = comparisonResults.some((r) => r.outcome === "known-divergence");
  const hasUnsupported = result.state === "unsupported";

  let exitCode = EXIT_OK;
  if (result.state === "invalid") exitCode = EXIT_INVALID;
  else {
    if (failOn.includes("inconclusive") && (hasInconclusive || result.state === "inconclusive"))
      exitCode = Math.max(exitCode, EXIT_INCONCLUSIVE);
    if (failOn.includes("cleanup") && hasCleanupLeak)
      exitCode = Math.max(exitCode, EXIT_INCONCLUSIVE);
    if (failOn.includes("new") && hasNew)
      exitCode = Math.max(exitCode, EXIT_BEHAVIORAL_POLICY_VIOLATION);
    if (failOn.includes("known") && hasKnown)
      exitCode = Math.max(exitCode, EXIT_BEHAVIORAL_POLICY_VIOLATION);
    if (failOn.includes("unsupported") && hasUnsupported)
      exitCode = Math.max(exitCode, EXIT_BEHAVIORAL_POLICY_VIOLATION);
  }

  const cliResult: CliResult = {
    format: "supadiff.cli-result",
    formatVersion: "1",
    command: "run",
    ok: exitCode === EXIT_OK,
    state: result.state,
    exitCode,
    artifactPath: outDir,
    summary: `run ${result.runId}: ${result.state}, ${comparisonResults.length} comparison result(s)`,
    outcomeCounts,
  };
  const ndjsonEvents =
    args.flags.output === "ndjson"
      ? bundleTargets
          .flatMap((t) => t.events.map((e) => ({ ...e, targetRole: t.role })))
          .sort((a, b) => a.seq - b.seq)
      : [];
  renderResult(args.flags.output, cliResult, ndjsonEvents);
  return exitCode;
}
