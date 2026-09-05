export type OutputMode = "human" | "json" | "ndjson";

export interface CommonFlags {
  out?: string;
  output: OutputMode;
  reference?: string;
  failOn: string[];
  policy?: string;
  divergences?: string;
  quiet: boolean;
  noColor: boolean;
}

export interface ParsedArgs {
  command: string;
  positionals: string[];
  targets: string[];
  flags: CommonFlags;
  /** `verify-upgrade` (L8) options; `parseArgs` always populates this. */
  upgrade?: {
    execute: boolean;
    /** Parent directory for the transient S0 / baseline / upgrade-source / destination workdirs. */
    workdirParent?: string;
    /** Declare the workflow requires Storage preservation (rejected before mutation). */
    requireStorage: boolean;
    /** Selects a registered Supalite package profile by `@supabase/lite` version (`--supalite-version`). Omitted → the historical 0.9.0 baseline. */
    supaliteVersion?: string;
  };
}

const BOOLEAN_FLAGS = new Set([
  "--quiet",
  "--no-color",
  "--allow-approximation",
  "--allow-experimental",
  "--keep-on-failure",
  "--allow-hosted",
  "--allow-hosted-create",
  "--allow-hosted-destructive",
  "--execute",
  "--require-storage",
]);

export function parseArgs(argv: string[]): ParsedArgs {
  const [command, ...rest] = argv;
  const positionals: string[] = [];
  const targets: string[] = [];
  let out: string | undefined;
  let output: OutputMode = process.stdout.isTTY ? "human" : "json";
  let reference: string | undefined;
  let failOn: string[] = [...DEFAULT_FAIL_ON_STRINGS];
  let policy: string | undefined;
  let divergences: string | undefined;
  let quiet = false;
  let noColor = false;
  let upExecute = false;
  let upWorkdirParent: string | undefined;
  let upRequireStorage = false;
  let upSupaliteVersion: string | undefined;

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (arg === "--target") targets.push(rest[++i]!);
    else if (arg === "--out") out = rest[++i];
    else if (arg === "--output") output = rest[++i] as OutputMode;
    else if (arg === "--reference") reference = rest[++i];
    else if (arg === "--fail-on") failOn = rest[++i]!.split(",");
    else if (arg === "--policy") policy = rest[++i];
    else if (arg === "--divergences") divergences = rest[++i];
    else if (arg === "--workdir-parent" || arg === "--dest-dir") upWorkdirParent = rest[++i];
    else if (arg === "--execute") upExecute = true;
    else if (arg === "--require-storage") upRequireStorage = true;
    else if (arg === "--supalite-version") upSupaliteVersion = rest[++i];
    else if (arg === "--quiet") quiet = true;
    else if (arg === "--no-color") noColor = true;
    else if (BOOLEAN_FLAGS.has(arg)) {
      // accepted but not consumed further in this L0-L5 build (hosted/local safety
      // flags apply only to L6+ concrete drivers).
    } else if (arg.startsWith("--")) {
      i++; // unknown flag with a value; skip its value defensively
    } else {
      positionals.push(arg);
    }
  }

  return {
    command: command ?? "",
    positionals,
    targets,
    flags: { out, output, reference, failOn, policy, divergences, quiet, noColor },
    upgrade: {
      execute: upExecute,
      workdirParent: upWorkdirParent,
      requireStorage: upRequireStorage,
      supaliteVersion: upSupaliteVersion,
    },
  };
}

const DEFAULT_FAIL_ON_STRINGS = ["new", "inconclusive", "cleanup"];
