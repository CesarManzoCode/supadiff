import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import type { ExactRuntimeIdentity } from "@supadiff/spec";
import { leasePort } from "../shared/ports.js";
import { spawnManaged, waitForHttpReady } from "../shared/process.js";
import {
  ensureSupabaseCli,
  supabaseCliBin,
  SUPABASE_CLI_PACKAGE,
  SUPABASE_LOCAL_PINNED_IMAGES,
} from "../shared/supabase-cli-cache.js";
import { ALWAYS_EXCLUDED_SERVICES, type SupabaseLocalTargetConfig } from "./types.js";

export interface SupabaseLocalProvisionedProject {
  readonly workdirPath: string;
  readonly projectId: string;
  readonly cliBin: string;
  readonly cliVersion: string;
  readonly config: SupabaseLocalTargetConfig;
  /** Kong-fronted API base URL (`/auth/v1`, `/rest/v1`, `/storage/v1`). */
  readonly baseUrl: string;
  /** Direct superuser Postgres URL (`postgres`/`postgres`) for schema application + state readback. */
  readonly dbUrl: string;
  readonly apiPort: number;
  readonly dbPort: number;
  publishableKey: string;
  secretKey: string;
  serviceRoleKey: string;
  started: boolean;
  containerDigests: Record<string, string>;
}

function newProjectId(): string {
  return `sdsblocal${randomBytes(6).toString("hex")}`;
}

/** Rewrites the first `key = ...` line that appears after `[section]` (before the next `[`). */
function setTomlValue(toml: string, section: string, key: string, value: string): string {
  const lines = toml.split("\n");
  let inSection = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const trimmed = line.trim();
    if (trimmed.startsWith("[")) {
      inSection = trimmed === `[${section}]`;
      continue;
    }
    if (!inSection) continue;
    const m = /^(\s*)#?\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    if (m && m[2] === key) {
      lines[i] = `${m[1]}${key} = ${value}`;
      return lines.join("\n");
    }
  }
  // Key not present in the section — append it right after the header.
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.trim() === `[${section}]`) {
      lines.splice(i + 1, 0, `${key} = ${value}`);
      return lines.join("\n");
    }
  }
  throw new Error(`setTomlValue: section [${section}] not found`);
}

function runCli(
  project: Pick<SupabaseLocalProvisionedProject, "cliBin" | "workdirPath">,
  args: string[],
  extraEnv: NodeJS.ProcessEnv = {},
): ReturnType<typeof spawnManaged> {
  return spawnManaged(project.cliBin, ["--workdir", project.workdirPath, ...args], {
    cwd: project.workdirPath,
    env: {
      ...process.env,
      ...extraEnv,
      SUPABASE_INTERNAL_IMAGE_REGISTRY:
        process.env["SUPABASE_INTERNAL_IMAGE_REGISTRY"] ?? "public.ecr.aws",
      DO_NOT_TRACK: "1",
    },
  });
}

async function runCliToCompletion(
  project: Pick<SupabaseLocalProvisionedProject, "cliBin" | "workdirPath">,
  args: string[],
  extraEnv: NodeJS.ProcessEnv = {},
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  const proc = runCli(project, args, extraEnv);
  const result = await proc.waitForExit();
  return { stdout: proc.stdout(), stderr: proc.stderr(), code: result.code };
}

const EXCLUDED_FOR_START = (config: SupabaseLocalTargetConfig): string[] => {
  const set = new Set<string>([...ALWAYS_EXCLUDED_SERVICES, ...config.excludedServices]);
  if (!config.experimentalFeatures.includes("storage")) set.add("storage-api");
  set.add("realtime"); // never part of the compared surface in this build
  return [...set];
};

/** True when a `supabase start` failure is a transient host-port collision worth retrying with fresh ports. */
function isPortCollision(text: string): boolean {
  return /address already in use|port is already allocated|bind: address already in use|Error response from daemon: .*port/i.test(
    text,
  );
}

interface StartKeys {
  publishableKey: string;
  secretKey: string;
  serviceRoleKey: string;
}

function parseKeysFromStartJson(stdout: string): StartKeys | undefined {
  // `supabase start --output-format json` prints one JSON object (last line) with the
  // resolved keys; older/newer shapes vary so we match on the known field names.
  for (const line of stdout.split("\n").reverse()) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    try {
      const j = JSON.parse(t) as Record<string, string>;
      if (j["PUBLISHABLE_KEY"] || j["SECRET_KEY"] || j["SERVICE_ROLE_KEY"]) {
        return {
          publishableKey: j["PUBLISHABLE_KEY"] ?? j["ANON_KEY"] ?? "",
          secretKey: j["SECRET_KEY"] ?? j["SERVICE_ROLE_KEY"] ?? "",
          serviceRoleKey: j["SERVICE_ROLE_KEY"] ?? j["SECRET_KEY"] ?? "",
        };
      }
    } catch {
      /* not the summary line */
    }
  }
  return undefined;
}

