import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { createClient as CreateClientFn } from "@supabase/supabase-js";
import {
  DEFAULT_SUPALITE_PROFILE,
  SUPALITE_PROFILE_0_9_0,
  type SupalitePackageProfile,
} from "../supalite/package-profile.js";
import { DEFAULT_SUPABASE_JS_CLIENT, type SupabaseJsClientProfile } from "./supabase-js-client.js";
import { spawnManaged } from "./process.js";

/**
 * Backwards-compatible views of the v1.0.0 baseline profile's pinned identities. These are
 * the exact `@supabase/lite@0.9.0` + `@supabase/supabase-js@2.97.0` + `postgres@3.4.8`
 * constants v1.0.0 was closed against; per-version selection now lives in
 * `supalite/package-profile.ts`, but external consumers (and the L8 upgrade path, which is
 * inherently 0.9.0-only) still read these.
 */
export const SUPALITE_PACKAGE = {
  ...SUPALITE_PROFILE_0_9_0.lite,
} as const;

export const SUPABASE_JS_PACKAGE = {
  ...SUPALITE_PROFILE_0_9_0.client,
} as const;

export const POSTGRES_JS_PACKAGE = {
  ...SUPALITE_PROFILE_0_9_0.postgres,
} as const;

const CACHE_ROOT_ENV = "SUPADIFF_SUPALITE_PACKAGE_CACHE";

/**
 * One install promise per profile key. The old single global `installPromise` could not
 * represent more than one pinned version at a time — a 0.10.0 run would have silently
 * reused (or raced) the 0.9.0 install. Each profile now gets its own deterministic
 * subdirectory with its own `package.json`, `package-lock.json`, `node_modules` and
 * completion sentinel; nothing is ever shared across profiles.
 */
const installPromises = new Map<string, Promise<string>>();

function cacheRoot(): string {
  return process.env[CACHE_ROOT_ENV] ?? path.join(tmpdir(), "supadiff-supalite-pkg-cache");
}

/** Absolute path of a profile's isolated package cache directory. */
export function supaliteProfileCacheDir(profile: SupalitePackageProfile): string {
  return path.join(cacheRoot(), profile.key);
}

function readInstalledVersion(dir: string, pkgName: string): string | undefined {
  // Read the hoisted top-level install directly — `require.resolve("<pkg>/package.json")`
  // fails when the package's `exports` map does not expose `./package.json` (e.g.
  // `@supabase/lite`), which is exactly the identity we must verify.
  try {
    const pkgJsonPath = path.join(dir, "node_modules", ...pkgName.split("/"), "package.json");
    return (JSON.parse(readFileSync(pkgJsonPath, "utf8")) as { version?: string }).version;
  } catch {
    return undefined;
  }
}

/**
 * Installs a profile's exact pinned `@supabase/lite` + `@supabase/supabase-js` + `postgres`
 * once per process into that profile's own directory, then per-run workdirs symlink its
 * `node_modules` in rather than re-installing. After the install the *actually resolved*
 * `@supabase/lite` and `@supabase/supabase-js` versions are re-read from disk and checked
 * against the profile — a surprise resolution fails closed rather than running an
 * unpinned combination.
 */
export async function ensureSupaliteInstall(
  profile: SupalitePackageProfile = DEFAULT_SUPALITE_PROFILE,
): Promise<string> {
  const cached = installPromises.get(profile.key);
  if (cached) return cached;
  const promise = (async () => {
    const dir = supaliteProfileCacheDir(profile);
    const sentinel = path.join(dir, ".install-complete");
    const liteInstalled = path.join(dir, "node_modules", "@supabase", "lite");
    if (!(existsSync(sentinel) && existsSync(liteInstalled))) {
      mkdirSync(dir, { recursive: true });
      const pkgJson = {
        name: `supadiff-supalite-package-cache-${profile.key}`,
        private: true,
        version: "0.0.0",
        dependencies: {
          [profile.lite.name]: profile.lite.version,
          [profile.client.name]: profile.client.version,
          [profile.postgres.name]: profile.postgres.version,
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
          `ensureSupaliteInstall(${profile.key}): "npm install" failed in ${dir} ` +
            `(exit ${result.code}):\n${proc.stderr()}`,
        );
      }
      writeFileSync(sentinel, new Date().toISOString());
    }

    const liteVersion = readInstalledVersion(dir, "@supabase/lite");
    const clientVersion = readInstalledVersion(dir, "@supabase/supabase-js");
    if (liteVersion !== profile.lite.version) {
      throw new Error(
        `ensureSupaliteInstall(${profile.key}): resolved @supabase/lite@${String(liteVersion)}, ` +
          `expected exactly ${profile.lite.version}.`,
      );
    }
    if (clientVersion !== profile.client.version) {
      throw new Error(
        `ensureSupaliteInstall(${profile.key}): resolved @supabase/supabase-js@` +
          `${String(clientVersion)}, expected exactly ${profile.client.version}.`,
      );
    }
    return dir;
  })();
  installPromises.set(profile.key, promise);
  return promise;
}

/** Symlinks a profile's shared cache `node_modules` into a fresh per-run workdir. */
export async function linkSupaliteInstall(
  workdirPath: string,
  profile: SupalitePackageProfile = DEFAULT_SUPALITE_PROFILE,
): Promise<void> {
  const cacheDir = await ensureSupaliteInstall(profile);
  const target = path.join(cacheDir, "node_modules");
  const link = path.join(workdirPath, "node_modules");
  symlinkSync(target, link, "dir");
}

