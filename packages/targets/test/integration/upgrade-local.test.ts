import { describe, expect, it } from "vitest";
import { verifyUpgrade } from "../../src/index.js";

/**
 * L8 acceptance (`pnpm test:integration:upgrade-local`). Real Docker: brings up a
 * Supabase local stack at Postgres 15, upgrades to Postgres 17 via pg_dump/restore into a
 * fresh destination workdir, and verifies every §12 preservation property. Source and
 * destination stacks run sequentially, so peak memory is one stack.
 */
describe("L8 verify-upgrade: local Supabase Postgres 15 -> 17", () => {
  it("dry-run is mandatory: without execute it only plans and mutates nothing", async () => {
    const report = await verifyUpgrade({ fromMajor: 15, toMajor: 17 });
    expect(report.dryRun).toBe(true);
    expect(report.mutated).toBe(false);
    expect(report.plan.length).toBeGreaterThan(10);
    expect(report.checks).toEqual([
      expect.objectContaining({ name: "dry-run", status: "skipped" }),
    ]);
  });

  it("executes the full flow and every preservation check passes", async () => {
    const report = await verifyUpgrade({
      fromMajor: 15,
      toMajor: 17,
      execute: true,
      log: (l) => process.stderr.write(l),
    });

    const byName = Object.fromEntries(report.checks.map((c) => [c.name, c]));
    const detail = JSON.stringify(report.checks, null, 2);

    expect(report.mutated).toBe(true);
    expect(report.sourceCliVersion).toBeDefined();
    expect(report.destCliVersion).toBeDefined();

    // No session preservation + re-authentication (§12).
    expect(byName["no-session-preservation"]?.status, detail).toBe("pass");
    expect(byName["reauthentication"]?.status, detail).toBe("pass");

    // ID / sequence / Auth / RLS preservation (§12).
    expect(byName["id-preservation"]?.status, detail).toBe("pass");
    expect(byName["sequence-preservation"]?.status, detail).toBe("pass");
    expect(byName["auth-preservation"]?.status, detail).toBe("pass");
    expect(byName["rls-preservation"]?.status, detail).toBe("pass");

    // Storage preservation is unsupported and must be recorded as skipped, never claimed.
    expect(byName["storage-preservation"]?.status, detail).toBe("skipped");

    expect(report.ok, detail).toBe(true);
    expect(
      report.checks.some((c) => c.status === "fail"),
      detail,
    ).toBe(false);
  }, 900_000);
});
