import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import {
  parseComparisonPolicy,
  parseKnownDivergence,
  parseScenarioSpec,
  parseTargetSpec,
  SpecValidationError,
  type ComparisonPolicy,
  type KnownDivergence,
  type ScenarioSpec,
  type TargetSpec,
} from "@supadiff/spec";
import { pathExists } from "./artifact-io.js";

export class CliInputError extends Error {}

async function readJson(filePath: string): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(filePath, "utf8");
  } catch (err) {
    throw new CliInputError(`cannot read "${filePath}": ${(err as Error).message}`);
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new CliInputError(`"${filePath}" is not valid JSON: ${(err as Error).message}`);
  }
}

export async function loadScenario(filePath: string): Promise<ScenarioSpec> {
  const data = await readJson(filePath);
  try {
    return parseScenarioSpec(data as never);
  } catch (err) {
    if (err instanceof SpecValidationError)
      throw new CliInputError(`invalid scenario "${filePath}": ${err.message}`);
    throw err;
  }
}

export async function loadTarget(filePath: string): Promise<TargetSpec> {
  const data = await readJson(filePath);
  try {
    return parseTargetSpec(data as never);
  } catch (err) {
    if (err instanceof SpecValidationError)
      throw new CliInputError(`invalid target "${filePath}": ${err.message}`);
    throw err;
  }
}

/**
 * Resolves the comparison policy referenced by `scenario.comparison`. There is no
 * silent-default empty-rules policy (§14.1, §7.2): when the CLI cannot resolve the
 * exact policy the scenario declares, it fails closed with `CliInputError` rather than
 * proceeding with zero rules. When `--policy` is required (a comparison will actually be
 * performed) and omitted, this throws before any target is provisioned. When `--policy`
 * is supplied, its `policyId`/`policyVersion` MUST agree with `scenario.comparison` — a
 * mismatch is also a fail-closed configuration error, never a silently accepted override.
 */
export async function loadPolicy(
  filePath: string | undefined,
  scenario: ScenarioSpec,
  opts: { required: boolean } = { required: true },
): Promise<ComparisonPolicy> {
  if (!filePath) {
    if (opts.required) {
      throw new CliInputError(
        `supadiff: scenario "${scenario.id}" declares comparison policy ` +
          `"${scenario.comparison.policyId}@${scenario.comparison.policyVersion}" but no --policy was ` +
          `given; refusing to provision targets with an unresolved comparison policy`,
      );
    }
    return {
      format: "supadiff.comparison-policy",
      formatVersion: "1.0",
      policyId: scenario.comparison.policyId,
      policyVersion: scenario.comparison.policyVersion,
      rules: [],
    };
  }
  const data = await readJson(filePath);
  let policy: ComparisonPolicy;
  try {
    policy = parseComparisonPolicy(data as never);
  } catch (err) {
    if (err instanceof SpecValidationError)
      throw new CliInputError(`invalid comparison policy "${filePath}": ${err.message}`);
    throw err;
  }
  if (
    policy.policyId !== scenario.comparison.policyId ||
    policy.policyVersion !== scenario.comparison.policyVersion
  ) {
    throw new CliInputError(
      `supadiff: --policy "${filePath}" resolves to policy ` +
        `"${policy.policyId}@${policy.policyVersion}", but scenario "${scenario.id}" declares ` +
        `"${scenario.comparison.policyId}@${scenario.comparison.policyVersion}"; refusing to run ` +
        `with a policy the scenario does not agree with`,
    );
  }
  return policy;
}

export async function loadKnownDivergences(dir: string | undefined): Promise<KnownDivergence[]> {
  const resolvedDir = dir ?? path.join(process.cwd(), "divergences", "active");
  if (!(await pathExists(resolvedDir))) return [];
  const entries = await readdir(resolvedDir);
  const results: KnownDivergence[] = [];
  for (const entry of entries.filter((e) => e.endsWith(".json")).sort()) {
    const data = await readJson(path.join(resolvedDir, entry));
    try {
      results.push(parseKnownDivergence(data as never));
    } catch (err) {
      if (err instanceof SpecValidationError) {
        throw new CliInputError(`invalid known-divergence entry "${entry}": ${err.message}`);
      }
      throw err;
    }
  }
  return results;
}
