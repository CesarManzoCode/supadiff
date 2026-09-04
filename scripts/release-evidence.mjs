#!/usr/bin/env node
// L14 release-evidence gate (`pnpm release:evidence`).
//
// Produces the versioned, self-verifying release-evidence manifest for SupaDiff from the
// *actual* repository state — exact tool/target versions, the per-target capability matrix
// (straight from the driver `declare*Capabilities()` functions), the active divergence
// registry, the acceptance-gate command list, the explicit unproven surfaces, and — new in
// v1 — the *recorded acceptance results* (`release-evidence/acceptance/results.json`,
// produced by `pnpm release:acceptance`). It then checks a set of invariants (version
// consistency, no secret material, every cited acceptance command exists, every capability
// carries evidence, no fake-target result presented as real Supabase/Supalite evidence,
// and — for every acceptance gate — a recorded, passing, digest-consistent, non-stale
// result) and, if a manifest for this version is already committed, refuses to let its
// stable content drift silently.
//
// It does NOT re-execute the gates: `pnpm release:acceptance` does that and records what
// happened; this gate proves that record is present, green, untampered, and current.

import { mkdirSync, readFileSync, existsSync, writeFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import {
  ROOT,
  canonical,
  sha256,
  sha256File,
  collectReleaseInputs,
  releaseInputsDigest,
} from "./release-inputs.mjs";
import { ACCEPTANCE_GATES } from "./acceptance-gates.mjs";

const read = (p) => readFileSync(path.join(ROOT, p), "utf8");
const readJson = (p) => JSON.parse(read(p));

/** @type {string[]} */
const errors = [];
const fail = (m) => errors.push(m);

const SECRET_PATTERNS = [
  /\bsbp_[A-Za-z0-9]{20,}/,
  /\bsb_secret_[A-Za-z0-9]{10,}/,
  /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/,
];

// ---------------------------------------------------------------------------
// Stable release inputs (shared with the acceptance recorder)
// ---------------------------------------------------------------------------

const { inputs, errors: inputErrors, rootPkg } = await collectReleaseInputs();
for (const e of inputErrors) fail(e);
const VERSION = inputs.version;
const inputsDigest = releaseInputsDigest(inputs);

// ---------------------------------------------------------------------------
// Acceptance gates + explicit unproven surfaces
// ---------------------------------------------------------------------------

const acceptanceGates = ACCEPTANCE_GATES.map((g) => ({
  id: g.id,
  command: g.command,
  proves: g.proves,
}));

const unprovenSurfaces = [
  "Realtime, Edge Functions, and any dashboard/UI — never in scope (Architecture Contract §20).",
  "supabase-hosted `create-ephemeral` attach mode: implemented and safety-gated, but not exercised against a real org in CI (requires SUPADIFF_HOSTED_ORG_ID + billing). Only `attach-explicit` has a passing real acceptance gate.",
  "Hosted `lite upgrade --target hosted` transitions are not exercised (L8 covers `--target local` only).",
  "supabase-hosted `auth.signUp` uses the real GoTrue admin API + real password grant (not the public mailer flow) because the dedicated smoke project has no SMTP and the project-scoped token cannot toggle mailer autoconfirm — see docs/adr/0003-hosted-signup-via-admin-api.md.",
  "The L10 reducer and L12 generator are scoped to SupaDiff's own Data+Auth+RLS domain model, not general-purpose tools.",
  "Storage byte preservation across `lite upgrade` is `unsupported` and is rejected before any mutation when required (not silently skipped).",
  "The L13 hosted cleanup gate proves the measured owned-resource census (public tables, auth users, Storage buckets, SupaDiff ownership schema) returns to the pre-run empty state — not that the hosted project is byte-for-byte identical to its initial image.",
  "`pnpm release:evidence` verifies the recorded acceptance results for consistency, non-failure, and freshness against the release-inputs digest; it does not itself re-run the gates.",
];

// ---------------------------------------------------------------------------
// Recorded acceptance results (from `pnpm release:acceptance`)
// ---------------------------------------------------------------------------

const RESULTS_REL = "release-evidence/acceptance/results.json";
/** @type {{ id:string,command:string,executed:boolean,exitCode:number,status:string,artifact:string,artifactSha256:string }[]} */
let acceptanceResults = [];

if (!existsSync(path.join(ROOT, RESULTS_REL))) {
  fail(
    `${RESULTS_REL} is absent — run \`pnpm release:acceptance\` to execute the acceptance gates ` +
      `and record their real results before generating release evidence.`,
  );
} else {
  let recorded;
  try {
    recorded = readJson(RESULTS_REL);
  } catch (e) {
    recorded = null;
    fail(`${RESULTS_REL} does not parse: ${String(e)}`);
  }
  if (recorded) {
    if (recorded.format !== "supadiff.release-acceptance") {
      fail(`${RESULTS_REL}: unexpected format ${JSON.stringify(recorded.format)}`);
    }
    if (recorded.releaseVersion !== VERSION) {
      fail(
        `${RESULTS_REL}: recorded releaseVersion ${JSON.stringify(recorded.releaseVersion)} != ${JSON.stringify(VERSION)}`,
      );
    }
    if (recorded.releaseInputsDigest !== inputsDigest) {
      fail(
        `${RESULTS_REL}: STALE — recorded against release-inputs digest ` +
          `${recorded.releaseInputsDigest} but the working tree now produces ${inputsDigest}. ` +
          `Re-run \`pnpm release:acceptance\`.`,
      );
    }

    const byId = new Map((recorded.gates ?? []).map((g) => [g.id, g]));
    for (const gate of ACCEPTANCE_GATES) {
      const r = byId.get(gate.id);
      if (!r) {
        fail(`acceptance gate "${gate.id}" (\`${gate.command}\`) has no recorded result`);
        continue;
      }
      // The evidence gate verifies the others; it does not record its own prior run.
      if (gate.id === "L14-evidence") {
        if (r.status !== "self-verifying") {
          fail(
            `acceptance gate "L14-evidence": expected status "self-verifying", got ${JSON.stringify(r.status)}`,
          );
        }
        continue;
      }
      if (r.command !== gate.command) {
        fail(
          `acceptance gate "${gate.id}": recorded command ${JSON.stringify(r.command)} != ` +
            `${JSON.stringify(gate.command)}`,
        );
      }
      if (r.executed !== true) fail(`acceptance gate "${gate.id}": not marked executed`);
      if (r.status !== "pass" || r.exitCode !== 0) {
        fail(
          `acceptance gate "${gate.id}": recorded result is ${JSON.stringify(r.status)} ` +
            `(exit ${r.exitCode}) — a release manifest requires every gate green`,
        );
      }
      const artAbs = path.join(ROOT, r.artifact ?? "");
      if (!r.artifact || !existsSync(artAbs)) {
        fail(
          `acceptance gate "${gate.id}": evidence artifact ${JSON.stringify(r.artifact)} missing`,
        );
      } else {
        const actual = sha256File(artAbs);
        if (actual !== r.artifactSha256) {
          fail(
            `acceptance gate "${gate.id}": ${r.artifact} digest ${actual} != recorded ` +
              `${r.artifactSha256} — the evidence artifact has changed since it was recorded`,
          );
        }
        // The log must itself be secret-free.
        const logText = read(r.artifact);
        for (const re of SECRET_PATTERNS) {
          if (re.test(logText)) fail(`${r.artifact}: matches a secret pattern ${re}`);
        }
        const envRefLocal = process.env.SUPADIFF_HOSTED_PROJECT_REF;
        if (envRefLocal && envRefLocal.length > 8 && logText.includes(envRefLocal)) {
          fail(`${r.artifact}: contains the live hosted project ref`);
        }
      }
    }

    acceptanceResults = ACCEPTANCE_GATES.map((gate) => {
      const r = byId.get(gate.id) ?? {};
      return {
        id: gate.id,
        command: gate.command,
        executed: r.executed === true,
        exitCode: r.exitCode ?? null,
        status: r.status ?? "missing",
        targetIdentity: r.targetIdentity ?? null,
        artifact: r.artifact ?? null,
        artifactSha256: r.artifactSha256 ?? null,
        notes: r.notes ?? [],
        limitations: gate.limitations,
      };
    });
  }
}

// ---------------------------------------------------------------------------
// Assemble + stable hash
// ---------------------------------------------------------------------------

const stable = {
  version: VERSION,
  toolchain: inputs.toolchain,
  pinnedImages: inputs.pinnedImages,
  targets: inputs.targets,
  divergences: inputs.divergences,
  acceptanceGates,
  unprovenSurfaces,
  scenarios: inputs.scenarios,
  releaseInputsDigest: inputsDigest,
  acceptanceResults,
};

const stableHash = sha256(canonical(stable));

// Non-canonical generation-time provenance. This is NOT the release revision: committing
// this file changes HEAD, so no commit hash recorded here can be the final v1.0.0 commit.
// The authoritative release commit is the one the `v1.0.0` git tag / GitHub Release points
// to. Only the working-tree branch + dirtiness at generation time is recorded, clearly
// labelled, and never fed into `stableHash`.
const provenance = {
  canonical: false,
  meaning:
    "generation-time working-tree state only — NOT the v1.0.0 release revision. " +
    "The authoritative release commit is the one the `v1.0.0` tag / GitHub Release points to.",
  generatedAt: new Date().toISOString(),
  generatedOnBranch: null,
  workingTreeDirtyAtGeneration: null,
};
try {
  provenance.generatedOnBranch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
    cwd: ROOT,
  })
    .toString()
    .trim();
  provenance.workingTreeDirtyAtGeneration =
    execFileSync("git", ["status", "--porcelain"], { cwd: ROOT }).toString().trim().length > 0;
} catch {
  /* not a git checkout — leave the fields null */
}

