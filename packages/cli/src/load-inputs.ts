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

export async function loadPolicy(
  filePath: string | undefined,
  scenario: ScenarioSpec,
): Promise<ComparisonPolicy> {
  if (!filePath) {
    return {
      format: "supadiff.comparison-policy",
      formatVersion: "1.0",
      policyId: scenario.comparison.policyId,
      policyVersion: scenario.comparison.policyVersion,
      rules: [],
    };
  }
  const data = await readJson(filePath);
  try {
    return parseComparisonPolicy(data as never);
  } catch (err) {
    if (err instanceof SpecValidationError)
      throw new CliInputError(`invalid comparison policy "${filePath}": ${err.message}`);
    throw err;
  }
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
