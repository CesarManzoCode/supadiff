#!/usr/bin/env node
// L14 release-evidence gate (`pnpm release:evidence`).
//
// Produces the versioned, self-verifying release-evidence manifest for SupaDiff from the
// *actual* repository state — exact tool/target versions, the per-target capability matrix
// (straight from the driver `declare*Capabilities()` functions), the active divergence
// registry, the acceptance-gate command list, and the explicit unproven surfaces. It then
// checks a set of invariants (version consistency, no secret material, every cited
// acceptance command exists, every capability carries evidence, no fake-target result
// presented as real Supabase/Supalite evidence) and, if a manifest for this version is
// already committed, refuses to let its stable content drift silently.

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, existsSync, writeFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import process from "node:process";

const ROOT = path.resolve(import.meta.dirname, "..");
const read = (p) => readFileSync(path.join(ROOT, p), "utf8");
const readJson = (p) => JSON.parse(read(p));

/** @type {string[]} */
const errors = [];
const fail = (m) => errors.push(m);

const rootPkg = readJson("package.json");
const VERSION = rootPkg.version;

// ---------------------------------------------------------------------------
// Toolchain + pinned target versions (from the files that actually pin them)
// ---------------------------------------------------------------------------

const targetsPkg = readJson("packages/targets/package.json");

let targetsMod;
let specMod;
try {
  targetsMod = await import(distPath("targets"));
  specMod = await import(distPath("spec"));
} catch (e) {
  console.error(`release:evidence: build the workspace first (\`pnpm build\`): ${String(e)}`);
  process.exit(1);
}

const pinnedImages = targetsMod.SUPABASE_LOCAL_PINNED_IMAGES ?? {};
const cliPkg = targetsMod.SUPABASE_CLI_PACKAGE ?? {};

const toolchain = {
  node: rootPkg.engines?.node ?? null,
  packageManager: rootPkg.packageManager ?? null,
  typescript: devDep("typescript"),
  vitest: devDep("vitest"),
  supabaseCli: cliPkg.version ?? null,
  "@supabase/lite": targetsPkg.dependencies?.["@supabase/lite"] ?? null,
  "@supabase/supabase-js": targetsPkg.dependencies?.["@supabase/supabase-js"] ?? null,
  postgres: targetsPkg.dependencies?.["postgres"] ?? null,
  "fast-check": readJson("packages/generators/package.json").dependencies?.["fast-check"] ?? null,
};

// ---------------------------------------------------------------------------
// Capability matrix (real, from the driver declarations)
// ---------------------------------------------------------------------------

