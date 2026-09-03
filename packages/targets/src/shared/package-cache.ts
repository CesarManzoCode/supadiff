import { existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnManaged } from "./process.js";

/**
 * `@supabase/lite@0.9.0` pinned exactly, per the sprint's version/evidence rules — never
 * a floating dist-tag (§4.4: "Floating dist-tags are rejected in canonical target
 * recipes"). Integrity/shasum recorded here are what `TargetIdentity.packageIntegrity`
 * reports; they were read directly from the published npm registry entry for this
 * exact version, not invented.
 */
export const SUPALITE_PACKAGE = {
  name: "@supabase/lite",
  version: "0.9.0",
  integrity:
    "sha512-fpSWL9qZOqAnQmw+z1g2SEjjEKsNq/HQP9JGwX2vXJh7L32qu/zpR1kWkPUv4QFwKUtB8ShHyW7sZ3A91lpHpA==",
  npmShasum: "a0c1309f62ebdc9787e784799f2aa38a8e57ce0d",
} as const;

export const SUPABASE_JS_PACKAGE = {
  name: "@supabase/supabase-js",
  version: "2.97.0",
  integrity:
    "sha512-kTD91rZNO4LvRUHv4x3/4hNmsEd2ofkYhuba2VMUPRVef1RCmnHtm7rIws38Fg0yQnOSZOplQzafn0GSiy6GVg==",
} as const;

export const POSTGRES_JS_PACKAGE = {
  name: "postgres",
  version: "3.4.8",
  integrity:
    "sha512-d+JFcLM17njZaOLkv6SCev7uoLaBtfK86vMUXhW1Z4glPWh4jozno9APvW/XKFJ3CCxVoC7OL38BqRydtu5nGg==",
} as const;

const CACHE_ROOT_ENV = "SUPADIFF_SUPALITE_PACKAGE_CACHE";
let installPromise: Promise<string> | undefined;

function cacheRoot(): string {
  return process.env[CACHE_ROOT_ENV] ?? path.join(tmpdir(), "supadiff-supalite-pkg-cache");
}

/**
 * Installs the exact pinned `@supabase/lite` + peer packages exactly once per process
 * into a single shared directory, then every provisioned target workdir symlinks that
 * `node_modules` in rather than re-running `npm install` per run. This keeps package
 * identity byte-for-byte pinned (one real install, exact `package-lock.json`) while
 * avoiding a multi-second install cost on every target provision — each workdir still
 * gets its own project files, database, and process; only third-party code is shared,
 * exactly like a local npm/pnpm store would be.
 */
export async function ensureSupaliteInstall(): Promise<string> {
  if (installPromise) return installPromise;
  installPromise = (async () => {
    const dir = cacheRoot();
    const sentinel = path.join(dir, ".install-complete");
    if (existsSync(sentinel) && existsSync(path.join(dir, "node_modules", "@supabase", "lite"))) {
      return dir;
    }
    mkdirSync(dir, { recursive: true });
    const pkgJson = {
      name: "supadiff-supalite-package-cache",
      private: true,
      version: "0.0.0",
      dependencies: {
        [SUPALITE_PACKAGE.name]: SUPALITE_PACKAGE.version,
        [SUPABASE_JS_PACKAGE.name]: SUPABASE_JS_PACKAGE.version,
        [POSTGRES_JS_PACKAGE.name]: POSTGRES_JS_PACKAGE.version,
      },
    };
    writeFileSync(path.join(dir, "package.json"), JSON.stringify(pkgJson, null, 2));
    const proc = spawnManaged("npm", ["install", "--no-audit", "--no-fund", "--loglevel=error"], {
      cwd: dir,
      env: process.env,
    });
    const result = await proc.waitForExit();
    if (result.code !== 0) {
      throw new Error(
        `ensureSupaliteInstall: "npm install" failed in ${dir} (exit ${result.code}):\n${proc.stderr()}`,
      );
    }
    writeFileSync(sentinel, new Date().toISOString());
    return dir;
  })();
  return installPromise;
}

/** Symlinks the shared cache's `node_modules` into a fresh per-run workdir. */
export async function linkSupaliteInstall(workdirPath: string): Promise<void> {
  const cacheDir = await ensureSupaliteInstall();
  const target = path.join(cacheDir, "node_modules");
  const link = path.join(workdirPath, "node_modules");
  symlinkSync(target, link, "dir");
}
