import { verifyUpgrade } from "@supadiff/targets";
import type { ParsedArgs } from "../config/parse-args.js";
import { renderResult, type CliResult } from "../output/render.js";
import { EXIT_OK, EXIT_BEHAVIORAL_POLICY_VIOLATION, EXIT_INCONCLUSIVE } from "../exit-codes.js";

/**
 * `supadiff verify-upgrade` (L8, Architecture Contract §12). Verifies the real
 * transition a Supalite project makes to full Supabase:
 *
 *   file-backed Supalite (supalite-sqlite-postgres)
 *     → clone into a retained baseline B and an upgrade-source U
 *     → real `lite upgrade --target local` from `@supabase/lite@0.9.0` into a fresh
 *       Supabase-local stack C (the pinned `supabase` CLI)
 *     → preservation comparison (row IDs, sequence next-use, Auth logical subject)
 *     → same-behavior owner-scoped-RLS scenario run lockstep on B and C.
 *
 * Sessions are NOT migrated (`migrateSessions = false`): the pre-upgrade token must be
 * rejected by C and the fixture actor re-authenticates. Storage preservation is
 * unsupported; when `--require-storage` is passed it is rejected before any mutation.
 *
 * Dry-run is mandatory: without `--execute` the command only prints the §12 workflow
 * and exits 0. With `--execute` it provisions real local targets over Docker.
 */
export async function verifyUpgradeCommand(args: ParsedArgs): Promise<number> {
  const report = await verifyUpgrade({
    execute: args.upgrade?.execute ?? false,
    requireStoragePreservation: args.upgrade?.requireStorage ?? false,
    workdirParentDir: args.upgrade?.workdirParent,
    log: (line) => {
      if (args.flags.output === "human" && !args.flags.quiet) process.stderr.write(line);
    },
  });

  const failed = report.checks.filter((c) => c.status === "fail" || c.status === "rejected");
  const flowAborted = failed.some((c) => c.name === "flow");
  const exitCode = report.dryRun
    ? EXIT_OK
    : flowAborted
      ? EXIT_INCONCLUSIVE
      : failed.length > 0
        ? EXIT_BEHAVIORAL_POLICY_VIOLATION
        : EXIT_OK;

  const cliResult: CliResult = {
    format: "supadiff.cli-result",
    formatVersion: "1",
    command: "verify-upgrade",
    ok: report.ok && exitCode === EXIT_OK,
    state: report.dryRun
      ? "dry-run"
      : report.rejectedBeforeMutation
        ? "rejected"
        : exitCode === EXIT_OK
          ? "verified"
          : "failed",
    exitCode,
    summary: report.dryRun
      ? `verify-upgrade dry-run: Supalite → lite upgrade → Supabase-local, ${report.plan.length} workflow segments (pass --execute to run)`
      : report.rejectedBeforeMutation
        ? "verify-upgrade rejected before mutation: workflow requires Storage preservation, which lite upgrade cannot provide"
        : `verify-upgrade: ${report.checks.filter((c) => c.status === "pass").length} passed, ` +
          `${failed.length} failed, ${report.checks.filter((c) => c.status === "skipped").length} skipped`,
    outcomeCounts: report.checks.reduce<Record<string, number>>((acc, c) => {
      acc[c.status] = (acc[c.status] ?? 0) + 1;
      return acc;
    }, {}),
    upgrade: report,
  };

  renderResult(args.flags.output, cliResult);
  if (args.flags.output === "human" && report.dryRun) {
    for (const [i, step] of report.plan.entries()) {
      process.stdout.write(`  ${String(i + 1).padStart(2)}. ${step}\n`);
    }
  }
  return exitCode;
}
