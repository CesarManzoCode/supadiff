import { mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { ExactPackageIdentity, ExactRuntimeIdentity, StableId } from "@supadiff/spec";
import { leasePort } from "../shared/ports.js";
import { linkSupaliteInstall, SUPALITE_PACKAGE } from "../shared/package-cache.js";
import { spawnManaged, waitForHttpReady, type ManagedProcess } from "../shared/process.js";
import type { SupaliteBackend, SupaliteTargetConfig } from "./types.js";

export interface SupaliteProvisionedProject {
  readonly workdirPath: string;
  readonly backend: SupaliteBackend;
  readonly port: number;
  readonly baseUrl: string;
  readonly publishableKey: string;
  readonly secretKey: string;
  readonly config: SupaliteTargetConfig;
  process?: ManagedProcess;
}

const LITE_BIN = (workdirPath: string): string =>
  path.join(workdirPath, "node_modules", "@supabase", "lite", "dist", "cli", "index.js");

function runLite(
  workdirPath: string,
  args: string[],
  extraEnv: NodeJS.ProcessEnv = {},
): ReturnType<typeof spawnManaged> {
  return spawnManaged(process.execPath, [LITE_BIN(workdirPath), ...args], {
    cwd: workdirPath,
    env: { ...process.env, ...extraEnv, DO_NOT_TRACK: "1" },
  });
}

async function runLiteToCompletion(
  workdirPath: string,
  args: string[],
  extraEnv: NodeJS.ProcessEnv = {},
): Promise<{ stdout: string; stderr: string }> {
  const proc = runLite(workdirPath, args, extraEnv);
  const result = await proc.waitForExit();
  if (result.code !== 0) {
    throw new Error(
      `supalite: "lite ${args.join(" ")}" exited ${String(result.code)} in ${workdirPath}\n` +
        `stdout:\n${proc.stdout()}\nstderr:\n${proc.stderr()}`,
    );
  }
  return { stdout: proc.stdout(), stderr: proc.stderr() };
}

function parseGeneratedKeys(envFileText: string): { publishableKey: string; secretKey: string } {
  const publishable = /^SUPABASE_PUBLISHABLE_KEY=(.+)$/m.exec(envFileText)?.[1];
  const secret = /^SUPABASE_SECRET_KEY=(.+)$/m.exec(envFileText)?.[1];
  if (!publishable || !secret) {
    throw new Error("supalite: could not parse generated API keys from .env");
  }
  return { publishableKey: publishable, secretKey: secret };
}

/**
 * Scaffolds a fresh, isolated Supalite project workdir and generates its API keys, but
 * deliberately does NOT apply a user schema or start the HTTP server yet — those happen
 * when the scenario's own `schema.apply`/`migration.apply` step executes (§3.4: schema
 * application is an ordinary bootstrap-phase step, not implicit target setup), keeping
 * the driver honest about what is scenario-driven versus target-lifecycle-driven.
 */
export async function scaffoldSupaliteProject(
  workdirPath: string,
  backend: SupaliteBackend,
  config: SupaliteTargetConfig,
  postgresUrl: string | undefined,
): Promise<SupaliteProvisionedProject> {
  mkdirSync(workdirPath, { recursive: true });
  await linkSupaliteInstall(workdirPath);

  await runLiteToCompletion(workdirPath, ["init", ...(backend === "pglite" ? ["--pglite"] : [])]);

  const port = await leasePort();
  const configTomlPath = path.join(workdirPath, "supabase", "config.toml");
  let dbUrl: string;
  if (backend === "postgres") {
    if (!postgresUrl) {
      throw new Error(
        "supalite-postgres: SUPADIFF_SUPALITE_POSTGRES_URL is required (§4.4: owns or explicitly " +
          "attaches to an isolated PostgreSQL database)",
      );
    }
    dbUrl = postgresUrl;
  } else if (backend === "pglite") {
    dbUrl = "file:./supabase/.temp/pglite";
  } else {
    dbUrl = "file:./supabase/.temp/data.db";
  }

  const configToml = [
    "[api]",
    `port = ${port}`,
    "",
    "[db]",
    `driver = "${backend}"`,
    `url = "${dbUrl}"`,
    "",
    "[db.migrations]",
    'schema_paths = [ "./schemas/schema.sql" ]',
    "",
    "[db.seed]",
    'sql_paths = [ "./seed.sql" ]',
    "",
    "[auth]",
    "enabled = true",
    'jwt_secret = "sd-dev-not-a-production-secret-32-bytes-min-xy9k"',
    "jwt_expiry = 3600",
    "enable_signup = true",
    'publishable_key = "env(SUPABASE_PUBLISHABLE_KEY)"',
    'secret_key = "env(SUPABASE_SECRET_KEY)"',
    "",
    "[auth.email]",
    "enable_confirmations = false",
    "",
  ].join("\n");
  writeFileSync(configTomlPath, configToml);

  const envPath = path.join(workdirPath, ".env");
  const envText = await readFile(envPath, "utf8");
  const { publishableKey, secretKey } = parseGeneratedKeys(envText);

  return {
    workdirPath,
    backend,
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    publishableKey,
    secretKey,
    config,
  };
}

/** Writes the (already-canonical-JSON-safe) schema resource and applies it via the CLI. */
export async function applySchemaResource(
  project: SupaliteProvisionedProject,
  sql: string,
): Promise<void> {
  const { workdirPath, backend } = project;
  if (backend === "sqlite") {
    const dir = path.join(workdirPath, "supabase", "sqlite-migrations");
    mkdirSync(dir, { recursive: true });
    // Migration filenames must sort/parse as `YYYYMMDDHHMMSS_<name>.sql` (matching what
    // `lite db diff -f`/`migration new` themselves generate) — a bare epoch-ms filename is
    // silently never recognized as a pending migration by `lite migration up`.
    const stamp = new Date().toISOString().replace(/[-:T]/g, "").replace(/\..+/, "");
    const file = path.join(dir, `${stamp}_schema.sql`);
    writeFileSync(file, sql);
    await runLiteToCompletion(workdirPath, ["migration", "up"]);
    return;
  }

  const schemaPath = path.join(workdirPath, "supabase", "schemas", "schema.sql");
  writeFileSync(schemaPath, sql);
  await runLiteToCompletion(workdirPath, ["db", "diff", "-f", "schema"]);
  await runLiteToCompletion(workdirPath, ["db", "reset"]);
}

/** Starts (or restarts) the `lite start` server process and waits for it to accept requests. */
export async function startServer(project: SupaliteProvisionedProject): Promise<void> {
  if (project.process) {
    await project.process.kill();
    project.process = undefined;
  }
  const args = project.config.admin ? ["start"] : ["start", "--no-admin"];
  const proc = runLite(project.workdirPath, args);
  project.process = proc;
  await waitForHttpReady(`${project.baseUrl}/auth/v1/health`, {
    timeoutMs: project.config.readinessTimeoutMs,
  });
}

export function stopServer(project: SupaliteProvisionedProject): Promise<void> {
  if (!project.process) return Promise.resolve();
  const p = project.process;
  project.process = undefined;
  return p.kill();
}

export function cleanupWorkdir(workdirPath: string): void {
  if (existsSync(workdirPath)) rmSync(workdirPath, { recursive: true, force: true, maxRetries: 3 });
}

export function supalitePackageIdentity(): ExactPackageIdentity {
  return {
    name: SUPALITE_PACKAGE.name,
    version: SUPALITE_PACKAGE.version,
    integrity: SUPALITE_PACKAGE.integrity,
  };
}

export function nodeRuntimeIdentity(): ExactRuntimeIdentity {
  return { runtime: "node", version: process.version };
}

export function newRunId(prefix: string): StableId {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}` as StableId;
}
