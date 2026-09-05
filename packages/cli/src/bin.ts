#!/usr/bin/env node
import { parseArgs } from "./config/parse-args.js";
import { runCommand } from "./commands/run.js";
import { compareCommand } from "./commands/compare.js";
import { inspectCommand } from "./commands/inspect.js";
import { replayCommand } from "./commands/replay.js";
import { reduceCommand } from "./commands/reduce.js";
import { verifyUpgradeCommand } from "./commands/verify-upgrade.js";
import { EXIT_INTERNAL_ERROR, EXIT_INVALID, EXIT_OK } from "./exit-codes.js";

const USAGE = `supadiff — deterministic, capability-aware comparison of observable
Supabase-shaped behavior across scenario executions.

Usage: supadiff <command> [options]

Commands:
  run <scenario> --target <recipe> [--target <recipe> ...] [--policy <file>]
      Execute a scenario lockstep across two or more targets and compare.

  verify-upgrade [--supalite-version <version>] [--execute] [--require-storage]
      L8: Supalite → real \`lite upgrade --target local\` → Supabase-local.
      Mandatory dry-run unless --execute is passed. --supalite-version selects
      a registered Supalite package profile (default: 0.9.0).

  compare <result-a> <result-b>       Offline comparison of two recorded results.
  inspect <artifact>                  Inspect a recorded artifact.
  replay <artifact>                   Replay a recorded artifact's plan.
  reduce <artifact>                   Reduce a failing artifact to a minimal case.

Common options: --output <human|json|ndjson>, --out <path>, --quiet, --no-color

See README.md for setup and worked examples.
`;

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  if (argv[0] === "--help" || argv[0] === "-h" || argv[0] === "help") {
    process.stdout.write(USAGE);
    return EXIT_OK;
  }
  const args = parseArgs(argv);

  switch (args.command) {
    case "run":
      return runCommand(args);
    case "compare":
      return compareCommand(args);
    case "inspect":
      return inspectCommand(args);
    case "replay":
      return replayCommand(args);
    case "reduce":
      return reduceCommand(args);
    case "verify-upgrade":
      return verifyUpgradeCommand(args);
    case "":
      process.stderr.write(
        "usage: supadiff <run|compare|inspect|replay|reduce|verify-upgrade> ...\n",
      );
      return EXIT_INVALID;
    default:
      process.stderr.write(`supadiff: unknown command "${args.command}"\n`);
      return EXIT_INVALID;
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    process.stderr.write(
      `supadiff: internal error: ${err instanceof Error ? err.stack : String(err)}\n`,
    );
    process.exitCode = EXIT_INTERNAL_ERROR;
  });
