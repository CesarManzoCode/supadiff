import type { OutputMode } from "../config/parse-args.js";

export interface CliResult {
  format: "supadiff.cli-result";
  formatVersion: "1";
  command: string;
  ok: boolean;
  state: string;
  exitCode: number;
  artifactPath?: string;
  summary: string;
  outcomeCounts: Record<string, number>;
  [key: string]: unknown;
}

/**
 * Renders a command's final result per §14.3's stream contract. Human mode writes a
 * concise summary to stdout and nothing else; JSON mode writes exactly one JSON
 * document to stdout with no banners/ANSI/progress; NDJSON mode writes any queued
 * event lines followed by the terminal result object.
 */
export function renderResult(
  mode: OutputMode,
  result: CliResult,
  ndjsonEvents: object[] = [],
): void {
  if (mode === "json") {
    process.stdout.write(JSON.stringify(result) + "\n");
    return;
  }
  if (mode === "ndjson") {
    for (const ev of ndjsonEvents) process.stdout.write(JSON.stringify(ev) + "\n");
    process.stdout.write(JSON.stringify(result) + "\n");
    return;
  }
  // human
  process.stdout.write(`${result.summary}\n`);
  for (const [outcome, count] of Object.entries(result.outcomeCounts)) {
    process.stdout.write(`  ${outcome}: ${count}\n`);
  }
  if (result.artifactPath) process.stdout.write(`artifact: ${result.artifactPath}\n`);
}

export function progress(mode: OutputMode, quiet: boolean, message: string): void {
  if (mode !== "human" || quiet) return;
  process.stderr.write(`${message}\n`);
}