const manifest = {
  format: "supadiff.release-evidence",
  formatVersion: "1.1",
  ...stable,
  stableHash,
  provenance,
};

// ---------------------------------------------------------------------------
// Invariants
// ---------------------------------------------------------------------------

if (VERSION !== "1.0.0") fail(`root version is "${VERSION}", expected "1.0.0"`);
for (const p of readdirSync(path.join(ROOT, "packages"))) {
  const pj = `packages/${p}/package.json`;
  if (!existsSync(path.join(ROOT, pj))) continue;
  const v = readJson(pj).version;
  if (v !== VERSION) fail(`${pj} version "${v}" != root "${VERSION}"`);
}

const rootScripts = new Set(Object.keys(rootPkg.scripts ?? {}));
for (const g of acceptanceGates) {
  const scriptName = g.command.replace(/^SUPADIFF_HOSTED=1\s+/, "").replace(/^pnpm\s+/, "");
  if (!rootScripts.has(scriptName)) {
    fail(
      `acceptance gate "${g.id}" cites \`${g.command}\` but there is no such package.json script`,
    );
  }
}

for (const [kind, t] of Object.entries(inputs.targets)) {
  if (kind === "fake") {
    if (t.driver !== "test-infrastructure-only")
      fail("fake target must be marked test-infrastructure-only");
    if (t.capabilities.length !== 0)
      fail("fake target must declare no capabilities in release evidence");
    continue;
  }
  if (t.capabilities.length === 0) fail(`${kind}: no capabilities in the matrix`);
  for (const c of t.capabilities) {
    if (!c.evidenceKinds || c.evidenceKinds.length === 0) {
      fail(`${kind} capability "${c.id}" carries no evidence`);
    }
  }
}
if (inputs.divergences.length === 0) fail("no divergence registry entries found");

