import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import { spawnManaged } from "../shared/process.js";
import { leasePort } from "../shared/ports.js";
import { ensureSupaliteInstall, SUPALITE_PACKAGE } from "../shared/package-cache.js";
// L8 verifies the `@supabase/lite@0.9.0` → Supabase-local transition specifically; the
// source is always the v1.0.0 baseline profile, passed explicitly rather than defaulted.
import { SUPALITE_PROFILE_0_9_0 } from "../supalite/package-profile.js";
import {
  ensureSupabaseCli,
  supabaseCliBin,
  SUPABASE_CLI_PACKAGE,
} from "../shared/supabase-cli-cache.js";
import {
  applySchemaResource,
  cleanupWorkdir,
  scaffoldSupaliteProject,
  startServer,
  stopServer,
  type SupaliteProvisionedProject,
} from "../supalite/provision.js";
import { forceCleanupProject } from "./provision.js";
import type { SupaliteTargetConfig } from "../supalite/types.js";

/**
 * L8 — Supalite → real `lite upgrade` → Supabase-local upgrade verification
 * (`supadiff verify-upgrade`, Architecture Contract §12).
 *
 * The public L8 surface verifies the transition the contract actually defines:
 *
 *   S0 (a file-backed Supalite target)
 *     → preservation probe P0
 *     → clone S0 into baseline B and upgrade-source U, then close S0
 *     → real `lite upgrade --target local --dry-run` from U
 *     → real `lite upgrade --target local --local-dir <C>` from U to a FRESH
 *       Supabase-local stack C (the pinned `supabase` CLI, driven through
 *       `LITE_SUPABASE_CLI`)
 *     → probe C, re-authenticate the fixture actor against C (sessions are NOT
 *       migrated — `migrateSessions = false`, old token bytes are never replayed)
 *     → preservation comparison (row IDs, sequence next-use, Auth logical subject)
 *       against probe P0
 *     → same-behavior scenario run lockstep on B and C (owner-scoped RLS)
 *     → artifact / results / cleanup.
 *
 * The transition mechanism is the REAL `lite upgrade` from the exact-pinned
 * `@supabase/lite@0.9.0` — never a `pg_dump`/restore substitute.
 *
 * Storage: `lite upgrade` does not carry Storage (UPGRADE.md "Known Gaps"), and the
 * local target brings up no `storage-api` service. When a caller declares that the
 * workflow *requires* Storage preservation, this is rejected **before any mutation**
 * (before S0 is even bootstrapped) rather than run and marked "skipped" afterwards.
 */

export type UpgradeCheckStatus = "pass" | "fail" | "skipped" | "rejected" | "divergence";

export interface UpgradeCheck {
  name: string;
  status: UpgradeCheckStatus;
  detail: string;
}

export interface VerifyUpgradeOptions {
  /** When false (the default) only the dry-run plan is produced — nothing is provisioned. */
  execute?: boolean;
  /**
   * Declares that the workflow requires Storage byte preservation across the upgrade.
   * `lite upgrade` cannot preserve Storage, so this is rejected before any mutation.
   */
  requireStoragePreservation?: boolean;
  /** Parent directory for the transient S0 / B / U / C workdirs. Defaults to an OS temp dir. */
  workdirParentDir?: string;
  /** Pinned `supabase` CLI version `lite upgrade --target local` is pointed at. */
  supabaseCliVersion?: string;
  readinessTimeoutMs?: number;
  /** Sink for progress lines (defaults to no-op); the CLI passes `process.stderr.write`. */
  log?: (line: string) => void;
  /**
   * Test-only: throw immediately after the real `lite upgrade --dry-run` succeeds, to
   * exercise the transition-failure cleanup/recovery path against real provisioned
   * resources (S0 bootstrapped, P0 probed, cloned) without a partially-applied stack.
   */
  injectTransitionFailure?: boolean;
}

export interface UpgradeTargetIdentity {
  role: "source" | "baseline" | "destination";
  kind: string;
  implementation: string;
  implementationVersion: string;
  packageIntegrity?: string;
  backend?: string;
  workdir?: string;
  cliVersion?: string;
  projectId?: string;
  apiUrl?: string;
}

export interface VerifyUpgradeReport {
  format: "supadiff.verify-upgrade";
  formatVersion: "2";
  dryRun: boolean;
  mutated: boolean;
  /** True when `requireStoragePreservation` forced a pre-mutation rejection. */
  rejectedBeforeMutation: boolean;
  /** Ordered description of the §12 workflow segments (always populated). */
  plan: string[];
  checks: UpgradeCheck[];
  /** The exact `lite upgrade --dry-run` argv exercised (execute mode only). */
  liteDryRunCommand?: string;
  /** The exact `lite upgrade` argv exercised for the real transition (execute mode only). */
  liteUpgradeCommand?: string;
  /** Absolute path of the `@supabase/lite` CLI entrypoint the commands ran. */
  liteCliPath?: string;
  targets: UpgradeTargetIdentity[];
  /** Registered known-divergence ids reproduced by this run (does not fail `ok`). */
  divergences: string[];
  ok: boolean;
}

