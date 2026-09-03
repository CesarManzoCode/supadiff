#!/usr/bin/env node
// Static package-boundary guard for the SupaDiff monorepo (Architecture Contract §13).
//
// This is not a lint style rule: it is the automated guard required by the contract's
// L0 acceptance criteria. It walks every package's `src/` tree, extracts static
// import/export specifiers, and rejects any specifier that violates the allowed-imports
// table in §13.2. It has no knowledge of runtime behavior; it only prevents forbidden
// static coupling from ever being introduced.

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const ROOT = path.resolve(import.meta.dirname, "..");
const PACKAGES_DIR = path.join(ROOT, "packages");

/**
 * @supadiff/<pkg> => which other @supadiff/<x> package roots it may statically import.
 * "engine/spi" is a distinct dependency-neutral entrypoint per §13.2 and is always
 * allowed wherever "engine" business logic is forbidden.
 */
const ALLOWED = {
  spec: [],
  engine: ["spec"],
  targets: ["spec", "engine/spi"],
  reducer: ["spec", "engine"],
  generators: ["spec"],
  cli: ["spec", "engine", "engine/spi", "targets", "reducer", "generators"],
};

const FORBIDDEN_NODE_BUILTINS_IN_SPEC = new Set([
  "fs",
  "node:fs",
  "net",
  "node:net",
  "http",
  "node:http",
  "https",
  "node:https",
  "child_process",
  "node:child_process",
  "dgram",
  "node:dgram",
]);

/** @returns {string[]} */
function listPackageDirs() {
  return readdirSync(PACKAGES_DIR).filter((name) => {
    const p = path.join(PACKAGES_DIR, name, "src");
    try {
      return statSync(p).isDirectory();
    } catch {
      return false;
    }
  });
}

/** @returns {string[]} absolute .ts file paths */
function walk(dir) {
  /** @type {string[]} */
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.isFile() && entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

const IMPORT_RE = /\b(?:import|export)\s+(?:[^'";]*?\sfrom\s*)?["']([^"']+)["']/g;
const DYNAMIC_IMPORT_RE = /\bimport\(\s*["']([^"']+)["']\s*\)/g;

/** @param {string} filePath */
function extractSpecifiers(filePath) {
  const src = readFileSync(filePath, "utf8");
  const specs = [];
  for (const m of src.matchAll(IMPORT_RE)) specs.push(m[1]);
  for (const m of src.matchAll(DYNAMIC_IMPORT_RE)) specs.push(m[1]);
  return specs;
}

/** @param {string} specifier @returns {{pkg: string, entrypoint: string} | null} */
function parseSupadiffSpecifier(specifier) {
  const m = /^@supadiff\/([a-z-]+)(\/(.+))?$/.exec(specifier);
  if (!m) return null;
  const pkg = m[1];
  const entrypoint = m[3] ? `${pkg}/${m[3]}` : pkg;
  return { pkg, entrypoint };
}

function main() {
  /** @type {string[]} */
  const violations = [];
  const pkgDirs = listPackageDirs();

  for (const pkgName of pkgDirs) {
    const allowedRoots = ALLOWED[pkgName];
    if (allowedRoots === undefined) {
      violations.push(`Unknown package "${pkgName}" has no boundary declared in §13.2 table.`);
      continue;
    }
    const srcDir = path.join(PACKAGES_DIR, pkgName, "src");
    for (const file of walk(srcDir)) {
      const rel = path.relative(ROOT, file);
      for (const spec of extractSpecifiers(file)) {
        const parsed = parseSupadiffSpecifier(spec);
        if (parsed) {
          const okAsRoot = allowedRoots.includes(parsed.pkg);
          const okAsEntry = allowedRoots.includes(parsed.entrypoint);
          const selfImport = parsed.pkg === pkgName;
          if (!selfImport && !okAsRoot && !okAsEntry) {
            violations.push(
              `${rel}: "@supadiff/${pkgName}" MUST NOT import "${spec}" ` +
                `(§13.2 allows: ${allowedRoots.length ? allowedRoots.map((r) => `@supadiff/${r}`).join(", ") : "none"}).`,
            );
          }
          // engine business logic must never be reached except through spi from targets/reducer boundary users.
          if (pkgName === "targets" && parsed.pkg === "engine" && parsed.entrypoint === "engine") {
            violations.push(
              `${rel}: "@supadiff/targets" MUST NOT import @supadiff/engine main entrypoint, ` +
                `only "@supadiff/engine/spi" (§13.2).`,
            );
          }
        }
        if (pkgName === "spec" && FORBIDDEN_NODE_BUILTINS_IN_SPEC.has(spec)) {
          violations.push(
            `${rel}: "@supadiff/spec" MUST NOT import Node process/fs/network builtin "${spec}" (§13.2).`,
          );
        }
      }
    }
  }

  if (violations.length > 0) {
    console.error("Package boundary violations found (Architecture Contract §13):\n");
    for (const v of violations) console.error(`  - ${v}`);
    console.error(`\n${violations.length} violation(s).`);
    process.exit(1);
  }
  console.log(`Boundary check passed: ${pkgDirs.length} packages scanned, 0 violations.`);
}

main();