// No secret material anywhere in the manifest.
const asText = JSON.stringify(manifest);
for (const re of SECRET_PATTERNS) {
  if (re.test(asText)) fail(`release evidence manifest matches a secret pattern ${re}`);
}
const envRef = process.env.SUPADIFF_HOSTED_PROJECT_REF;
if (envRef && envRef.length > 8 && asText.includes(envRef)) {
  fail("release evidence manifest contains the live hosted project ref");
}

// ---------------------------------------------------------------------------
// Drift check against a previously committed manifest
// ---------------------------------------------------------------------------

mkdirSync(path.join(ROOT, "release-evidence"), { recursive: true });
const outJson = `release-evidence/v${VERSION}.json`;
const outMd = `release-evidence/v${VERSION}.md`;

if (existsSync(path.join(ROOT, outJson))) {
  let prev;
  try {
    prev = readJson(outJson);
  } catch {
    prev = null;
  }
  if (prev && prev.stableHash && prev.stableHash !== stableHash) {
    fail(
      `${outJson} is committed with stableHash ${prev.stableHash} but the repository now ` +
        `produces ${stableHash}. The release evidence is stale — regenerate and review the diff.`,
    );
  }
}

if (errors.length > 0) {
  console.error("release:evidence FAILED\n");
  for (const e of errors) console.error(`  - ${e}`);
  console.error(`\n${errors.length} problem(s). Manifest NOT written.`);
  process.exit(1);
}