const PLAN: string[] = [
  "dry-run: describe the §12 workflow and exit (this list) unless --execute is passed",
  "reject before any mutation if the workflow requires Storage preservation (lite upgrade cannot carry Storage)",
  "S0 bootstrap: scaffold a file-backed supalite-sqlite-postgres project, apply the upgrade fixture schema (todos + owner-scoped RLS, counters bigserial sequence)",
  "S0: sign the owner up via GoTrue, insert owned rows, advance the sequence, capture the owner's pre-upgrade access token",
  "preservation probe P0: snapshot todo row ids, counters max id, auth.users (uuid + email)",
  "clone S0 into baseline B and upgrade-source U (file copy of the workdir), re-link the pinned package, lease fresh ports",
  "close S0 (stop its server, remove its workdir) — the source is never mutated in place",
  "real `lite upgrade --target local --dry-run --no-migrate-sessions` from U: readiness + in-memory pglite rehearsal",
  "real `lite upgrade --target local --local-dir <C> --force --no-migrate-sessions` from U: apply schema/auth/data to a FRESH Supabase-local stack C via the pinned supabase CLI",
  "assert U was not mutated in place (config.toml byte-identical, no config.toml.bak, [db].driver intact)",
  "probe C capabilities (auth + rest health)",
  "session non-preservation: present the pre-upgrade token to C — expect rejection (JWT secret is not migrated)",
  "actor rebind + reauthentication: normalize migrated auth.users to the CLI GoTrue schema, then sign in again on C with the same credentials — expect a new session for the same logical subject",
  "preservation comparison vs P0: destination row ids preserved; deliberate corruption is detected; auth.users uuid + email preserved; sequence next-use compared B vs C (a registered divergence — lite does not carry the sequence position)",
  "same-behavior scenario lockstep on B and C: owner sees own todos, anon sees none — outcomes must agree",
  "Storage preservation: skipped (unsupported) unless it was required, in which case it was already rejected before mutation",
  "artifact / results / cleanup: stop C and B, force-clean containers, remove all workdirs; baseline B is retained until cleanup",
];

/** Maps a `divergence`-status check to the registered known-divergence id it reproduces. */
const DIVERGENCE_ID_BY_CHECK: Record<string, string> = {
  "sequence-next-use": "div.lite-upgrade-local-sequence-not-reset",
};

const FIXTURE_SCHEMA = `create table public.todos (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null,
  title text not null,
  created_at timestamptz not null default now()
);

alter table public.todos enable row level security;

create policy "owner can select own todos" on public.todos
  for select using (auth.uid() = owner_id);

create policy "owner can insert own todos" on public.todos
  for insert with check (auth.uid() = owner_id);

create table public.counters (
  id bigserial primary key,
  label text not null
);
`;

const DATA_API_GRANTS = `
grant usage on schema public to anon, authenticated, service_role;
grant all on all tables in schema public to anon, authenticated, service_role;
grant all on all sequences in schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
notify pgrst, 'reload schema';
`;

const OWNER_PASSWORD = "upgrade-owner-pw-12345678";

function supaliteConfig(readinessTimeoutMs: number): SupaliteTargetConfig {
  return {
    admin: false,
    forceRollback: false,
    experimentalFeatures: [],
    keyMode: "opaque-v1",
    routePrefixes: { auth: "/auth/v1", rest: "/rest/v1", storage: "/storage/v1" },
    transport: "socket-server",
    readinessTimeoutMs,
  };
}

async function sql<T = Record<string, unknown>>(dbUrl: string, query: string): Promise<T[]> {
  const { default: postgres } = await import("postgres");
  const client = postgres(dbUrl, { max: 1, connect_timeout: 15, onnotice: () => {} });
  try {
    return (await client.unsafe(query)) as unknown as T[];
  } finally {
    await client.end({ timeout: 5 });
  }
}

function hashFile(p: string): string {
  return createHash("sha256").update(readFileSync(p)).digest("hex");
}

function parseEnvKeys(workdir: string): { publishableKey: string; secretKey: string } {
  const text = readFileSync(path.join(workdir, ".env"), "utf8");
  const publishableKey = /^SUPABASE_PUBLISHABLE_KEY=(.+)$/m.exec(text)?.[1] ?? "";
  const secretKey = /^SUPABASE_SECRET_KEY=(.+)$/m.exec(text)?.[1] ?? "";
  return { publishableKey, secretKey };
}