function capMatrix(caps) {
  return caps
    .map((c) => ({
      id: c.id,
      level: c.level,
      evidenceKinds: (c.evidence ?? []).map((e) => e.kind),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

const targets = {
  "supabase-hosted": {
    driver: "real",
    transport: "public API + Supabase Management API",
    optIn: "SUPADIFF_HOSTED=1 + spec.safety.allowHosted",
    capabilities: capMatrix(targetsMod.declareSupabaseHostedCapabilities()),
  },
  "supabase-local": {
    driver: "real",
    transport: `pinned supabase CLI ${cliPkg.version} over Docker Compose`,
    capabilities: capMatrix(targetsMod.declareSupabaseLocalCapabilities()),
  },
  "supalite-sqlite": {
    driver: "real",
    transport: "real @supabase/lite@0.9.0 lite start subprocess",
    capabilities: capMatrix(targetsMod.declareSupaliteCapabilities("supalite-sqlite")),
  },
  "supalite-sqlite-postgres": {
    driver: "real",
    transport: "real @supabase/lite@0.9.0 lite start subprocess",
    capabilities: capMatrix(targetsMod.declareSupaliteCapabilities("supalite-sqlite-postgres")),
  },
  "supalite-pglite": {
    driver: "real",
    transport: "real @supabase/lite@0.9.0 lite start subprocess",
    capabilities: capMatrix(targetsMod.declareSupaliteCapabilities("supalite-pglite")),
  },
  "supalite-postgres": {
    driver: "real",
    transport: "real @supabase/lite@0.9.0 lite start subprocess + local PostgreSQL",
    capabilities: capMatrix(targetsMod.declareSupaliteCapabilities("supalite-postgres")),
  },
  fake: {
    driver: "test-infrastructure-only",
    transport: "scripted FakeTargetDriver — NEVER evidence about Supabase or Supalite (§15.2)",
    capabilities: [],
  },
};

// ---------------------------------------------------------------------------
// Divergence registry (real, parsed)
// ---------------------------------------------------------------------------

const divDir = path.join(ROOT, "divergences", "active");
const divergences = [];
for (const f of readdirSync(divDir)
  .filter((n) => n.endsWith(".json"))
  .sort()) {
  let entry;
  try {
    entry = specMod.parseKnownDivergence(JSON.parse(readFileSync(path.join(divDir, f), "utf8")));
  } catch (e) {
    fail(`divergences/active/${f} does not parse: ${String(e)}`);
    continue;
  }
  divergences.push({
    id: entry.id,
    title: entry.title,
    status: entry.status,
    reference: entry.referenceSelector,
    candidate: entry.candidateSelector,
    scenario: entry.scenarioSelector,
    observable: entry.observableSelector,
    verifiedAt: entry.verifiedAt ?? null,
    expiresAt: entry.expiresAt ?? null,
  });
}

// ---------------------------------------------------------------------------
// Acceptance gates (the commands that actually prove each layer)
// ---------------------------------------------------------------------------

const acceptanceGates = [
  {
    id: "core",
    command: "pnpm check",
    proves: "L0-L5 deterministic core + boundary/lint/build/typecheck/format/unit",
  },
  {
    id: "L6",
    command: "pnpm test:integration:supalite",
    proves: "real Supalite family, all four backends",
  },
  {
    id: "L7",
    command: "pnpm test:integration:peer-data-auth-rls",
    proves: "Supalite ↔ supabase-local Data + Auth + native RLS + failure modes",
  },
  {
    id: "L8",
    command: "pnpm test:integration:upgrade-local",
    proves: "real Supalite → lite upgrade --target local → supabase-local verification",
  },
  {
    id: "L9",
    command: "pnpm test:fault-lab:replay",
    proves: "dogfood fault lab + supadiff replay",
  },
  { id: "L10", command: "pnpm test:fault-lab:reduce", proves: "state-aware reducer / ddmin" },
  {
    id: "L11",
    command: "pnpm test:integration:peer-storage",
    proves: "Storage byte-identity peer comparison (Supalite×2 and Supalite ↔ supabase-local)",
  },
  { id: "L12", command: "pnpm test:generators", proves: "seeded scenario generation domain model" },
  {
    id: "L12-smoke",
    command: "pnpm test:generated-smoke",
    proves: "one generated scenario executed live",
  },
  {
    id: "L13",
    command: "SUPADIFF_HOSTED=1 pnpm test:integration:hosted-smoke",
    proves:
      "real hosted Supabase project: Data + Auth + RLS end to end, opt-in/budget refusals, deterministic cleanup + crash recovery",
  },
  {
    id: "L14-docs",
    command: "pnpm docs:verify",
    proves: "documentation ↔ implementation ↔ acceptance-command consistency",
  },
  {
    id: "L14-evidence",
    command: "pnpm release:evidence",
    proves: "this manifest — versioned, secret-free, invariant-checked",
  },
];

// ---------------------------------------------------------------------------
// Explicit unsupported / unproven surfaces
// ---------------------------------------------------------------------------

const unprovenSurfaces = [
  "Realtime, Edge Functions, and any dashboard/UI — never in scope (Architecture Contract §20).",
  "supabase-hosted `create-ephemeral` attach mode: implemented and safety-gated, but not exercised against a real org in CI (requires SUPADIFF_HOSTED_ORG_ID + billing). Only `attach-explicit` has a passing real acceptance gate.",
  "Hosted `lite upgrade --target hosted` transitions are not exercised (L8 covers `--target local` only).",
  "supabase-hosted `auth.signUp` uses the real GoTrue admin API + real password grant (not the public mailer flow) because the dedicated smoke project has no SMTP and the project-scoped token cannot toggle mailer autoconfirm — see docs/adr/0003-hosted-signup-via-admin-api.md.",
  "The L10 reducer and L12 generator are scoped to SupaDiff's own Data+Auth+RLS domain model, not general-purpose tools.",
  "Storage byte preservation across `lite upgrade` is `unsupported` and is rejected before any mutation when required (not silently skipped).",
];

// ---------------------------------------------------------------------------
// Scenario fixtures (with digests)
// ---------------------------------------------------------------------------

const scenarios = [];
const scnDir = path.join(ROOT, "scenarios", "deterministic");
for (const f of readdirSync(scnDir)
  .filter((n) => n.endsWith(".json"))
  .sort()) {
  try {
    const spec = specMod.parseScenarioSpec(JSON.parse(readFileSync(path.join(scnDir, f), "utf8")));
    scenarios.push({
      file: `scenarios/deterministic/${f}`,
      id: spec.id,
      digest: specMod.computeScenarioDigest(spec),
    });
  } catch (e) {
    fail(`scenarios/deterministic/${f} does not parse: ${String(e)}`);
  }
}

// ---------------------------------------------------------------------------
// Assemble + stable hash
// ---------------------------------------------------------------------------

const stable = {
  version: VERSION,
  toolchain,
  pinnedImages,
  targets,
  divergences,
  acceptanceGates,
  unprovenSurfaces,
  scenarios,
};

const stableHash = sha256(canonical(stable));

let git = {};
try {
  git = {
    commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT }).toString().trim(),
    branch: execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: ROOT })
      .toString()
      .trim(),
    dirty:
      execFileSync("git", ["status", "--porcelain"], { cwd: ROOT }).toString().trim().length > 0,
  };
} catch {
  git = { commit: null, branch: null, dirty: null };
}

