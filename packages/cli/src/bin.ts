#!/usr/bin/env node
import { parseArgs } from "./config/parse-args.js";
import { runCommand } from "./commands/run.js";
import { compareCommand } from "./commands/compare.js";
import { inspectCommand } from "./commands/inspect.js";
import { replayCommand } from "./commands/replay.js";
import { reduceCommand } from "./commands/reduce.js";
import { EXIT_INTERNAL_ERROR, EXIT_INVALID } from "./exit-codes.js";

const NOT_IMPLEMENTED = new Set(["verify-upgrade"]);

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));

  if (NOT_IMPLEMENTED.has(args.command)) {
    process.stderr.write(
      `supadiff ${args.command}: not implemented (planned for a later Implementation DAG layer)\n`,
    );
    return EXIT_INVALID;
  }

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
    case "":
      process.stderr.write("usage: supadiff <run|compare|inspect> ...\n");
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
