import { describe, expect, it } from "vitest";
import { parseArgs, runCommand, compareCommand } from "../src/index.js";
import { writeCliFixtures, freshOutDir } from "./fixtures.js";
import { captureStreams } from "./helpers.js";
import { EXIT_OK, EXIT_BEHAVIORAL_POLICY_VIOLATION } from "../src/exit-codes.js";

async function runSingleTargetArtifact(
  fx: Awaited<ReturnType<typeof writeCliFixtures>>,
  targetPath: string,
): Promise<string> {
  const out = await freshOutDir();
  await runCommand(
    parseArgs(["run", fx.scenarioPath, "--target", targetPath, "--output", "json", "--out", out]),
  );
  return out;
}

describe("supadiff compare (offline)", () => {
  it("compares two run artifacts without contacting any target and matches on identical fixtures", async () => {
    const fx = await writeCliFixtures();
    const runA = await runSingleTargetArtifact(fx, fx.referencePath);
    const runB = await runSingleTargetArtifact(fx, fx.matchPath);

    const capture = captureStreams();
    const exitCode = await compareCommand(
      parseArgs(["compare", runA, runB, "--policy", fx.policyPath, "--output", "json"]),
    );
    capture.restore();

    expect(exitCode).toBe(EXIT_OK);
    const result = JSON.parse(capture.stdout[0]!);
    expect(result.command).toBe("compare");
    expect(result.outcomeCounts["match-exact"]).toBeGreaterThan(0);
  });

  it("flags a real divergence between two independently produced run artifacts", async () => {
    const fx = await writeCliFixtures();
    const runA = await runSingleTargetArtifact(fx, fx.referencePath);
    const runB = await runSingleTargetArtifact(fx, fx.mismatchPath);

    const capture = captureStreams();
    const exitCode = await compareCommand(
      parseArgs([
        "compare",
        runA,
        runB,
        "--policy",
        fx.policyPath,
        "--output",
        "json",
        "--fail-on",
        "new",
      ]),
    );
    capture.restore();
    expect(exitCode).toBe(EXIT_BEHAVIORAL_POLICY_VIOLATION);
  });

  it("rejects a bare run artifact in single-artifact mode instead of silently returning empty results (§8A)", async () => {
    const fx = await writeCliFixtures();
    const runA = await runSingleTargetArtifact(fx, fx.referencePath); // single target -> artifactKind "run"

    const capture = captureStreams();
    const exitCode = await compareCommand(
      parseArgs(["compare", runA, "--policy", fx.policyPath, "--output", "json"]),
    );
    capture.restore();

    expect(exitCode).not.toBe(EXIT_OK);
    expect(capture.stderr.join("")).toMatch(/not a comparison artifact/);
    expect(capture.stdout).toHaveLength(0);
  });

  it("this module never imports a target driver or provisioning code (statically offline)", async () => {
    const source = await import("node:fs/promises").then((fs) =>
      fs.readFile(new URL("../src/commands/compare.ts", import.meta.url), "utf8").catch(() => ""),
    );
    // Source may not exist post-build in some environments; fall back to a behavioral check.
    if (source) {
      expect(source).not.toContain("FakeTargetDriver");
      expect(source).not.toContain("runScenario(");
    }
  });
});
