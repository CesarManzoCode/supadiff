import { describe, expect, it } from "vitest";
import { parseArgs, runCommand } from "../src/index.js";
import { writeCliFixtures, freshOutDir } from "./fixtures.js";
import { captureStreams } from "./helpers.js";
import { EXIT_OK, EXIT_INVALID } from "../src/exit-codes.js";
import { readBundleDirectory } from "../src/artifact-io.js";

describe("supadiff run", () => {
  it("runs the L5 acceptance scenario end to end and exits 0 on a clean match", async () => {
    const fx = await writeCliFixtures();
    const out = await freshOutDir();
    const args = parseArgs([
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
    ]);
    const capture = captureStreams();
    const exitCode = await runCommand(args);
    capture.restore();

    expect(exitCode).toBe(EXIT_OK);
    expect(capture.stdout).toHaveLength(1); // exactly one JSON document, no banners/progress
    const result = JSON.parse(capture.stdout[0]!);
    expect(result.format).toBe("supadiff.cli-result");
    expect(result.ok).toBe(true);
    expect(result.outcomeCounts["match-exact"]).toBeGreaterThan(0);

    const files = await readBundleDirectory(out);
    expect(files.has("manifest.json")).toBe(true);
    expect(files.has("comparison/results.json")).toBe(true);
  });

  it("exits 10 when --fail-on new is violated by a real divergence", async () => {
    const fx = await writeCliFixtures();
    const out = await freshOutDir();
    const args = parseArgs([
      "run",
      fx.scenarioPath,
      "--target",
      fx.referencePath,
      "--target",
      fx.mismatchPath,
      "--policy",
      fx.policyPath,
      "--output",
      "json",
      "--out",
      out,
      "--fail-on",
      "new",
    ]);
    const capture = captureStreams();
    const exitCode = await runCommand(args);
    capture.restore();
    expect(exitCode).toBe(10);
    const result = JSON.parse(capture.stdout[0]!);
    expect(result.outcomeCounts["new-divergence"]).toBeGreaterThan(0);
  });

  it("exits 0 for the same divergence when --fail-on does not include 'new'", async () => {
    const fx = await writeCliFixtures();
    const out = await freshOutDir();
    const args = parseArgs([
      "run",
      fx.scenarioPath,
      "--target",
      fx.referencePath,
      "--target",
      fx.mismatchPath,
      "--policy",
      fx.policyPath,
      "--output",
      "json",
      "--out",
      out,
      "--fail-on",
      "inconclusive",
    ]);
    const exitCode = await runCommand(args);
    expect(exitCode).toBe(EXIT_OK);
  });

  it("exits 30 (invalid) for a malformed scenario file", async () => {
    const fx = await writeCliFixtures();
    const args = parseArgs([
      "run",
      "/nonexistent/scenario.json",
      "--target",
      fx.referencePath,
      "--output",
      "json",
    ]);
    const capture = captureStreams();
    const exitCode = await runCommand(args);
    capture.restore();
    expect(exitCode).toBe(EXIT_INVALID);
    expect(capture.stdout).toHaveLength(0); // failure goes to stderr, not stdout
    expect(capture.stderr.length).toBeGreaterThan(0);
  });

  it("exits 30 when no --target is supplied", async () => {
    const fx = await writeCliFixtures();
    const args = parseArgs(["run", fx.scenarioPath, "--output", "json"]);
    const exitCode = await runCommand(args);
    expect(exitCode).toBe(EXIT_INVALID);
  });

  it("fails closed (30) before provisioning any target when a multi-target run omits --policy (§8B: no silent empty-rules policy)", async () => {
    const fx = await writeCliFixtures();
    const out = await freshOutDir();
    const args = parseArgs([
      "run",
      fx.scenarioPath,
      "--target",
      fx.referencePath,
      "--target",
      fx.matchPath,
      "--output",
      "json",
      "--out",
      out,
    ]);
    const capture = captureStreams();
    const exitCode = await runCommand(args);
    capture.restore();
    expect(exitCode).toBe(EXIT_INVALID);
    expect(capture.stderr.join("")).toMatch(/comparison policy/);
    // No artifact should have been written — provisioning never started.
    expect(await readBundleDirectory(out).catch(() => undefined)).toBeUndefined();
  });

  it("does not require --policy for a single-target run (no comparison is performed)", async () => {
    const fx = await writeCliFixtures();
    const out = await freshOutDir();
    const args = parseArgs([
      "run",
      fx.scenarioPath,
      "--target",
      fx.referencePath,
      "--output",
      "json",
      "--out",
      out,
    ]);
    const exitCode = await runCommand(args);
    expect(exitCode).toBe(EXIT_OK);
  });

  it("produces byte-identical bundle payload files across two separate invocations", async () => {
    const fx = await writeCliFixtures();
    const out1 = await freshOutDir();
    const out2 = await freshOutDir();
    const run = (out: string) =>
      runCommand(
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
    await run(out1);
    await run(out2);
    const files1 = await readBundleDirectory(out1);
    const files2 = await readBundleDirectory(out2);
    for (const [path, buf] of files1) {
      if (
        path === "manifest.json" ||
        path === "checksums.sha256" ||
        path === "provenance/secret-scan.json"
      )
        continue;
      expect(buf.equals(files2.get(path)!)).toBe(true);
    }
  });
});

describe("NDJSON output stream", () => {
  it("emits event objects in sequence order followed by exactly one terminal result", async () => {
    const fx = await writeCliFixtures();
    const out = await freshOutDir();
    const args = parseArgs([
      "run",
      fx.scenarioPath,
      "--target",
      fx.referencePath,
      "--target",
      fx.matchPath,
      "--policy",
      fx.policyPath,
      "--output",
      "ndjson",
      "--out",
      out,
    ]);
    const capture = captureStreams();
    await runCommand(args);
    capture.restore();

    const lines = capture.stdout.map((l) => JSON.parse(l));
    const terminal = lines.at(-1);
    expect(terminal.format).toBe("supadiff.cli-result");
    const events = lines.slice(0, -1);
    expect(events.length).toBeGreaterThan(0);
    const refEvents = events.filter((e) => e.targetRole === "reference");
    const seqs = refEvents.map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
  });
});

describe("human vs machine stream separation", () => {
  it("keeps human stdout to a concise summary and progress on stderr", async () => {
    const fx = await writeCliFixtures();
    const out = await freshOutDir();
    const args = parseArgs([
      "run",
      fx.scenarioPath,
      "--target",
      fx.referencePath,
      "--target",
      fx.matchPath,
      "--policy",
      fx.policyPath,
      "--output",
      "human",
      "--out",
      out,
    ]);
    const capture = captureStreams();
    await runCommand(args);
    capture.restore();
    expect(capture.stdout.join("")).not.toContain("{"); // no JSON leaking into human stdout
    expect(capture.stderr.length).toBeGreaterThan(0); // progress went to stderr
  });
});