/** Copies a Supalite workdir tree (minus node_modules), re-links the shared package cache. */
async function cloneWorkdir(src: string, dst: string): Promise<void> {
  cpSync(src, dst, {
    recursive: true,
    filter: (from) => path.basename(from) !== "node_modules",
  });
  rmSync(path.join(dst, "node_modules"), { recursive: true, force: true });
  const cacheDir = await ensureSupaliteInstall(SUPALITE_PROFILE_0_9_0);
  symlinkSync(path.join(cacheDir, "node_modules"), path.join(dst, "node_modules"), "dir");
}

function repointApiPort(workdir: string, port: number): void {
  const configPath = path.join(workdir, "supabase", "config.toml");
  const toml = readFileSync(configPath, "utf8");
  const rewritten = toml.replace(/(\[api\][^[]*?\bport\s*=\s*)\d+/, `$1${port}`);
  if (rewritten === toml) throw new Error("verify-upgrade: could not repoint [api].port in clone");
  writeFileSync(configPath, rewritten);
}

interface P0Snapshot {
  todoIds: string[];
  countersMaxId: string;
  authUsers: Array<{ id: string; email: string }>;
  ownerId: string;
  ownerEmail: string;
}

/** Pure set comparison used for ID preservation *and* deliberate-corruption detection. */
function idSetPreserved(
  expected: readonly string[],
  actual: readonly string[],
): { preserved: boolean; missing: string[]; unexpected: string[] } {
  const e = new Set(expected);
  const a = new Set(actual);
  const missing = [...e].filter((v) => !a.has(v));
  const unexpected = [...a].filter((v) => !e.has(v));
  return { preserved: missing.length === 0 && unexpected.length === 0, missing, unexpected };
}

async function runLite(
  cwd: string,
  args: string[],
  extraEnv: NodeJS.ProcessEnv,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const liteBin = path.join(cwd, "node_modules", "@supabase", "lite", "dist", "cli", "index.js");
  const proc = spawnManaged(process.execPath, [liteBin, ...args], {
    cwd,
    env: { ...process.env, ...extraEnv, DO_NOT_TRACK: "1", CI: "1" },
  });
  const res = await proc.waitForExit();
  return { code: res.code, stdout: proc.stdout(), stderr: proc.stderr() };
}

/** Runs the L8 verify-upgrade workflow. In dry-run mode returns only the plan. */
export async function verifyUpgrade(
  options: VerifyUpgradeOptions = {},
): Promise<VerifyUpgradeReport> {
  const log = options.log ?? (() => {});
  const readiness = options.readinessTimeoutMs ?? 180_000;
  const cliVersion = options.supabaseCliVersion ?? SUPABASE_CLI_PACKAGE.version;

  const sourceIdentity: UpgradeTargetIdentity = {
    role: "source",
    kind: "supalite-sqlite-postgres",
    implementation: SUPALITE_PACKAGE.name,
    implementationVersion: SUPALITE_PACKAGE.version,
    packageIntegrity: SUPALITE_PACKAGE.integrity,
    backend: "sqlite-postgres",
  };

  if (!options.execute) {
    return {
      format: "supadiff.verify-upgrade",
      formatVersion: "2",
      dryRun: true,
      mutated: false,
      rejectedBeforeMutation: false,
      plan: PLAN,
      checks: [
        {
          name: "dry-run",
          status: "skipped",
          detail:
            "Mandatory dry-run: nothing was provisioned and nothing was mutated. Re-run with " +
            "execute:true (CLI: --execute) to run the real Supalite → lite upgrade → Supabase-local flow.",
        },
      ],
      targets: [sourceIdentity],
      divergences: [],
      ok: true,
    };
  }

  // --- Storage: reject BEFORE any mutation (never run-then-skip) ---
  if (options.requireStoragePreservation) {
    return {
      format: "supadiff.verify-upgrade",
      formatVersion: "2",
      dryRun: false,
      mutated: false,
      rejectedBeforeMutation: true,
      plan: PLAN,
      checks: [
        {
          name: "storage-preservation",
          status: "rejected",
          detail:
            "The workflow requires Storage byte preservation, which `lite upgrade` cannot provide " +
            "(UPGRADE.md 'Known Gaps': Storage migration is not implemented; the local target runs " +
            "no storage-api). Rejected before S0 was bootstrapped — nothing was provisioned or mutated.",
        },
      ],
      targets: [sourceIdentity],
      divergences: [],
      ok: false,
    };
  }

  const checks: UpgradeCheck[] = [];
  const parent = options.workdirParentDir ?? tmpdir();
  const s0Workdir = mkdtempSync(path.join(parent, "sd-l8-s0-"));
  const bWorkdir = mkdtempSync(path.join(parent, "sd-l8-baseline-"));
  const uWorkdir = mkdtempSync(path.join(parent, "sd-l8-upgradesrc-"));
  const cWorkdir = mkdtempSync(path.join(parent, "sd-l8-dest-"));

  const targets: UpgradeTargetIdentity[] = [{ ...sourceIdentity, workdir: s0Workdir }];
  const baselineIdentity: UpgradeTargetIdentity = {
    ...sourceIdentity,
    role: "baseline",
    workdir: bWorkdir,
  };
  const destIdentity: UpgradeTargetIdentity = {
    role: "destination",
    kind: "supabase-local",
    implementation: SUPABASE_CLI_PACKAGE.name,
    implementationVersion: cliVersion,
    workdir: cWorkdir,
  };
  targets.push(baselineIdentity, destIdentity);

  const cliCacheDir = await ensureSupabaseCli(cliVersion);
  const supabaseBin = supabaseCliBin(cliCacheDir);
  const liteEnv: NodeJS.ProcessEnv = {
    LITE_SUPABASE_CLI: supabaseBin,
    SUPABASE_INTERNAL_IMAGE_REGISTRY:
      process.env["SUPABASE_INTERNAL_IMAGE_REGISTRY"] ?? "public.ecr.aws",
  };
  const liteCliPath = path.join(
    uWorkdir,
    "node_modules",
    "@supabase",
    "lite",
    "dist",
    "cli",
    "index.js",
  );

  let s0: SupaliteProvisionedProject | undefined;
  let baseline: SupaliteProvisionedProject | undefined;
  let cProjectId: string | undefined;
  let liteDryRunCommand: string | undefined;
  let liteUpgradeCommand: string | undefined;

  const finish = async (ok: boolean): Promise<VerifyUpgradeReport> => {
    if (s0) await stopServer(s0).catch(() => {});
    if (baseline) await stopServer(baseline).catch(() => {});
    // Stop the Supabase-local stack lite left running.
    if (existsSync(path.join(cWorkdir, "supabase", "config.toml"))) {
      const stop = spawnManaged(supabaseBin, ["--workdir", cWorkdir, "stop", "--no-backup"], {
        cwd: tmpdir(),
        env: { ...process.env, ...liteEnv },
      });
      await stop.waitForExit().catch(() => {});
    }
    if (cProjectId) await forceCleanupProject(cProjectId).catch(() => {});
    for (const d of [s0Workdir, bWorkdir, uWorkdir, cWorkdir]) cleanupWorkdir(d);
    return {
      format: "supadiff.verify-upgrade",
      formatVersion: "2",
      dryRun: false,
      mutated: true,
      rejectedBeforeMutation: false,
      plan: PLAN,
      checks,
      liteDryRunCommand,
      liteUpgradeCommand,
      liteCliPath,
      targets,
      divergences: [
        ...new Set(
          checks
            .filter((c) => c.status === "divergence")
            .map((c) => DIVERGENCE_ID_BY_CHECK[c.name] ?? c.name),
        ),
      ],
      ok,
    };
  };

  try {
    // --- S0 bootstrap ---
    log("S0: scaffolding supalite-sqlite-postgres source...\n");
    s0 = await scaffoldSupaliteProject(
      s0Workdir,
      "sqlite-postgres",
      supaliteConfig(readiness),
      undefined,
      SUPALITE_PROFILE_0_9_0,
    );
    await applySchemaResource(s0, FIXTURE_SCHEMA);
    await startServer(s0);

    const anonClient = createClient(s0.baseUrl, s0.publishableKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const ownerEmail = `upgrade-owner-${Date.now()}@example.test`;
    const signUp = await anonClient.auth.signUp({ email: ownerEmail, password: OWNER_PASSWORD });
    if (signUp.error || !signUp.data.session) {
      throw new Error(`S0 owner signUp failed: ${signUp.error?.message ?? "no session"}`);
    }
    const ownerId = signUp.data.user!.id;
    const preUpgradeToken = signUp.data.session.access_token;

    const ownerClient = createClient(s0.baseUrl, s0.publishableKey, {
      global: { headers: { Authorization: `Bearer ${preUpgradeToken}` } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const ins = await ownerClient
      .from("todos")
      .insert([
        { owner_id: ownerId, title: "kept row A" },
        { owner_id: ownerId, title: "kept row B" },
        { owner_id: ownerId, title: "kept row C" },
      ])
      .select();
    if (ins.error) throw new Error(`S0 owned insert failed: ${ins.error.message}`);

    const service = createClient(s0.baseUrl, s0.secretKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const seedCounters = await service
      .from("counters")
      .insert([{ label: "a" }, { label: "b" }, { label: "c" }, { label: "d" }])
      .select();
    if (seedCounters.error)
      throw new Error(`S0 counters seed failed: ${seedCounters.error.message}`);

    // --- preservation probe P0 ---
    const p0Todos = await service.from("todos").select("id,title").order("title");
    if (p0Todos.error) throw new Error(`P0 todo probe failed: ${p0Todos.error.message}`);
    const p0Counters = await service
      .from("counters")
      .select("id")
      .order("id", { ascending: false })
      .limit(1);
    if (p0Counters.error) throw new Error(`P0 counter probe failed: ${p0Counters.error.message}`);

    // The fixture has exactly one Auth subject (the owner) — captured directly from the
    // signup response, so P0 does not depend on the GoTrue admin API being reachable.
    const snapshot: P0Snapshot = {
      todoIds: (p0Todos.data as Array<{ id: string }>).map((r) => r.id),
      countersMaxId: String((p0Counters.data as Array<{ id: number }>)[0]?.id ?? 0),
      authUsers: [{ id: ownerId, email: ownerEmail }],
      ownerId,
      ownerEmail,
    };
    log(
      `P0: ${snapshot.todoIds.length} todos, counters max id ${snapshot.countersMaxId}, ` +
        `${snapshot.authUsers.length} auth users\n`,
    );

    // --- clone S0 into B and U; close S0 ---
    log("cloning S0 into baseline B and upgrade-source U...\n");
    await stopServer(s0);
    await cloneWorkdir(s0Workdir, bWorkdir);
    await cloneWorkdir(s0Workdir, uWorkdir);
    const bPort = await leasePort();
    const uPort = await leasePort();
    repointApiPort(bWorkdir, bPort);
    repointApiPort(uWorkdir, uPort);
    cleanupWorkdir(s0Workdir);
    s0 = undefined;

    const uConfigPath = path.join(uWorkdir, "supabase", "config.toml");
    const uConfigHashBefore = hashFile(uConfigPath);

    // --- real `lite upgrade --dry-run` from U ---
    log("running real `lite upgrade --target local --dry-run` from U...\n");
    const dryRunArgs = ["upgrade", "--target", "local", "--dry-run", "--no-migrate-sessions"];
    liteDryRunCommand = `LITE_SUPABASE_CLI=${supabaseBin} node ${liteCliPath} ${dryRunArgs.join(" ")} (cwd=${uWorkdir})`;
    const dry = await runLite(uWorkdir, dryRunArgs, liteEnv);
    const dryOut = `${dry.stdout}\n${dry.stderr}`;
    checks.push({
      name: "lite-dry-run",
      status:
        dry.code === 0 && /Ready to upgrade\.|rehearsal passed/i.test(dryOut) ? "pass" : "fail",
      detail:
        dry.code === 0
          ? `real \`lite upgrade --dry-run\` passed readiness + in-memory pglite rehearsal`
          : `\`lite upgrade --dry-run\` exited ${dry.code}: ${dryOut.slice(-600)}`,
    });
    if (dry.code !== 0) return finish(false);

    if (options.injectTransitionFailure) {
      throw new Error("injected transition failure (test): abort after a real successful dry-run");
    }

    // --- real `lite upgrade` from U into a FRESH Supabase-local stack C ---
    log("running real `lite upgrade --target local --local-dir <C>` from U...\n");
    const credPath = path.join(parent, `sd-l8-cred-${Date.now()}.json`);
    const upgradeArgs = [
      "upgrade",
      "--target",
      "local",
      "--local-dir",
      cWorkdir,
      "--force",
      "--no-migrate-sessions",
      "--dump-credentials",
      credPath,
    ];
    liteUpgradeCommand = `LITE_SUPABASE_CLI=${supabaseBin} node ${liteCliPath} ${upgradeArgs.join(" ")} (cwd=${uWorkdir})`;
    const up = await runLite(uWorkdir, upgradeArgs, liteEnv);
    const upOut = `${up.stdout}\n${up.stderr}`;
    const upgradeOk = up.code === 0 && /Upgrade complete\./i.test(upOut);
    checks.push({
      name: "lite-upgrade",
      status: upgradeOk ? "pass" : "fail",
      detail: upgradeOk
        ? `real \`lite upgrade\` applied schema/auth/data to a fresh Supabase-local stack`
        : `\`lite upgrade\` exited ${up.code}: ${upOut.slice(-1200)}`,
    });
    if (!upgradeOk) return finish(false);

    let cred: {
      apiUrl: string;
      dbUrl: string;
      anonKey: string;
      serviceRoleKey: string;
    };
    try {
      cred = JSON.parse(readFileSync(credPath, "utf8")) as typeof cred;
    } finally {
      rmSync(credPath, { force: true });
    }
    cProjectId =
      /^project_id\s*=\s*"([^"]+)"/m.exec(
        readFileSync(path.join(cWorkdir, "supabase", "config.toml"), "utf8"),
      )?.[1] ?? undefined;
    destIdentity.apiUrl = cred.apiUrl;
    destIdentity.projectId = cProjectId;
    {
      const ver = spawnManaged(supabaseBin, ["--version"], { cwd: tmpdir(), env: process.env });
      await ver.waitForExit();
      destIdentity.cliVersion = ver.stdout().trim().split("\n").pop()?.trim() ?? cliVersion;
    }

    // --- assert U not mutated in place ---
    const uConfigHashAfter = hashFile(uConfigPath);
    const noBak = !existsSync(path.join(uWorkdir, "supabase", "config.toml.bak"));
    const driverIntact = /^\s*driver\s*=/m.test(readFileSync(uConfigPath, "utf8"));
    checks.push({
      name: "source-workdir-untouched",
      status: uConfigHashBefore === uConfigHashAfter && noBak && driverIntact ? "pass" : "fail",
      detail:
        `U/supabase/config.toml unchanged: ${uConfigHashBefore === uConfigHashAfter}; ` +
        `no config.toml.bak: ${noBak}; [db].driver intact: ${driverIntact} ` +
        `(--local-dir keeps the in-place rewrite off the source)`,
    });

    // Apply the Data API grants lite does not emit, so PostgREST can serve the table.
    await sql(cred.dbUrl, DATA_API_GRANTS);

    // Destination actor rebind (§12 "actor reauthentication/rebind"). `lite upgrade
    // --target local` copies the Supalite `auth.users` rows verbatim, but Supalite's
    // users table is narrower than the CLI GoTrue's: the migrated rows land with
    // `instance_id IS NULL` (GoTrue scopes every lookup to the zero instance) and with
    // NULL in GoTrue's non-nullable sentinel string columns (`confirmation_token`, …),
    // which makes GoTrue's own row scan fail ("converting NULL to string is
    // unsupported"). Rebinding normalizes the migrated rows to the destination GoTrue's
    // schema expectations — the zero instance and empty-string sentinels — and touches
    // no password or session-token bytes.
    let rebindDetail: string;
    let rebindOk = false;
    try {
      await sql(
        cred.dbUrl,
        `do $$
         declare col text;
         begin
           update auth.users set instance_id = '00000000-0000-0000-0000-000000000000'
             where instance_id is null;
           for col in
             select column_name from information_schema.columns
             where table_schema = 'auth' and table_name = 'users'
               and data_type in ('character varying', 'text') and is_nullable = 'YES'
               and column_name in ('confirmation_token','recovery_token','email_change_token_new',
                 'email_change_token_current','phone_change_token','reauthentication_token',
                 'email_change','phone_change')
           loop
             execute format('update auth.users set %I = '''' where %I is null', col, col);
           end loop;
         end $$;`,
      );
      rebindOk = true;
      rebindDetail =
        "migrated auth.users rows normalized to the CLI GoTrue schema (zero instance_id, " +
        "empty-string token sentinels) — no password/session-token bytes touched";
    } catch (e) {
      rebindDetail = `rebind failed: ${String(e)}`;
    }
    checks.push({
      name: "destination-actor-rebind",
      status: rebindOk ? "pass" : "fail",
      detail: rebindDetail,
    });

    // --- start baseline B (retained clone of S0) for the lockstep comparisons ---
    log("starting baseline B for the lockstep comparisons...\n");
    const bKeys = parseEnvKeys(bWorkdir);
    baseline = {
      workdirPath: bWorkdir,
      backend: "sqlite-postgres",
      port: bPort,
      baseUrl: `http://127.0.0.1:${bPort}`,
      publishableKey: bKeys.publishableKey,
      secretKey: bKeys.secretKey,
      config: supaliteConfig(readiness),
      // Retained byte-clone of S0 (the 0.9.0 baseline); it links the same package cache.
      profile: SUPALITE_PROFILE_0_9_0,
      createClient,
      clientVersion: SUPALITE_PROFILE_0_9_0.client.version,
    };
    await startServer(baseline);
    const bService = createClient(baseline.baseUrl, baseline.secretKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    // --- probe C ---
    const health = await fetch(`${cred.apiUrl}/auth/v1/health`, {
      headers: { apikey: cred.anonKey },
    }).catch(() => undefined);
    checks.push({
      name: "destination-probe",
      status: health?.ok ? "pass" : "fail",
      detail: health?.ok
        ? `Supabase-local C is live (${cred.apiUrl})`
        : `C did not answer at ${cred.apiUrl}/auth/v1/health`,
    });

    // --- session non-preservation ---
    const oldTokenProbe = await createClient(cred.apiUrl, cred.anonKey, {
      global: { headers: { Authorization: `Bearer ${preUpgradeToken}` } },
      auth: { persistSession: false, autoRefreshToken: false },
    }).auth.getUser();
    checks.push({
      name: "session-non-preservation",
      status: oldTokenProbe.data.user ? "fail" : "pass",
      detail: oldTokenProbe.data.user
        ? "the pre-upgrade Supalite token was still accepted by C"
        : "the pre-upgrade Supalite token is rejected by C — migrateSessions=false, old bytes never replayed",
    });

    // --- actor reauthentication: the owner signs in again on C with the SAME
    //     credentials (the migrated bcrypt hash is intact) and gets a brand-new
    //     session for the same logical subject. Old token bytes are never replayed. ---
    let reauth = await createClient(cred.apiUrl, cred.anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    }).auth.signInWithPassword({ email: ownerEmail, password: OWNER_PASSWORD });
    for (let attempt = 0; attempt < 5 && reauth.error; attempt++) {
      await new Promise((r) => setTimeout(r, 1500));
      reauth = await createClient(cred.apiUrl, cred.anonKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      }).auth.signInWithPassword({ email: ownerEmail, password: OWNER_PASSWORD });
    }
    const newToken = reauth.data.session?.access_token;
    const sameSubject = reauth.data.user?.id === ownerId;
    checks.push({
      name: "reauthentication",
      status:
        !reauth.error && newToken && newToken !== preUpgradeToken && sameSubject ? "pass" : "fail",
      detail: reauth.error
        ? `re-signin on C failed: ${reauth.error.message}`
        : `owner re-authenticated on C: ${newToken !== preUpgradeToken ? "fresh token" : "SAME TOKEN"}, ` +
          `logical subject ${reauth.data.user?.id} ${sameSubject ? "==" : "!="} pre-upgrade ${ownerId}`,
    });

    // --- preservation comparison vs P0 ---
    const destTodos = await sql<{ id: string }>(
      cred.dbUrl,
      "select id::text from public.todos order by title",
    );
    const destIds = destTodos.map((r) => r.id);
    const idCmp = idSetPreserved(snapshot.todoIds, destIds);
    checks.push({
      name: "id-preservation",
      status: idCmp.preserved ? "pass" : "fail",
      detail:
        `P0 ${JSON.stringify(snapshot.todoIds)} vs C ${JSON.stringify(destIds)} — ` +
        `missing ${JSON.stringify(idCmp.missing)}, unexpected ${JSON.stringify(idCmp.unexpected)}`,
    });

    // deliberate corruption must be detected by the same comparison
    const corrupted = destIds.length
      ? [flipOneChar(destIds[0]!), ...destIds.slice(1)]
      : ["00000000-0000-0000-0000-000000000000"];
    const corruptionDetected = !idSetPreserved(snapshot.todoIds, corrupted).preserved;
    checks.push({
      name: "id-corruption-detected",
      status: corruptionDetected ? "pass" : "fail",
      detail: corruptionDetected
        ? "flipping one destination row id makes the preservation check fail — the comparison is not a tautology"
        : "a deliberately corrupted id set still passed the preservation check",
    });

    // sequence next-use behavior, lockstep B vs C: a fresh insert after the transition
    // must land past every migrated id. B (a plain Supalite clone) does this; `lite
    // upgrade` from a file-backed source does NOT carry the sequence position to C
    // (SQLite introspection exposes no serial default, so lite emits no `setval`), so
    // the next insert on C collides — a genuine, reproduced cross-target divergence.
    const bNextRow = await bService
      .from("counters")
      .insert({ label: "post-transition-probe" })
      .select("id");
    const bNext = (bNextRow.data as Array<{ id: number }> | null)?.[0]?.id;
    const bAdvances = bNext !== undefined && BigInt(bNext) > BigInt(snapshot.countersMaxId);
    let cNext: string | undefined;
    let cSeqError: string | undefined;
    try {
      cNext = (
        await sql<{ id: string }>(
          cred.dbUrl,
          "insert into public.counters (label) values ('post-transition-probe') returning id::text",
        )
      )[0]?.id;
    } catch (e) {
      cSeqError = String(e);
    }
    const cAdvances = cNext !== undefined && BigInt(cNext) > BigInt(snapshot.countersMaxId);
    checks.push({
      name: "sequence-next-use",
      status: bAdvances && cAdvances ? "pass" : bAdvances && !cAdvances ? "divergence" : "fail",
      detail:
        `P0 counters max id ${snapshot.countersMaxId}. ` +
        `B (Supalite clone) next insert id ${String(bNext)} (${bAdvances ? "advances" : "did NOT advance"}); ` +
        `C (after real \`lite upgrade\`) ${
          cSeqError
            ? `next insert FAILED: ${cSeqError.slice(0, 200)}`
            : `next insert id ${String(cNext)} (${cAdvances ? "advances" : "COLLIDES with migrated ids"})`
        }. ` +
        (bAdvances && !cAdvances
          ? "Reproduced divergence div.lite-upgrade-local-sequence-not-reset: `lite upgrade --target " +
            "local` from a file-backed Supalite source migrates row ids but not the serial-sequence " +
            "position, so the first post-upgrade insert collides. B is unaffected."
          : ""),
    });

    // Auth logical subject preservation: the pre-upgrade owner uuid + email must be
    // present unchanged in C, and the re-auth session above must resolve to that uuid.
    const destUsers = await sql<{ id: string; email: string }>(
      cred.dbUrl,
      "select id::text, email from auth.users",
    );
    const ownerInC = destUsers.find((u) => u.id === snapshot.ownerId);
    const authOk =
      !!ownerInC &&
      ownerInC.email === snapshot.ownerEmail &&
      reauth.data.user?.id === snapshot.ownerId;
    checks.push({
      name: "auth-subject-preservation",
      status: authOk ? "pass" : "fail",
      detail:
        `P0 owner ${snapshot.ownerId} <${snapshot.ownerEmail}>; ` +
        `C auth.users ${JSON.stringify(destUsers)}; re-auth subject ${reauth.data.user?.id ?? "none"}`,
    });

    // --- same-behavior scenario lockstep on B and C ---
    log("running the owner-scoped-RLS scenario lockstep on B and C...\n");
    const bBehavior = await runOwnerRlsScenario(
      baseline.baseUrl,
      baseline.publishableKey,
      ownerEmail,
    );
    const cBehavior = await runOwnerRlsScenario(cred.apiUrl, cred.anonKey, ownerEmail);
    const lockstepOk =
      bBehavior.insertOk === cBehavior.insertOk &&
      bBehavior.insertOk &&
      bBehavior.ownerVisibleTitles.join("|") === cBehavior.ownerVisibleTitles.join("|") &&
      bBehavior.anonVisibleCount === cBehavior.anonVisibleCount &&
      bBehavior.anonVisibleCount === 0;
    checks.push({
      name: "rls-behavior-lockstep",
      status: lockstepOk ? "pass" : "fail",
      detail: `B ${JSON.stringify(bBehavior)} vs C ${JSON.stringify(cBehavior)}`,
    });

    // --- baseline retained ---
    const bDbPresent = existsSync(path.join(bWorkdir, "supabase", ".temp", "data.db"));
    checks.push({
      name: "baseline-retained",
      status:
        bDbPresent && bBehavior.ownerVisibleTitles.length >= snapshot.todoIds.length
          ? "pass"
          : "fail",
      detail:
        `baseline B db file present: ${bDbPresent}; B still serves the pre-upgrade rows ` +
        `(${bBehavior.ownerVisibleTitles.length} >= ${snapshot.todoIds.length})`,
    });

    // --- Storage: skipped (was not required) ---
    checks.push({
      name: "storage-preservation",
      status: "skipped",
      detail:
        "unsupported — `lite upgrade` does not carry Storage and the local target runs no storage-api. " +
        "Not required by this workflow; if it were, it would have been rejected before mutation.",
    });

    const ok = checks.every((c) => c.status !== "fail");
    return finish(ok);
  } catch (err) {
    checks.push({ name: "flow", status: "fail", detail: `verify-upgrade aborted: ${String(err)}` });
    return finish(false);
  }
}

function flipOneChar(id: string): string {
  const chars = [...id];
  const i = chars.findIndex((c) => /[0-9a-f]/i.test(c));
  if (i === -1) return id + "x";
  chars[i] = chars[i] === "0" ? "1" : "0";
  return chars.join("");
}

interface OwnerRlsBehavior {
  insertOk: boolean;
  ownerVisibleTitles: string[];
  anonVisibleCount: number;
}

/**
 * The same behavior scenario run against any target: the owner signs in, inserts a
 * new owned row, then owner and anon each read `public.todos`. Owner-scoped RLS must
 * show the owner every owned row and the anon none.
 */
async function runOwnerRlsScenario(
  baseUrl: string,
  anonKey: string,
  ownerEmail: string,
): Promise<OwnerRlsBehavior> {
  const signIn = await createClient(baseUrl, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  }).auth.signInWithPassword({ email: ownerEmail, password: OWNER_PASSWORD });
  const token = signIn.data.session?.access_token;
  const ownerId = signIn.data.user?.id;
  if (!token || !ownerId) {
    return { insertOk: false, ownerVisibleTitles: [], anonVisibleCount: -1 };
  }
  const owner = createClient(baseUrl, anonKey, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const ins = await owner
    .from("todos")
    .insert([{ owner_id: ownerId, title: "lockstep row" }])
    .select();
  const ownerSees = await owner.from("todos").select("title").order("title");
  const anonSees = await createClient(baseUrl, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
    .from("todos")
    .select("title");
  return {
    insertOk: !ins.error,
    ownerVisibleTitles: (ownerSees.data ?? []).map((r: { title: string }) => r.title).sort(),
    anonVisibleCount: anonSees.error ? -1 : (anonSees.data?.length ?? -1),
  };
}
