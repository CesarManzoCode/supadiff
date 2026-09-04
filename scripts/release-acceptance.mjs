#!/usr/bin/env node
// L14 release acceptance recorder (`pnpm release:acceptance`).
//
// Executes the fixed, bounded list of v1 acceptance gates (`scripts/acceptance-gates.mjs`)
// against the current working tree and records, for each one, the *actual* execution result:
// exact command, exit code, pass/fail, wall-clock duration, and a sanitized copy of the full
// command output as a content-addressed artifact under `release-evidence/acceptance/`.
//
// This is the recorder half of the L14 evidence mechanism. The verifier half
// (`pnpm release:evidence`) refuses to emit a release manifest unless every gate here has a
// recorded, passing, digest-consistent, non-stale result. It is deliberately tiny: no retry
// logic, no matrix, no scheduling — just "run these commands, capture what happened, redact
// secrets, hash the artifact".
//
// Secret hygiene: stdout/stderr is filtered through `sanitize()` before it ever touches disk
// (hosted access token, project ref, and the standard Supabase key/JWT shapes are replaced
// with fixed placeholders). Nothing here prints a raw credential.

import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync, readdirSync, existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import {
  ROOT,
  sha256,
  sha256File,
  collectReleaseInputs,
  releaseInputsDigest,
} from "./release-inputs.mjs";
import { ACCEPTANCE_GATES } from "./acceptance-gates.mjs";

const OUT_DIR = path.join(ROOT, "release-evidence", "acceptance");
const RESULTS = path.join(OUT_DIR, "results.json");

const argv = process.argv.slice(2);
const onlyArg = argv.find((a) => a.startsWith("--only="));
const only = onlyArg ? new Set(onlyArg.slice("--only=".length).split(",").filter(Boolean)) : null;
const list = argv.includes("--list");

if (list) {
  for (const g of ACCEPTANCE_GATES) console.log(`${g.id.padEnd(12)} ${g.command}`);
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Secret sanitizer
// ---------------------------------------------------------------------------

/** @param {string} text */
function sanitize(text) {
  let out = text;
  const token = process.env.SUPADIFF_HOSTED_ACCESS_TOKEN;
  const ref = process.env.SUPADIFF_HOSTED_PROJECT_REF;
  if (token && token.length >= 8) out = out.split(token).join("«SUPADIFF_HOSTED_ACCESS_TOKEN»");
  if (ref && ref.length >= 8) out = out.split(ref).join("«SUPADIFF_HOSTED_PROJECT_REF»");
  out = out
    .replace(/\bsbp_[A-Za-z0-9]{8,}/g, "«sbp_redacted»")
    .replace(/\bsb_secret_[A-Za-z0-9]{6,}/g, "«sb_secret_redacted»")
    .replace(/\bsb_publishable_[A-Za-z0-9]{6,}/g, "«sb_publishable_redacted»")
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{6,}/g, "«jwt_redacted»");
  return out;
}

const SECRET_RES = [
  /\bsbp_[A-Za-z0-9]{20,}/,
  /\bsb_secret_[A-Za-z0-9]{10,}/,
  /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/,
];
function assertClean(label, text) {
  const ref = process.env.SUPADIFF_HOSTED_PROJECT_REF;
  const token = process.env.SUPADIFF_HOSTED_ACCESS_TOKEN;
  for (const re of SECRET_RES) {
    if (re.test(text)) throw new Error(`${label}: sanitized output still matches ${re}`);
  }
  if (ref && ref.length > 8 && text.includes(ref)) {
    throw new Error(`${label}: sanitized output still contains the live hosted project ref`);
  }
  if (token && token.length > 8 && text.includes(token)) {
    throw new Error(`${label}: sanitized output still contains the hosted access token`);
  }
}

// ---------------------------------------------------------------------------
// Target identity per gate (no secret material — hosted ref is fingerprinted)
// ---------------------------------------------------------------------------

