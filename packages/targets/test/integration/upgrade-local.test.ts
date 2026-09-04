import { describe, expect, it } from "vitest";
import { spawnManaged } from "../../src/shared/process.js";
import { verifyUpgrade } from "../../src/index.js";

/**
 * L8 acceptance (`pnpm test:integration:upgrade-local`). Real Docker + the real
 * exact-pinned `@supabase/lite@0.9.0` CLI: bootstraps a file-backed
 * supalite-sqlite-postgres source, clones it into a retained baseline B and an
 * upgrade-source U, runs the real `lite upgrade --target local` transition into a
 * fresh Supabase-local stack C, and verifies every §12 preservation + behavior
 * property. Sessions are not migrated; the fixture actor re-authenticates.
 */

async function containerCount(namePattern: string): Promise<number> {
  const p = spawnManaged("bash", ["-c", `docker ps -aq --filter "name=${namePattern}" | wc -l`], {
    cwd: process.cwd(),
    env: process.env,
  });
  await p.waitForExit();
  return Number(p.stdout().trim());
}

describe("L8 verify-upgrade: Supalite → real `lite upgrade` → Supabase-local", () => {
  it("dry-run is mandatory: without execute it only plans the §12 workflow and mutates nothing", async () => {
    const report = await verifyUpgrade();
    expect(report.dryRun).toBe(true);
    expect(report.mutated).toBe(false);
    expect(report.rejectedBeforeMutation).toBe(false);
    expect(report.plan.length).toBeGreaterThan(10);
    expect(report.plan.join("\n")).toMatch(/lite upgrade --target local/);
    expect(report.checks).toEqual([
      expect.objectContaining({ name: "dry-run", status: "skipped" }),
    ]);
    expect(report.targets[0]).toMatchObject({
      role: "source",
      kind: "supalite-sqlite-postgres",
      implementation: "@supabase/lite",
      implementationVersion: "0.9.0",
    });
  });

  it("--supalite-version 0.10.0 governs the dry-run's source identity (no mutation, no network)", async () => {
    const report = await verifyUpgrade({ supaliteVersion: "0.10.0" });
    expect(report.dryRun).toBe(true);
    expect(report.mutated).toBe(false);
    expect(report.targets[0]).toMatchObject({
      role: "source",
      implementation: "@supabase/lite",
      implementationVersion: "0.10.0",
      clientVersion: "2.114.0",
    });
  });

  it("an unregistered Supalite version fails closed before any mutation", async () => {
    await expect(verifyUpgrade({ supaliteVersion: "9.9.9" })).rejects.toThrow(
      /Unregistered @supabase\/lite version/,
    );
  });

  it("required Storage preservation is rejected BEFORE any mutation", async () => {
    const report = await verifyUpgrade({ execute: true, requireStoragePreservation: true });
    expect(report.mutated).toBe(false);
    expect(report.rejectedBeforeMutation).toBe(true);
    expect(report.ok).toBe(false);
    expect(report.checks).toEqual([
      expect.objectContaining({ name: "storage-preservation", status: "rejected" }),
    ]);
    expect(report.checks[0]!.detail).toMatch(/before S0 was bootstrapped/i);
  });

  it("transition failure after a real dry-run cleans up and leaks no containers", async () => {
    const before = await containerCount("lite-local");
    const report = await verifyUpgrade({
      execute: true,
      injectTransitionFailure: true,
      log: (l) => process.stderr.write(l),
    });
    expect(report.ok).toBe(false);
    // The real dry-run ran and passed before the injected abort.
    expect(report.checks.find((c) => c.name === "lite-dry-run")?.status).toBe("pass");
    expect(report.checks.find((c) => c.name === "flow")?.status).toBe("fail");
    expect(await containerCount("lite-local")).toBe(before);
  }, 600_000);

  it("executes the full Supalite → lite upgrade → Supabase-local flow and every property holds", async () => {
    const report = await verifyUpgrade({ execute: true, log: (l) => process.stderr.write(l) });

    const byName = Object.fromEntries(report.checks.map((c) => [c.name, c]));
    const detail = JSON.stringify(report.checks, null, 2);

    expect(report.mutated, detail).toBe(true);

    // The real transition mechanism.
    expect(report.liteDryRunCommand, detail).toMatch(
      /lite\/dist\/cli\/index\.js upgrade --target local --dry-run/,
    );
    expect(report.liteUpgradeCommand, detail).toMatch(
      /upgrade --target local --local-dir .* --force --no-migrate-sessions/,
    );
    expect(byName["lite-dry-run"]?.status, detail).toBe("pass");
    expect(byName["lite-upgrade"]?.status, detail).toBe("pass");

    // Source not mutated in place; baseline retained.
    expect(byName["source-workdir-untouched"]?.status, detail).toBe("pass");
    expect(byName["baseline-retained"]?.status, detail).toBe("pass");

    // Preservation vs probe P0.
    expect(byName["id-preservation"]?.status, detail).toBe("pass");
    expect(byName["id-corruption-detected"]?.status, detail).toBe("pass");
    expect(byName["auth-subject-preservation"]?.status, detail).toBe("pass");

    // Sequence next-use, lockstep B vs C. B (a plain Supalite clone) always advances
    // past the migrated ids; `lite upgrade` from a file-backed source does not carry
    // the serial-sequence position, a reproduced cross-target divergence. Accept either
    // outcome so a future lite that fixes this does not fail the suite.
    expect(["pass", "divergence"], detail).toContain(byName["sequence-next-use"]?.status);
    expect(byName["sequence-next-use"]?.detail, detail).toMatch(/B .*advances/);
    if (byName["sequence-next-use"]?.status === "divergence") {
      expect(report.divergences, detail).toContain("div.lite-upgrade-local-sequence-not-reset");
    }

    // Sessions: non-preservation + re-authentication of the same logical subject.
    expect(byName["session-non-preservation"]?.status, detail).toBe("pass");
    expect(byName["reauthentication"]?.status, detail).toBe("pass");

    // Same behavior lockstep B vs C.
    expect(byName["rls-behavior-lockstep"]?.status, detail).toBe("pass");

    // Storage preservation not claimed.
    expect(byName["storage-preservation"]?.status, detail).toBe("skipped");

    const destination = report.targets.find((t) => t.role === "destination")!;
    expect(destination.kind).toBe("supabase-local");
    expect(destination.apiUrl, detail).toMatch(/^http/);

    expect(report.ok, detail).toBe(true);
    expect(
      report.checks.some((c) => c.status === "fail"),
      detail,
    ).toBe(false);
  }, 1_200_000);
});