writeFileSync(path.join(ROOT, outJson), JSON.stringify(manifest, null, 2) + "\n");
writeFileSync(path.join(ROOT, outMd), renderMarkdown(manifest));

console.log(`release:evidence passed. Wrote ${outJson} (stableHash ${stableHash.slice(0, 16)}…).`);

// ---------------------------------------------------------------------------

function renderMarkdown(m) {
  const lines = [];
  lines.push(`# SupaDiff v${m.version} — release evidence`);
  lines.push("");
  lines.push(`Stable content hash: \`${m.stableHash}\``);
  lines.push(`Release-inputs digest: \`${m.releaseInputsDigest}\``);
  lines.push("");
  lines.push("This manifest is produced from the repository working tree by");
  lines.push("`pnpm release:evidence` and re-verified on every run. No secrets, no");
  lines.push("fake-target result presented as real Supabase/Supalite evidence.");
  lines.push("");
  lines.push(
    "**Release revision.** This file records no commit SHA: committing it changes `HEAD`, so no",
  );
  lines.push(
    "hash written here could be the final release commit. The authoritative v1.0.0 revision is the",
  );
  lines.push(
    `commit the \`v1.0.0\` git tag and GitHub Release point to. Generation-time provenance ` +
      `(branch \`${m.provenance.generatedOnBranch ?? "—"}\`, working tree ` +
      `${m.provenance.workingTreeDirtyAtGeneration ? "dirty" : "clean"} at ` +
      `${m.provenance.generatedAt}) is non-canonical and excluded from the stable hash.`,
  );
  lines.push("");
  lines.push("## Toolchain / pinned versions");
  lines.push("");
  for (const [k, v] of Object.entries(m.toolchain)) lines.push(`- \`${k}\`: ${v ?? "—"}`);
  lines.push("");
  lines.push("## Pinned supabase-local images");
  lines.push("");
  for (const [k, v] of Object.entries(m.pinnedImages)) lines.push(`- \`${k}\`: \`${v}\``);
  lines.push("");
  lines.push("## Target capability matrix");
  lines.push("");
  for (const [kind, t] of Object.entries(m.targets)) {
    lines.push(`### \`${kind}\` — ${t.driver}`);
    lines.push(`_${t.transport}_`);
    lines.push("");
    if (t.capabilities.length === 0) {
      lines.push("- (no capabilities — test infrastructure only)");
    } else {
      for (const c of t.capabilities) lines.push(`- \`${c.id}\` → **${c.level}**`);
    }
    lines.push("");
  }
  lines.push("## Active divergence registry");
  lines.push("");
  for (const d of m.divergences) {
    lines.push(`- \`${d.id}\` (${d.status}) — ${d.title}`);
  }
  lines.push("");
  lines.push("## Acceptance gates — recorded results");
  lines.push("");
  lines.push(
    "Each result below was produced by `pnpm release:acceptance` executing the exact command",
  );
  lines.push("shown and recording its real exit code + a sanitized copy of the full output as a");
  lines.push("content-addressed artifact. `pnpm release:evidence` re-verifies every digest.");
  lines.push("");
  for (const r of m.acceptanceResults) {
    lines.push(`### \`${r.command}\` (${r.id})`);
    lines.push("");
    lines.push(`- result: **${r.status}** (exit ${r.exitCode}, executed: ${r.executed})`);
    lines.push(`- target identity: ${r.targetIdentity ?? "—"}`);
    lines.push(`- evidence artifact: \`${r.artifact}\``);
    lines.push(`- artifact digest: \`${r.artifactSha256}\``);
    if (r.notes && r.notes.length) lines.push(`- notes: ${r.notes.join("; ")}`);
    lines.push(`- limitations: ${r.limitations}`);
    lines.push("");
  }
  lines.push("## Explicit unproven / unsupported surfaces");
  lines.push("");
  for (const u of m.unprovenSurfaces) lines.push(`- ${u}`);
  lines.push("");
  lines.push("## Scenario fixtures");
  lines.push("");
  for (const s of m.scenarios) lines.push(`- \`${s.file}\` — \`${s.id}\` · digest \`${s.digest}\``);
  lines.push("");
  return lines.join("\n");
}
