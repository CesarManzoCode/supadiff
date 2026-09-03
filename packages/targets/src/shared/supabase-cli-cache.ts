import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnManaged } from "./process.js";

/**
 * The `supabase` CLI, pinned exactly (§4.4: "Floating dist-tags are rejected in canonical
 * target recipes"). The CLI release is the *reproducibility anchor* for the whole
 * `supabase-local` stack: a given CLI version hard-codes the exact service image tags it
 * brings up (Postgres, GoTrue, PostgREST, Storage API, Kong), so pinning the CLI pins the
 * container set. `integrity`/`npmShasum` were read from the published npm registry entry
 * for this exact version this sprint, not invented; `TargetIdentity.cliVersion` reports
 * the version the CLI itself prints at runtime, and `containerDigests` records the real
 * `sha256:` image digests observed after `supabase start`.
 */
export const SUPABASE_CLI_PACKAGE = {
  name: "supabase",
  version: "2.116.0",
  integrity:
    "sha512-cMUHkpjBacq4oLGWnMM2HC2drmUlAlfN/PQb31RARoIdYJ8sqA0xONvqBR6yd5v7w8dXuCPwvfd4N1NTHjBKEw==",
  npmShasum: "f3628bddff4aed857dba5bea5211908a39c16e03",
} as const;

/**
 * The service container image tags CLI 2.116.0 provisions, recorded from a real
 * `supabase start` this sprint (see `docs/TARGETS.md`). These are informational — the
 * driver never passes them to Docker itself, the CLI does — but they are what makes the
 * "reproducibly pinned" claim checkable: a different CLI version would print a different
 * set here and `TargetIdentity.serviceVersions` would change accordingly.
 */
export const SUPABASE_LOCAL_PINNED_IMAGES = {
  postgres: "public.ecr.aws/supabase/postgres:17.6.1.165",
  gotrue: "public.ecr.aws/supabase/gotrue:v2.196.0",
  postgrest: "public.ecr.aws/supabase/postgrest:v16.1",
  "storage-api": "public.ecr.aws/supabase/storage-api:v1.70.3",
  kong: "public.ecr.aws/supabase/kong:2.8.1",
} as const;

const CACHE_ROOT_ENV = "SUPADIFF_SUPABASE_CLI_CACHE";
const installPromises = new Map<string, Promise<string>>();

function cacheRoot(version: string): string {
  const base = process.env[CACHE_ROOT_ENV] ?? path.join(tmpdir(), "supadiff-supabase-cli-cache");
  return path.join(base, version);
}

/** Absolute path to the pinned CLI's executable inside a resolved cache dir. */
export function supabaseCliBin(cacheDir: string): string {
  return path.join(cacheDir, "node_modules", ".bin", "supabase");
}

/**
 * Installs the exact pinned `supabase` npm package once per (process, version) into a
 * shared cache dir and returns that dir. The npm package's `postinstall` downloads the
 * matching Go binary for the host platform; that download is the only network dependency
 * and is cached on disk across runs by the sentinel check.
 */
export async function ensureSupabaseCli(
  version: string = SUPABASE_CLI_PACKAGE.version,
): Promise<string> {
  const existing = installPromises.get(version);
  if (existing) return existing;
  const p = (async () => {
    const dir = cacheRoot(version);
    const sentinel = path.join(dir, ".install-complete");
    const bin = supabaseCliBin(dir);
    if (existsSync(sentinel) && existsSync(bin)) return dir;
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify(
        { name: "supadiff-supabase-cli-cache", private: true, version: "0.0.0" },
        null,
        2,
      ),
    );
    const proc = spawnManaged(
      "npm",
      [
        "install",
        "--no-audit",
        "--no-fund",
        "--loglevel=error",
        `${SUPABASE_CLI_PACKAGE.name}@${version}`,
      ],
      { cwd: dir, env: process.env },
    );
    const result = await proc.waitForExit();
    if (result.code !== 0) {
      throw new Error(
        `ensureSupabaseCli: "npm install supabase@${version}" failed in ${dir} (exit ${result.code}):\n${proc.stderr()}`,
      );
    }
    writeFileSync(sentinel, new Date().toISOString());
    return dir;
  })();
  installPromises.set(version, p);
  return p;
}