async function keysFromStatus(
  project: Pick<SupabaseLocalProvisionedProject, "cliBin" | "workdirPath">,
): Promise<StartKeys> {
  const { stdout } = await runCliToCompletion(project, ["status", "-o", "json"]);
  const j = JSON.parse(stdout) as Record<string, string>;
  return {
    publishableKey: j["PUBLISHABLE_KEY"] ?? j["ANON_KEY"] ?? "",
    secretKey: j["SECRET_KEY"] ?? j["SERVICE_ROLE_KEY"] ?? "",
    serviceRoleKey: j["SERVICE_ROLE_KEY"] ?? j["SECRET_KEY"] ?? "",
  };
}

async function writeControlledConfig(
  workdirPath: string,
  projectId: string,
  config: SupabaseLocalTargetConfig,
  ports: { api: number; db: number; shadow: number; pooler: number },
): Promise<void> {
  const configPath = path.join(workdirPath, "supabase", "config.toml");
  let toml = readFileSync(configPath, "utf8");
  toml = setTomlValue(toml, "api", "port", String(ports.api));
  toml = setTomlValue(toml, "db", "port", String(ports.db));
  toml = setTomlValue(toml, "db", "shadow_port", String(ports.shadow));
  toml = setTomlValue(toml, "db", "major_version", String(config.dbMajorVersion));
  toml = setTomlValue(toml, "db.pooler", "port", String(ports.pooler));
  toml = setTomlValue(
    toml,
    "storage",
    "enabled",
    config.experimentalFeatures.includes("storage") ? "true" : "false",
  );
  toml = setTomlValue(toml, "storage.vector", "enabled", "false");
  toml = setTomlValue(toml, "realtime", "enabled", "false");
  toml = setTomlValue(toml, "studio", "enabled", "false");
  toml = setTomlValue(toml, "analytics", "enabled", config.analytics ? "true" : "false");
  toml = setTomlValue(toml, "auth", "enable_signup", "true");
  toml = setTomlValue(toml, "auth.email", "enable_confirmations", "false");
  // project_id lives at file top level, before any section.
  toml = toml.replace(/^project_id\s*=.*$/m, `project_id = "${projectId}"`);
  writeFileSync(configPath, toml);
}

/**
 * Scaffolds an isolated `supabase-local` project workdir with a pinned CLI, controlled
 * ports, and the requested Postgres major version — but does NOT start containers or apply
 * a user schema. `supabase start` happens in `startStack`; schema application is a
 * scenario-driven bootstrap step (§3.4), applied over the direct superuser Postgres URL.
 */
export async function scaffoldSupabaseLocalProject(
  workdirPath: string,
  config: SupabaseLocalTargetConfig,
  cliVersion: string = SUPABASE_CLI_PACKAGE.version,
): Promise<SupabaseLocalProvisionedProject> {
  mkdirSync(workdirPath, { recursive: true });
  const cacheDir = await ensureSupabaseCli(cliVersion);
  const cliBin = supabaseCliBin(cacheDir);
  const projectId = newProjectId();

  const initRes = await runCliToCompletion({ cliBin, workdirPath }, ["init", "--force"]);
  if (initRes.code !== 0) {
    throw new Error(
      `supabase-local: "supabase init" failed (exit ${initRes.code}):\n${initRes.stderr}`,
    );
  }

  const [api, db, shadow, pooler] = await Promise.all([
    leasePort(),
    leasePort(),
    leasePort(),
    leasePort(),
  ]);
  await writeControlledConfig(workdirPath, projectId, config, { api, db, shadow, pooler });

  const { stdout: verOut } = await runCliToCompletion({ cliBin, workdirPath }, ["--version"]);
  const cliVersionObserved = verOut.trim().split("\n").pop()?.trim() ?? cliVersion;

  return {
    workdirPath,
    projectId,
    cliBin,
    cliVersion: cliVersionObserved,
    config,
    baseUrl: `http://127.0.0.1:${api}`,
    dbUrl: `postgresql://postgres:postgres@127.0.0.1:${db}/postgres`,
    apiPort: api,
    dbPort: db,
    publishableKey: "",
    secretKey: "",
    serviceRoleKey: "",
    started: false,
    containerDigests: {},
  };
}