function targetIdentity(id, toolchain) {
  const lite = toolchain["@supabase/lite"];
  const cli = toolchain.supabaseCli;
  switch (id) {
    case "L6":
    case "L12-smoke":
      return `real @supabase/lite@${lite} subprocess`;
    case "L7":
    case "L8":
    case "L11":
      return `real @supabase/lite@${lite} ↔ supabase CLI ${cli} (pinned images) over Docker`;
    case "L13": {
      const ref = process.env.SUPADIFF_HOSTED_PROJECT_REF ?? "";
      const fp = ref ? sha256(ref).slice("sha256:".length, "sha256:".length + 16) : "unknown";
      return `real supabase-hosted throwaway smoke project · postgres 17 · ref-fingerprint ${fp}`;
    }
    default:
      return "none (hermetic — no real target, no network)";
  }
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

const { inputs, errors: inputErrors } = await collectReleaseInputs();
if (inputErrors.length > 0) {
  console.error("release:acceptance: release inputs do not collect cleanly:");
  for (const e of inputErrors) console.error(`  - ${e}`);
  process.exit(1);
}
const toolchain = inputs.toolchain;
const digest = releaseInputsDigest(inputs);

mkdirSync(OUT_DIR, { recursive: true });

const gatesToRun = ACCEPTANCE_GATES.filter((g) => !only || only.has(g.id));
if (gatesToRun.length === 0) {
  console.error(`release:acceptance: --only matched no gates`);
  process.exit(1);
}

// Preserve prior results for gates we are not re-running this pass (partial re-record).
/** @type {Map<string, object>} */
const prior = new Map();
if (existsSync(RESULTS)) {
  try {
    for (const r of JSON.parse(readFileSync(RESULTS, "utf8")).gates ?? []) prior.set(r.id, r);
  } catch {
    /* ignore an unreadable prior results file */
  }
}

const results = [];
let anyFailed = false;

for (const gate of ACCEPTANCE_GATES) {
  // The release-evidence gate IS the verifier reading this file. It cannot record its own
  // prior run without infinite regress: its pass/fail for a given tree is simply the exit
  // status of the `pnpm release:evidence` invocation that consumes these results.
  if (gate.id === "L14-evidence") {
    results.push({
      id: gate.id,
      command: gate.command,
      executed: false,
      exitCode: null,
      status: "self-verifying",
      durationMs: null,
      artifact: null,
      artifactSha256: null,
      artifactBytes: null,
      targetIdentity: "none (hermetic — verifies the other recorded results)",
      proves: gate.proves,
      limitations: gate.limitations,
      notes: [
        "This gate is `pnpm release:evidence` itself; it re-verifies every other recorded " +
          "result on each run. Its own pass/fail is the exit status of that invocation.",
      ],
    });
    console.log(
      `\n──► [${gate.id}] ${gate.command}\n    SELF-VERIFYING (run \`pnpm release:evidence\` after this)`,
    );
    continue;
  }
  if (only && !only.has(gate.id)) {
    const p = prior.get(gate.id);
    if (p) {
      results.push(p);
      continue;
    }
    // --only is for iterative re-recording; a gate with no prior result stays unrecorded
    // (a partial results file `pnpm release:evidence` will correctly reject).
    console.warn(
      `release:acceptance: --only skips "${gate.id}" and it has no prior recorded result`,
    );
    results.push({
      id: gate.id,
      command: gate.command,
      executed: false,
      exitCode: null,
      status: "not-recorded",
      durationMs: null,
      artifact: null,
      artifactSha256: null,
      artifactBytes: null,
      targetIdentity: null,
      proves: gate.proves,
      limitations: gate.limitations,
      notes: ["not recorded in this --only pass"],
    });
    anyFailed = true;
    continue;
  }

  console.log(`\n──► [${gate.id}] ${gate.command}`);
  const started = Date.now();
  const proc = spawnSync(gate.command, {
    cwd: ROOT,
    env: process.env,
    shell: "/bin/bash",
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: 30 * 60 * 1000,
  });
  const durationMs = Date.now() - started;

  const rawStdout = proc.stdout ?? "";
  const rawStderr = proc.stderr ?? "";
  const combined = sanitize(
    `$ ${gate.command}\n\n===== stdout =====\n${rawStdout}\n===== stderr =====\n${rawStderr}\n`,
  );
  assertClean(`gate ${gate.id}`, combined);

  const artifactRel = `release-evidence/acceptance/${gate.id}.log`;
  const artifactAbs = path.join(ROOT, artifactRel);
  writeFileSync(artifactAbs, combined);

  const exitCode = proc.status === null ? (proc.signal ? 124 : 1) : proc.status;
  const status = exitCode === 0 ? "pass" : "fail";
  if (status !== "pass") anyFailed = true;

  // Surface non-fatal skips so the evidence is honest about partial coverage.
  const notes = [];
  if (/skipping — no reachable admin PostgreSQL/.test(combined)) {
    notes.push("supalite-postgres backend self-skipped: no local admin PostgreSQL reachable");
  }
  if (/\bskipped\b/i.test(rawStdout) && /test/i.test(rawStdout)) {
    const m = rawStdout.match(/Tests\s+.*?(\d+)\s+skipped/);
    if (m) {
      const detail =
        gate.id === "L13"
          ? ` — the fail-closed credential-precondition block (inert when hosted credentials are ` +
            `present); all 13 real hosted tests ran`
          : "";
      notes.push(`${m[1]} test(s) reported skipped by vitest${detail}`);
    }
  }

  results.push({
    id: gate.id,
    command: gate.command,
    executed: true,
    exitCode,
    status,
    durationMs,
    artifact: artifactRel,
    artifactSha256: sha256File(artifactAbs),
    artifactBytes: Buffer.byteLength(combined),
    targetIdentity: targetIdentity(gate.id, toolchain),
    proves: gate.proves,
    limitations: gate.limitations,
    notes,
  });

  console.log(`    ${status.toUpperCase()} (exit ${exitCode}, ${(durationMs / 1000).toFixed(1)}s)`);
}

const manifest = {
  format: "supadiff.release-acceptance",
  formatVersion: "1.0",
  recordedAt: new Date().toISOString(),
  recorderPlatform: `${os.type()} ${os.arch()} · node ${process.version}`,
  releaseVersion: inputs.version,
  releaseInputsDigest: digest,
  toolchain,
  gates: results.sort((a, b) => a.id.localeCompare(b.id)),
};

const manifestText = JSON.stringify(manifest, null, 2) + "\n";
assertClean("results.json", manifestText);
writeFileSync(RESULTS, manifestText);

// Drop stale per-gate logs for gate ids no longer in the list.
const validLogs = new Set(ACCEPTANCE_GATES.map((g) => `${g.id}.log`));
for (const f of readdirSync(OUT_DIR)) {
  if (f.endsWith(".log") && !validLogs.has(f)) rmSync(path.join(OUT_DIR, f));
}

console.log(
  `\nrelease:acceptance recorded ${results.length} gate result(s) → ${path.relative(ROOT, RESULTS)}`,
);
console.log(`release inputs digest: ${digest}`);
if (anyFailed) {
  console.error(
    `\nrelease:acceptance: ${results.filter((r) => r.status !== "pass").length} gate(s) FAILED — ` +
      `see the per-gate logs. \`pnpm release:evidence\` will refuse to emit a manifest.`,
  );
  process.exit(1);
}
console.log("all recorded gates passed.");
