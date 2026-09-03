import { verifyUpgrade } from "@supadiff/targets";
import type { ParsedArgs } from "../config/parse-args.js";
import { renderResult, type CliResult } from "../output/render.js";
import {
  EXIT_OK,
  EXIT_BEHAVIORAL_POLICY_VIOLATION,
  EXIT_INCONCLUSIVE,
  EXIT_INVALID,
} from "../exit-codes.js";

/**
 * `supadiff verify-upgrade` (L8, Architecture Contract §12). Verifies that a local
 * Supabase Postgres major-version upgrade preserves row IDs, sequence values, Auth users,
 * and RLS policies, that sessions are NOT preserved (re-authentication is required), and
 * records that Storage preservation is unsupported.
 *
 * Dry-run is mandatory: without `--execute` the command only prints the flow it would
 * run and exits 0. With `--execute` it provisions two real stacks (Postgres `--from` then
 * `--to`, sequentially) over Docker and runs every preservation check.
 */
export async function verifyUpgradeCommand(args: ParsedArgs): Promise<number> {
  const from = Number(args.upgrade?.from ?? "15");
  const to = Number(args.upgrade?.to ?? "17");
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 13 || to > 17 || from >= to) {
    process.stderr.write(
      `supadiff verify-upgrade: --from (${from}) must be an integer < --to (${to}), both in 13..17\n`,
    );
    return EXIT_INVALID;
  }

  const report = await verifyUpgrade({
    fromMajor: from,
    toMajor: to,
    execute: args.upgrade?.execute ?? false,
    destParentDir: args.upgrade?.destDir,
    log: (line) => {
      if (args.flags.output === "human" && !args.flags.quiet) process.stderr.write(line);
    },
  });

  const failed = report.checks.filter((c) => c.status === "fail");
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
    state: report.dryRun ? "dry-run" : exitCode === EXIT_OK ? "verified" : "failed",
    exitCode,
    summary: report.dryRun
      ? `verify-upgrade dry-run: pg ${from} -> ${to}, ${report.plan.length} planned steps (pass --execute to run)`
      : `verify-upgrade pg ${from} -> ${to}: ${report.checks.filter((c) => c.status === "pass").length} passed, ` +
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
