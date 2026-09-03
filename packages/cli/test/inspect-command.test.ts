import { describe, expect, it } from "vitest";
import { parseArgs, runCommand, inspectCommand } from "../src/index.js";
import { writeCliFixtures, freshOutDir } from "./fixtures.js";
import { captureStreams } from "./helpers.js";
import { EXIT_OK, EXIT_INVALID } from "../src/exit-codes.js";

describe("supadiff inspect", () => {
  it("inspects a scenario file read-only", async () => {
    const fx = await writeCliFixtures();
    const capture = captureStreams();
    const exitCode = await inspectCommand(
      parseArgs(["inspect", "scenario", fx.scenarioPath, "--output", "json"]),
    );
    capture.restore();
    expect(exitCode).toBe(EXIT_OK);
    const result = JSON.parse(capture.stdout[0]!);
    expect(result.scenario.id).toBe("scn.cli-test");
  });

  it("inspects a target spec file read-only", async () => {
    const fx = await writeCliFixtures();
    const exitCode = await inspectCommand(
      parseArgs(["inspect", "target", fx.referencePath, "--output", "json"]),
    );
    expect(exitCode).toBe(EXIT_OK);
  });

  it("inspects a produced artifact directory and verifies checksums", async () => {
    const fx = await writeCliFixtures();
    const out = await freshOutDir();
    await runCommand(
      parseArgs([
        "run",
        fx.scenarioPath,
        "--target",
        fx.referencePath,
        "--target",
        fx.matchPath,
        "--policy",
        fx.policyPath,
        "--output",
        "json",
        "--out",
        out,
      ]),
    );
    const capture = captureStreams();
    const exitCode = await inspectCommand(
      parseArgs(["inspect", "artifact", out, "--output", "json"]),
    );
    capture.restore();
    expect(exitCode).toBe(EXIT_OK);
    const result = JSON.parse(capture.stdout[0]!);
    expect(result.checksums.ok).toBe(true);
  });

  it("detects checksum corruption in a tampered artifact", async () => {
    const fx = await writeCliFixtures();
    const out = await freshOutDir();
    await runCommand(
      parseArgs([
        "run",
        fx.scenarioPath,
        "--target",
        fx.referencePath,
        "--target",
        fx.matchPath,
        "--policy",
        fx.policyPath,
        "--output",
        "json",
        "--out",
        out,
      ]),
    );
    const { writeFile } = await import("node:fs/promises");
    await writeFile(`${out}/comparison/results.json`, "[]"); // tamper with a payload file after the fact

    const capture = captureStreams();
    await inspectCommand(parseArgs(["inspect", "artifact", out, "--output", "json"]));
    capture.restore();
    const result = JSON.parse(capture.stdout[0]!);
    expect(result.checksums.ok).toBe(false);
    expect(result.checksums.mismatched).toContain("comparison/results.json");
  });

  it("lists known divergences without mutating any target", async () => {
    const exitCode = await inspectCommand(
      parseArgs(["inspect", "divergences", "/nonexistent/dir", "--output", "json"]),
    );
    expect(exitCode).toBe(EXIT_OK); // an absent directory is treated as an empty registry, not an error
  });

  it("returns an invalid exit code for an unknown inspect subject", async () => {
    const exitCode = await inspectCommand(parseArgs(["inspect", "wat", "--output", "json"]));
    expect(exitCode).toBe(EXIT_INVALID);
  });
});