/** Brings up the Docker Compose stack, retrying with fresh ports on a transient port collision. */
export async function startStack(project: SupabaseLocalProvisionedProject): Promise<void> {
  const excluded = EXCLUDED_FOR_START(project.config);
  const maxAttempts = 3;
  let lastErr = "";
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const { stdout, stderr, code } = await runCliToCompletion(project, [
      "start",
      "-x",
      excluded.join(","),
      "--output-format",
      "json",
    ]);
    if (code === 0) {
      const keys = parseKeysFromStartJson(stdout) ?? (await keysFromStatus(project));
      project.publishableKey = keys.publishableKey;
      project.secretKey = keys.secretKey;
      project.serviceRoleKey = keys.serviceRoleKey;
      project.started = true;
      await waitForHttpReady(`${project.baseUrl}/auth/v1/health`, {
        timeoutMs: project.config.readinessTimeoutMs,
      });
      if (project.config.experimentalFeatures.includes("storage")) {
        await applyStoragePolicies(project);
      }
      project.containerDigests = await collectContainerDigests();
      return;
    }
    lastErr = `${stdout}\n${stderr}`;
    // Always stop whatever came up before retrying, so a half-started stack does not leak.
    await stopStack(project).catch(() => undefined);
    if (attempt < maxAttempts && isPortCollision(lastErr)) {
      const [api, db, shadow, pooler] = await Promise.all([
        leasePort(),
        leasePort(),
        leasePort(),
        leasePort(),
      ]);
      await writeControlledConfig(project.workdirPath, project.projectId, project.config, {
        api,
        db,
        shadow,
        pooler,
      });
      (project as { baseUrl: string }).baseUrl = `http://127.0.0.1:${api}`;
      (project as { dbUrl: string }).dbUrl =
        `postgresql://postgres:postgres@127.0.0.1:${db}/postgres`;
      (project as { apiPort: number }).apiPort = api;
      (project as { dbPort: number }).dbPort = db;
      continue;
    }
    break;
  }
  throw new Error(
    `supabase-local: "supabase start" failed after retries for project ${project.projectId}:\n${lastErr}`,
  );
}

/**
 * Grants the `authenticated` role permission to manage buckets and objects. Real Supabase
 * ships `storage.buckets`/`storage.objects` with RLS on and no default policy, so an
 * ordinary authenticated user cannot create a bucket — whereas the Supalite family's
 * Storage emulation is not bucket-RLS gated. Applying these permissive policies makes one
 * scenario authored against Supalite run identically here, keeping the peer comparison
 * about object *behavior* (byte identity, signed-URL redemption), not about each backend's
 * bucket-management authorization model. Documented in docs/TARGETS.md.
 */
async function applyStoragePolicies(project: SupabaseLocalProvisionedProject): Promise<void> {
  const { default: postgres } = await import("postgres");
  const client = postgres(project.dbUrl, { max: 1, connect_timeout: 15, onnotice: () => {} });
  try {
    await client.unsafe(`
      do $$ begin
        if not exists (select 1 from pg_policies where schemaname='storage' and tablename='buckets' and policyname='sd_authenticated_buckets') then
          create policy sd_authenticated_buckets on storage.buckets for all to authenticated using (true) with check (true);
        end if;
        if not exists (select 1 from pg_policies where schemaname='storage' and tablename='objects' and policyname='sd_authenticated_objects') then
          create policy sd_authenticated_objects on storage.objects for all to authenticated using (true) with check (true);
        end if;
      end $$;
      grant all on storage.buckets, storage.objects to authenticated, service_role;
    `);
  } finally {
    await client.end({ timeout: 5 });
  }
}

/** `docker inspect` the pinned images for their immutable `sha256:` digests (§2.7 identity evidence). */
async function collectContainerDigests(): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const [service, image] of Object.entries(SUPABASE_LOCAL_PINNED_IMAGES)) {
    const proc = spawnManaged(
      "docker",
      ["inspect", "--format", "{{index .RepoDigests 0}}", image],
      { cwd: process.cwd(), env: process.env },
    );
    const res = await proc.waitForExit();
    const line = proc.stdout().trim();
    if (res.code === 0 && line.includes("@sha256:")) out[service] = line.split("@")[1]!;
  }
  return out;
}

export async function stopStack(project: SupabaseLocalProvisionedProject): Promise<void> {
  await runCliToCompletion(project, ["stop", "--no-backup"]);
  project.started = false;
}

/** Best-effort removal of any leftover containers/network for a project id (recovery path, §4.2). */
export async function forceCleanupProject(projectId: string): Promise<void> {
  // The project id is unique and is a substring of every container/network name the CLI
  // creates (`supabase_<svc>_<projectId>`, `supabase_network_<projectId>`), so a plain
  // substring `name=` filter is both sufficient and safe — it can never match another
  // project's resources.
  const rm = spawnManaged(
    "bash",
    [
      "-c",
      `docker ps -aq --filter "name=${projectId}" | xargs -r docker rm -f -v; ` +
        `docker network ls -q --filter "name=${projectId}" | xargs -r docker network rm`,
    ],
    { cwd: process.cwd(), env: process.env },
  );
  await rm.waitForExit();
}

export function cleanupWorkdir(workdirPath: string): void {
  if (existsSync(workdirPath)) rmSync(workdirPath, { recursive: true, force: true, maxRetries: 3 });
}

export function nodeRuntimeIdentity(): ExactRuntimeIdentity {
  return { runtime: "node", version: process.version };
}