export interface LoadedSupabaseClientFactory {
  createClient: typeof CreateClientFn;
  /** The `@supabase/supabase-js` version actually loaded (asserted equal to the profile). */
  version: string;
}

/**
 * Dynamically loads `@supabase/supabase-js` *from the profile's own install* so the client
 * driving a target is the exact version paired with that `@supabase/lite` build — a 0.10.0
 * run genuinely uses `@supabase/supabase-js@2.114.0`, not the driver package's own
 * dependency. For the 0.9.0 profile this resolves to the same 2.97.0 tarball the driver
 * package already depends on, so the baseline is behaviorally unchanged.
 */
export async function loadSupabaseJsForProfile(
  profile: SupalitePackageProfile = DEFAULT_SUPALITE_PROFILE,
): Promise<LoadedSupabaseClientFactory> {
  const dir = await ensureSupaliteInstall(profile);
  const req = createRequire(path.join(dir, "index.cjs"));
  const entry = req.resolve("@supabase/supabase-js");
  const mod = (await import(pathToFileURL(entry).href)) as {
    createClient?: typeof CreateClientFn;
    default?: { createClient?: typeof CreateClientFn };
  };
  const createClient = mod.createClient ?? mod.default?.createClient;
  if (typeof createClient !== "function") {
    throw new Error(
      `loadSupabaseJsForProfile(${profile.key}): @supabase/supabase-js at ${entry} exposed no createClient`,
    );
  }
  const version = readInstalledVersion(dir, "@supabase/supabase-js");
  if (version !== profile.client.version) {
    throw new Error(
      `loadSupabaseJsForProfile(${profile.key}): loaded @supabase/supabase-js@${String(version)}, ` +
        `expected ${profile.client.version}.`,
    );
  }
  return { createClient, version };
}

/** Absolute path of a standalone `@supabase/supabase-js` client cache directory. */
export function supabaseJsClientCacheDir(client: SupabaseJsClientProfile): string {
  return path.join(cacheRoot(), client.key);
}

/**
 * Installs a standalone, exactly-pinned `@supabase/supabase-js` build once per process
 * into its own cache directory (no `@supabase/lite`, no `postgres` — just the client), so a
 * driver that is NOT Supalite (notably `supabase-local`) can drive its target through the
 * exact client version the scenario's `ScenarioSpec.client` asks for rather than whatever
 * the driver package statically depends on. The resolved version is re-read from disk and
 * asserted against the profile; a surprise resolution fails closed.
 *
 * For `2.97.0` this installs the same tarball the driver package already depends on, so the
 * baseline is behaviorally unchanged.
 */
export async function ensureSupabaseJsInstall(
  client: SupabaseJsClientProfile = DEFAULT_SUPABASE_JS_CLIENT,
): Promise<string> {
  const cached = installPromises.get(client.key);
  if (cached) return cached;
  const promise = (async () => {
    const dir = supabaseJsClientCacheDir(client);
    const sentinel = path.join(dir, ".install-complete");
    const installed = path.join(dir, "node_modules", "@supabase", "supabase-js");
    if (!(existsSync(sentinel) && existsSync(installed))) {
      mkdirSync(dir, { recursive: true });
      const pkgJson = {
        name: `supadiff-${client.key}`,
        private: true,
        version: "0.0.0",
        dependencies: { [client.name]: client.version },
      };
      writeFileSync(path.join(dir, "package.json"), JSON.stringify(pkgJson, null, 2));
      const proc = spawnManaged("npm", ["install", "--no-audit", "--no-fund", "--loglevel=error"], {
        cwd: dir,
        env: process.env,
      });
      const result = await proc.waitForExit();
      if (result.code !== 0) {
        throw new Error(
          `ensureSupabaseJsInstall(${client.key}): "npm install" failed in ${dir} ` +
            `(exit ${result.code}):\n${proc.stderr()}`,
        );
      }
      writeFileSync(sentinel, new Date().toISOString());
    }
    const version = readInstalledVersion(dir, "@supabase/supabase-js");
    if (version !== client.version) {
      throw new Error(
        `ensureSupabaseJsInstall(${client.key}): resolved @supabase/supabase-js@${String(version)}, ` +
          `expected exactly ${client.version}.`,
      );
    }
    return dir;
  })();
  installPromises.set(client.key, promise);
  return promise;
}

/**
 * Ensures the standalone client install and dynamically loads its `createClient`. The
 * returned `version` is guaranteed equal to `client.version` — a driver reports it verbatim
 * as `TargetIdentity.clientVersion`.
 */
export async function loadSupabaseJs(
  client: SupabaseJsClientProfile = DEFAULT_SUPABASE_JS_CLIENT,
): Promise<LoadedSupabaseClientFactory> {
  const dir = await ensureSupabaseJsInstall(client);
  const req = createRequire(path.join(dir, "index.cjs"));
  const entry = req.resolve("@supabase/supabase-js");
  const mod = (await import(pathToFileURL(entry).href)) as {
    createClient?: typeof CreateClientFn;
    default?: { createClient?: typeof CreateClientFn };
  };
  const createClient = mod.createClient ?? mod.default?.createClient;
  if (typeof createClient !== "function") {
    throw new Error(
      `loadSupabaseJs(${client.key}): @supabase/supabase-js at ${entry} exposed no createClient`,
    );
  }
  const version = readInstalledVersion(dir, "@supabase/supabase-js");
  if (version !== client.version) {
    throw new Error(
      `loadSupabaseJs(${client.key}): loaded @supabase/supabase-js@${String(version)}, ` +
        `expected ${client.version}.`,
    );
  }
  return { createClient, version };
}
