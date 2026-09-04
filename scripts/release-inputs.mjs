// Shared release-evidence inputs (L14).
//
// The single source of truth for the *stable, content-addressed* facts a SupaDiff release
// is evidence about: exact tool/target versions, the pinned supabase-local images, the
// per-target capability matrix (straight from the driver `declare*Capabilities()`), the
// active divergence registry, and the scenario-fixture digests. Both the release-evidence
// manifest gate (`release-evidence.mjs`) and the acceptance recorder (`release-acceptance.mjs`)
// derive from this exact object so a recorded acceptance result can be checked for staleness
// against the release inputs without either script re-implementing the collection.

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";

export const ROOT = path.resolve(import.meta.dirname, "..");

const read = (p) => readFileSync(path.join(ROOT, p), "utf8");
const readJson = (p) => JSON.parse(read(p));

export function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v ?? null);
}

export function sha256(s) {
  return "sha256:" + createHash("sha256").update(s).digest("hex");
}

export function sha256File(absPath) {
  return "sha256:" + createHash("sha256").update(readFileSync(absPath)).digest("hex");
}

function distPath(pkg) {
  const p = path.join(ROOT, "packages", pkg, "dist", "index.js");
  if (!existsSync(p)) throw new Error(`${pkg} not built (run \`pnpm build\`)`);
  return p;
}

/**
 * Collect the stable release inputs from the working tree + built `dist/`.
 * @returns {Promise<{ inputs: object, errors: string[] }>}
 */
export async function collectReleaseInputs() {
  /** @type {string[]} */
  const errors = [];
  const rootPkg = readJson("package.json");
  const targetsPkg = readJson("packages/targets/package.json");

  const targetsMod = await import(distPath("targets"));
  const specMod = await import(distPath("spec"));

  const cliPkg = targetsMod.SUPABASE_CLI_PACKAGE ?? {};
  const pinnedImages = targetsMod.SUPABASE_LOCAL_PINNED_IMAGES ?? {};

  const devDep = (name) => rootPkg.devDependencies?.[name] ?? null;

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

  const capMatrix = (caps) =>
    caps
      .map((c) => ({
        id: c.id,
        level: c.level,
        evidenceKinds: (c.evidence ?? []).map((e) => e.kind),
      }))
      .sort((a, b) => a.id.localeCompare(b.id));

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

  const divergences = [];
  const divDir = path.join(ROOT, "divergences", "active");
  for (const f of readdirSync(divDir)
    .filter((n) => n.endsWith(".json"))
    .sort()) {
    let entry;
    try {
      entry = specMod.parseKnownDivergence(JSON.parse(readFileSync(path.join(divDir, f), "utf8")));
    } catch (e) {
      errors.push(`divergences/active/${f} does not parse: ${String(e)}`);
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

  const scenarios = [];
  const scnDir = path.join(ROOT, "scenarios", "deterministic");
  for (const f of readdirSync(scnDir)
    .filter((n) => n.endsWith(".json"))
    .sort()) {
    try {
      const spec = specMod.parseScenarioSpec(
        JSON.parse(readFileSync(path.join(scnDir, f), "utf8")),
      );
      scenarios.push({
        file: `scenarios/deterministic/${f}`,
        id: spec.id,
        digest: specMod.computeScenarioDigest(spec),
      });
    } catch (e) {
      errors.push(`scenarios/deterministic/${f} does not parse: ${String(e)}`);
    }
  }

  const inputs = {
    version: rootPkg.version,
    toolchain,
    pinnedImages,
    targets,
    divergences,
    scenarios,
  };

  return { inputs, errors, modules: { targetsMod, specMod }, rootPkg };
}

/** Content digest of the stable release inputs — the anchor for acceptance-result staleness. */
export function releaseInputsDigest(inputs) {
  return sha256(canonical(inputs));
}
