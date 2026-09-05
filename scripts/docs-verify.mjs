#!/usr/bin/env node
// L14 documentation-consistency gate (`pnpm docs:verify`).
//
// Verifies the *actual* repository state against every claim the prose makes, so the
// README / docs can never silently drift from the implementation, the acceptance
// commands, the capability declarations, or the divergence registry. No network, no
// build side effects — it only reads committed files and the built `dist/` of the two
// packages whose runtime data it cross-checks (`@supadiff/spec`, `@supadiff/targets`).

import { readdirSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const ROOT = path.resolve(import.meta.dirname, "..");
const rel = (p) => path.relative(ROOT, p);
const read = (p) => readFileSync(path.join(ROOT, p), "utf8");

/** @type {string[]} */
const errors = [];
const fail = (m) => errors.push(m);

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

const DOC_FILES = ["README.md", "CONTRIBUTING.md", "CHANGELOG.md"];
for (const d of walk(path.join(ROOT, "docs"))) {
  if (d.endsWith(".md")) DOC_FILES.push(rel(d));
}

const rootPkg = JSON.parse(read("package.json"));
const SCRIPTS = new Set(Object.keys(rootPkg.scripts ?? {}));
const CLI_COMMANDS = new Set(["run", "compare", "inspect", "replay", "reduce", "verify-upgrade"]);

// ---------------------------------------------------------------------------
// 1. Every repo-path reference in the docs resolves to a real file
// ---------------------------------------------------------------------------

const PATH_TOKEN = /(?:packages|docs|scripts|scenarios|divergences|test)\/[A-Za-z0-9_./*-]+/g;
const MD_LINK = /\]\(([^)]+)\)/g;

for (const file of DOC_FILES) {
  if (!existsSync(path.join(ROOT, file))) continue;
  const text = read(file);

  for (const m of text.matchAll(MD_LINK)) {
    let target = m[1].trim();
    if (/^(https?:|mailto:|#)/.test(target)) continue;
    target = target.split("#")[0];
    if (!target) continue;
    const resolved = target.startsWith("docs/") ? target : path.join(path.dirname(file), target);
    if (!existsSync(path.join(ROOT, resolved))) {
      fail(`${file}: markdown link "${m[1]}" -> ${resolved} does not exist`);
    }
  }

  for (const m of text.matchAll(PATH_TOKEN)) {
    const token = m[0].replace(/[.,)]+$/, "");
    if (token.includes("*")) continue; // globs / illustrative trees
    if (token.endsWith("/")) continue;
    const looksLikeFile = /\.[a-z0-9]+$/i.test(token) || /\/(bin|dist)\b/.test(token);
    if (!looksLikeFile) continue;
    if (!existsSync(path.join(ROOT, token))) {
      fail(`${file}: references "${token}" which does not exist in the repository`);
    }
  }
}

// ---------------------------------------------------------------------------
// 2. Every `pnpm <script>` / `supadiff <command>` the docs mention is real
// ---------------------------------------------------------------------------

const PNPM_REF = /`pnpm (?:run )?([a-z][a-z0-9:-]+)`/g;
const SUPADIFF_REF = /`supadiff ([a-z][a-z0-9-]+)/g;
const PNPM_IGNORE = new Set(["install", "run", "check", "build", "test", "lint", "setup", "link"]);

for (const file of DOC_FILES) {
  if (!existsSync(path.join(ROOT, file))) continue;
  const text = read(file);
  for (const m of text.matchAll(PNPM_REF)) {
    const name = m[1];
    if (PNPM_IGNORE.has(name)) continue;
    if (!SCRIPTS.has(name)) {
      fail(`${file}: cites \`pnpm ${name}\` but package.json has no such script`);
    }
  }
  for (const m of text.matchAll(SUPADIFF_REF)) {
    if (!CLI_COMMANDS.has(m[1])) {
      fail(`${file}: cites \`supadiff ${m[1]}\` but the CLI has no such command`);
    }
  }
}

// ---------------------------------------------------------------------------
// 3. No stale claim contradicting the current (L0-L14) implementation
// ---------------------------------------------------------------------------

const STALE = [
  "L13 (hosted target) and L14",
  "L13 (hosted target), L14",
  "parseTargetSpec still rejects `supabase-hosted`",
  "parseTargetSpec rejects `supabase-hosted`",
  "still rejects it with\n  `unsupported-target-kind`",
  "no hosted driver exists",
  "L13, not started",
  "L13 was out of scope",
  "L13 is not implemented",
  "no driver.** `parseTargetSpec`",
  "Hosted safety flags are parsed, not enforced",
  "layers **L0-L12**",
  "implements Implementation DAG layers **L0-L12**",
  "L13 and L14 are not\nimplemented",
  "(L13 — out of scope for this sprint",
];

for (const file of DOC_FILES) {
  if (!existsSync(path.join(ROOT, file))) continue;
  const text = read(file).replace(/\r\n/g, "\n");
  for (const phrase of STALE) {
    if (text.includes(phrase)) {
      fail(`${file}: contains a stale pre-L13/L14 claim: ${JSON.stringify(phrase)}`);
    }
  }
}

// A positive assertion: the docs must now describe L13 + L14.
const readme = read("README.md");
for (const needle of ["L13", "L14", "supabase-hosted", "docs:verify", "release:evidence"]) {
  if (!readme.includes(needle)) fail(`README.md: expected it to mention "${needle}"`);
}

// ---------------------------------------------------------------------------
// 4. Version consistency
// ---------------------------------------------------------------------------

const VERSION = rootPkg.version;
if (VERSION !== "1.0.0") fail(`root package.json version is "${VERSION}", expected "1.0.0"`);
for (const p of readdirSync(path.join(ROOT, "packages"))) {
  const pj = path.join("packages", p, "package.json");
  if (!existsSync(path.join(ROOT, pj))) continue;
  const v = JSON.parse(read(pj)).version;
  if (v !== VERSION) fail(`${pj} version "${v}" != root "${VERSION}"`);
}
if (!existsSync(path.join(ROOT, "CHANGELOG.md"))) {
  fail("CHANGELOG.md is missing");
} else if (!read("CHANGELOG.md").includes(VERSION)) {
  fail(`CHANGELOG.md does not mention the current version ${VERSION}`);
}
const evidenceFile = `release-evidence/v${VERSION}.json`;
if (!existsSync(path.join(ROOT, evidenceFile))) {
  fail(`${evidenceFile} is missing — run \`pnpm release:evidence\``);
}

// ---------------------------------------------------------------------------
// 5. Capability evidence: every declared capability carries real evidence,
//    and every target kind with a driver is documented in docs/TARGETS.md
// ---------------------------------------------------------------------------

let targetsMod;
let specMod;
try {
  targetsMod = await import(pathToDist("targets"));
  specMod = await import(pathToDist("spec"));
} catch (e) {
  fail(`could not import built dist (run \`pnpm build\` first): ${String(e)}`);
}

if (targetsMod) {
  const targetsDoc = read("docs/TARGETS.md");
  const capSets = {
    "supabase-hosted": targetsMod.declareSupabaseHostedCapabilities(),
    "supabase-local": targetsMod.declareSupabaseLocalCapabilities(),
    "supalite-sqlite-postgres": targetsMod.declareSupaliteCapabilities("supalite-sqlite-postgres"),
  };
  for (const [kind, caps] of Object.entries(capSets)) {
    if (!Array.isArray(caps) || caps.length === 0) {
      fail(`declare*Capabilities for ${kind} returned no entries`);
      continue;
    }
    for (const c of caps) {
      if (!Array.isArray(c.evidence) || c.evidence.length === 0) {
        fail(`${kind} capability "${c.id}" has no evidence`);
      }
    }
    if (!targetsDoc.includes(kind)) {
      fail(`docs/TARGETS.md does not mention target kind "${kind}"`);
    }
  }
}

// ---------------------------------------------------------------------------
// 6. Divergence evidence: every active entry parses and is documented
// ---------------------------------------------------------------------------

if (specMod) {
  const divDir = path.join(ROOT, "divergences", "active");
  // The divergence registry must be acknowledged by the divergence governance doc.
  const divDoc = read("docs/DIVERGENCES.md");
  if (!/parseKnownDivergence/.test(divDoc)) {
    fail("docs/DIVERGENCES.md no longer documents the known-divergence registry governance");
  }
  let divCount = 0;
  for (const f of readdirSync(divDir).filter((n) => n.endsWith(".json"))) {
    let entry;
    try {
      entry = specMod.parseKnownDivergence(JSON.parse(readFileSync(path.join(divDir, f), "utf8")));
    } catch (e) {
      fail(`divergences/active/${f} does not parse: ${String(e)}`);
      continue;
    }
    divCount++;
    if (!entry.evidence || entry.evidence.length === 0) {
      fail(`divergences/active/${f} has no evidence`);
    }
  }
  if (divCount === 0) fail("divergences/active/ has no parseable entries");
}

// ---------------------------------------------------------------------------
// 7. No secret material anywhere in the docs
// ---------------------------------------------------------------------------

const SECRET_PATTERNS = [
  /\bsbp_[A-Za-z0-9]{20,}/,
  /\bsb_secret_[A-Za-z0-9]{10,}/,
  /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/,
  /SUPADIFF_HOSTED_ACCESS_TOKEN\s*[=:]\s*["']?[A-Za-z0-9]/,
];
const envRef = process.env.SUPADIFF_HOSTED_PROJECT_REF;
for (const file of [...DOC_FILES, ...walkRel("scenarios"), ...walkRel("divergences")]) {
  if (!existsSync(path.join(ROOT, file))) continue;
  const text = read(file);
  for (const re of SECRET_PATTERNS) {
    if (re.test(text)) fail(`${file}: matches a secret pattern ${re}`);
  }
  if (envRef && envRef.length > 8 && text.includes(envRef)) {
    fail(`${file}: contains the live hosted project ref`);
  }
}

// ---------------------------------------------------------------------------

if (errors.length > 0) {
  console.error("docs:verify FAILED\n");
  for (const e of errors) console.error(`  - ${e}`);
  console.error(`\n${errors.length} problem(s).`);
  process.exit(1);
}
console.log(`docs:verify passed: ${DOC_FILES.length} doc files checked, 0 problems.`);

// ---------------------------------------------------------------------------

function walk(dir) {
  /** @type {string[]} */
  const out = [];
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}
function walkRel(dir) {
  return walk(path.join(ROOT, dir)).map(rel);
}
function pathToDist(pkg) {
  const p = path.join(ROOT, "packages", pkg, "dist", "index.js");
  if (!existsSync(p)) throw new Error(`${rel(p)} not built`);
  return p;
}
