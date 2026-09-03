import { readFile } from "node:fs/promises";
import type { ParsedArgs } from "../config/parse-args.js";
import { CliInputError, loadKnownDivergences, loadScenario, loadTarget } from "../load-inputs.js";
import { readRunArtifact } from "../bundle-read.js";
import { verifyChecksums } from "../verify-checksums.js";
import { renderResult, type CliResult } from "../output/render.js";
import { EXIT_INVALID, EXIT_OK } from "../exit-codes.js";

/**
 * `supadiff inspect` performs no target mutation (§14.1). It only reads local files:
 * a scenario, an artifact directory, a target spec, or the known-divergence registry.
 */
export async function inspectCommand(args: ParsedArgs): Promise<number> {
  const [subject, target] = args.positionals;
  if (!subject) {
    process.stderr.write(
      "supadiff inspect: expected one of scenario|artifact|target|capabilities|divergences|recovery\n",
    );
    return EXIT_INVALID;
  }

  try {
    let detail: Record<string, unknown>;
    let summary: string;

    switch (subject) {
      case "scenario": {
        if (!target) throw new CliInputError("inspect scenario: missing <path>");
        const scenario = await loadScenario(target);
        detail = { scenario };
        summary = `scenario "${scenario.id}" rev "${scenario.revision}": ${scenario.steps.length} step(s), ${scenario.actors.length} actor(s)`;
        break;
      }
      case "target": {
        if (!target) throw new CliInputError("inspect target: missing <path>");
        const spec = await loadTarget(target);
        detail = { target: spec };
        summary = `target "${spec.id}" kind "${spec.kind}"`;
        break;
      }
      case "artifact": {
        if (!target) throw new CliInputError("inspect artifact: missing <path>");
        const artifact = await readRunArtifact(target);
        const checksums = verifyChecksums(artifact.files);
        detail = { manifest: artifact.manifest, scenarioId: artifact.scenario.id, checksums };
        summary = `artifact "${artifact.manifest.artifactId}" kind "${artifact.manifest.artifactKind}", ${artifact.files.size} file(s), checksums ${checksums.ok ? "OK" : "CORRUPT"}`;
        break;
      }
      case "capabilities": {
        if (!target) throw new CliInputError("inspect capabilities: missing <artifact path>");
        const buf = await readFile(`${target}/targets/capabilities.json`, "utf8");
        detail = { capabilities: JSON.parse(buf) };
        summary = `capabilities read from "${target}"`;
        break;
      }
      case "divergences": {
        const entries = await loadKnownDivergences(target);
        detail = { divergences: entries };
        summary = `${entries.length} known-divergence entr${entries.length === 1 ? "y" : "ies"}`;
        break;
      }
      case "recovery": {
        if (!target) throw new CliInputError("inspect recovery: missing <artifact path>");
        const buf = await readFile(`${target}/provenance/recovery-summary.json`, "utf8");
        detail = { recovery: JSON.parse(buf) };
        summary = `recovery summary read from "${target}"`;
        break;
      }
      default:
        process.stderr.write(`supadiff inspect: unknown subject "${subject}"\n`);
        return EXIT_INVALID;
    }

    const cliResult: CliResult = {
      format: "supadiff.cli-result",
      formatVersion: "1",
      command: "inspect",
      ok: true,
      state: "inspected",
      exitCode: EXIT_OK,
      summary,
      outcomeCounts: {},
      ...detail,
    };
    renderResult(args.flags.output, cliResult);
    return EXIT_OK;
  } catch (err) {
    if (err instanceof CliInputError) {
      process.stderr.write(`${err.message}\n`);
      return EXIT_INVALID;
    }
    throw err;
  }
}