const manifest = {
  format: "supadiff.release-evidence",
  formatVersion: "1.0",
  ...stable,
  stableHash,
  git,
  generatedAt: new Date().toISOString(),
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

for (const [kind, t] of Object.entries(targets)) {
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
if (divergences.length === 0) fail("no divergence registry entries found");

// No secret material anywhere in the manifest.
const asText = JSON.stringify(manifest);
for (const re of [
  /\bsbp_[A-Za-z0-9]{20,}/,
  /\bsb_secret_[A-Za-z0-9]{10,}/,
  /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/,
]) {
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

function devDep(name) {
  return rootPkg.devDependencies?.[name] ?? null;
}
function distPath(pkg) {
  const p = path.join(ROOT, "packages", pkg, "dist", "index.js");
  if (!existsSync(p)) throw new Error(`${pkg} not built`);
  return p;
}
function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v ?? null);
}
function sha256(s) {
  return "sha256:" + createHash("sha256").update(s).digest("hex");
}
function renderMarkdown(m) {
  const lines = [];
  lines.push(`# SupaDiff v${m.version} — release evidence`);
  lines.push("");
  lines.push(`Generated: ${m.generatedAt}${m.git.commit ? ` · commit \`${m.git.commit}\`` : ""}`);
  lines.push(`Stable content hash: \`${m.stableHash}\``);
  lines.push("");
  lines.push("This manifest is produced from the repository working tree by");
  lines.push("`pnpm release:evidence` and re-verified on every run. No secrets, no");
  lines.push("fake-target result presented as real Supabase/Supalite evidence.");
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
  lines.push("## Acceptance gates");
  lines.push("");
  for (const g of m.acceptanceGates) lines.push(`- \`${g.command}\` — ${g.proves}`);
  lines.push("");
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
