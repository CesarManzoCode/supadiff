import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { reduceArtifact, type ReductionContext } from "@supadiff/reducer";
import { canonicalizeJson, type DivergenceSignature } from "@supadiff/spec";
import type { ParsedArgs } from "../config/parse-args.js";
import { readRunArtifact } from "../bundle-read.js";
import { loadKnownDivergences, loadPolicy } from "../load-inputs.js";
import { buildDriverForSpec } from "../driver-registry.js";
import { candidateRecipes, recipeToTargetSpec, type SanitizedRecipeJson } from "../recipe.js";
import { verifyChecksums } from "../verify-checksums.js";
import { renderResult, type CliResult } from "../output/render.js";
import { EXIT_INCONCLUSIVE, EXIT_INVALID, EXIT_OK } from "../exit-codes.js";

/**
 * `supadiff reduce <artifact>` (§11, §14.1): requires a reproducible divergence artifact,
 * refuses flaky ones (three fresh-target replays must all reproduce), then applies
 * dependency-safe deterministic reduction passes and writes a smaller reproduction with
 * the exact same divergence signature.
 */
export async function reduceCommand(args: ParsedArgs): Promise<number> {
  const [artifactPath] = args.positionals;
  if (!artifactPath) {
    process.stderr.write("supadiff reduce: missing <artifact.supadiff>\n");
    return EXIT_INVALID;
  }

  const artifact = await readRunArtifact(artifactPath);
  const checks = verifyChecksums(artifact.files);
  if (!checks.ok) {
    process.stderr.write(
      `supadiff reduce: checksum validation failed — missing: [${checks.missing.join(", ")}], ` +
        `mismatched: [${checks.mismatched.join(", ")}]\n`,
    );
    return EXIT_INVALID;
  }
  if (artifact.manifest.artifactKind !== "comparison") {
    process.stderr.write(
      `supadiff reduce: "${artifactPath}" is a "${artifact.manifest.artifactKind}" artifact, not a ` +
        `comparison artifact — there is no recorded divergence to reduce\n`,
    );
    return EXIT_INVALID;
  }

  const signaturesBuf = artifact.files.get("comparison/divergence-signature.json");
  const recordedSignatures = signaturesBuf
    ? (JSON.parse(signaturesBuf.toString("utf8")) as DivergenceSignature[])
    : [];
  if (recordedSignatures.length === 0) {
    process.stderr.write(
      `supadiff reduce: "${artifactPath}" recorded no divergence signature — nothing to reduce\n`,
    );
    return EXIT_INVALID;
  }
  const expectedSignature = recordedSignatures[0]!;

  const referenceSpec = recipeToTargetSpec(artifact.targetRecipe as unknown as SanitizedRecipeJson);
  const [candidateSpec] = candidateRecipes(artifact.files);
  if (!candidateSpec) {
    process.stderr.write(`supadiff reduce: "${artifactPath}" has no candidate target recipe\n`);
    return EXIT_INVALID;
  }

  const policy = await loadPolicy(args.flags.policy, artifact.scenario, { required: true });
  const knownDivergences = await loadKnownDivergences(args.flags.divergences);

  const ctx: ReductionContext = {
    referenceSpec,
    candidateSpec,
    buildDriver: (spec, resources) => buildDriverForSpec(spec, resources),
    policy,
    knownDivergences,
    expectedSignature,
    toolchainId: "supadiff@0.1.0",
  };

  const result = await reduceArtifact(artifact.scenario, expectedSignature.stepId, ctx);

  let artifactOutPath: string | undefined;
  if (result.minimality !== "inconclusive-flaky") {
    artifactOutPath =
      args.flags.out ??
      path.join(process.cwd(), "supadiff-artifacts", `${artifact.scenario.id}.reduced`);
    await mkdir(artifactOutPath, { recursive: true });
    await writeFile(
      path.join(artifactOutPath, "reduced-scenario.json"),
      canonicalizeJson(result.reduced as never),
    );
    await writeFile(
      path.join(artifactOutPath, "reduction-report.json"),
      canonicalizeJson({
        minimality: result.minimality,
        originalStepCount: result.originalStepCount,
        reducedStepCount: result.reducedStepCount,
        candidateExecutions: result.candidateExecutions,
        cacheHits: result.cacheHits,
        flakeReplayCount: result.flakeReplayCount,
        expectedSignature,
      } as never),
    );
  }

  const cliResult: CliResult = {
    format: "supadiff.cli-result",
    formatVersion: "1",
    command: "reduce",
    ok: result.minimality !== "inconclusive-flaky",
    state: result.minimality,
    exitCode: result.minimality === "inconclusive-flaky" ? EXIT_INCONCLUSIVE : EXIT_OK,
    ...(artifactOutPath ? { artifactPath: artifactOutPath } : {}),
    summary:
      result.minimality === "inconclusive-flaky"
        ? `divergence did not reproduce 3/3 fresh replays — refusing to reduce (flaky)`
        : `reduced ${result.originalStepCount} step(s) to ${result.reducedStepCount} ` +
          `(${result.minimality}, ${result.candidateExecutions} candidate execution(s))`,
    outcomeCounts: {},
  };
  renderResult(args.flags.output, cliResult);
  return cliResult.exitCode;
}
