import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import { spawnManaged } from "../shared/process.js";
import { SUPABASE_CLI_PACKAGE } from "../shared/supabase-cli-cache.js";
import {
  cleanupWorkdir,
  forceCleanupProject,
  scaffoldSupabaseLocalProject,
  startStack,
  stopStack,
  type SupabaseLocalProvisionedProject,
} from "./provision.js";
import { DEFAULT_ROUTE_PREFIXES, type SupabaseLocalTargetConfig } from "./types.js";

/**
 * L8 — local Supabase upgrade verification (`supadiff verify-upgrade`).
 *
 * Implements the flow the sprint brief lays out for Architecture Contract §12:
 *  - a **mandatory dry-run** (nothing is provisioned or mutated unless `execute: true`);
 *  - the upgraded stack is brought up in a **fresh destination workdir**, never in place;
 *  - **no session preservation** — a pre-upgrade access token is presented to the new
 *    stack and must be rejected; the user must **re-authenticate** with the same
 *    credentials and get a brand-new session;
 *  - **ID / sequence / Auth / RLS preservation** are each checked against a snapshot
 *    taken before the upgrade;
 *  - **Storage preservation is `unsupported`** and is recorded as a skipped check taken
 *    *before* any Storage mutation, so nothing about Storage is silently claimed.
 *
 * The upgrade mechanism is the documented local path: `pg_dump` the source database,
 * bring up a new stack at the target Postgres major version, and restore. Source and
 * destination stacks run **sequentially** (source stopped before destination starts) so
 * peak memory is one stack, not two.
 */

export type UpgradeCheckStatus = "pass" | "fail" | "skipped";

export interface UpgradeCheck {
  name: string;
  status: UpgradeCheckStatus;
  detail: string;
}

export interface VerifyUpgradeOptions {
  fromMajor: number;
  toMajor: number;
  /** When false (the default), only the dry-run plan is produced — nothing is provisioned. */
  execute?: boolean;
  /** Parent directory for the fresh destination workdir. Defaults to an OS temp dir. */
  destParentDir?: string;
  cliVersion?: string;
  readinessTimeoutMs?: number;
  /** Sink for progress lines (defaults to no-op); the CLI passes `process.stderr.write`. */
  log?: (line: string) => void;
}

export interface VerifyUpgradeReport {
  format: "supadiff.verify-upgrade";
  formatVersion: "1";
  fromMajor: number;
  toMajor: number;
  dryRun: boolean;
  mutated: boolean;
  /** Ordered description of every step the flow runs (always populated, dry-run or not). */
  plan: string[];
  checks: UpgradeCheck[];
  sourceCliVersion?: string;
  destCliVersion?: string;
  destWorkdir?: string;
  ok: boolean;
}

const PLAN = (from: number, to: number): string[] => [
  `dry-run: describe the full flow and exit (this list) unless --execute is passed`,
  `provision a supabase-local stack at Postgres major ${from} in an isolated source workdir`,
  `apply the upgrade fixture schema (todos + owner-scoped RLS, counters with a bigserial sequence)`,
  `sign up an owner via GoTrue, insert owned rows, advance the sequence`,
  `snapshot BEFORE upgrade: row ids, sequence last_value, auth.users, pg_policies`,
  `record Storage-preservation = unsupported (before any Storage mutation)`,
  `capture the owner's pre-upgrade access token`,
  `pg_dump the source database (public schema+data, auth.users/identities data)`,
  `stop the source stack`,
  `provision a NEW supabase-local stack at Postgres major ${to} in a FRESH destination workdir`,
  `restore the dump into the destination database and re-apply Data API grants`,
  `no session preservation: present the pre-upgrade token to the new stack — expect rejection`,
  `re-authenticate: sign in again with the same credentials — expect a new session`,
  `verify ID preservation: destination row ids == snapshot`,
  `verify sequence preservation: destination last_value >= snapshot; next insert does not collide`,
  `verify Auth preservation: destination auth.users == snapshot (same uuid + email)`,
  `verify RLS preservation: destination pg_policies == snapshot; owner sees own row, anon sees none`,
  `Storage preservation: skipped (unsupported) — never claimed`,
  `tear down the destination stack and remove both workdirs`,
];

const FIXTURE_SCHEMA = `
create table public.todos (
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
  id bigint generated always as identity primary key,
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

function localConfig(major: number, readinessTimeoutMs: number): SupabaseLocalTargetConfig {
  return {
    dbMajorVersion: major,
    excludedServices: [],
    experimentalFeatures: [],
    keyMode: "opaque-v1",
    routePrefixes: DEFAULT_ROUTE_PREFIXES,
    analytics: false,
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

async function dockerExecCapture(
  container: string,
  argv: string[],
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const proc = spawnManaged("docker", ["exec", container, ...argv], {
    cwd: process.cwd(),
    env: process.env,
  });
  const res = await proc.waitForExit();
  return { code: res.code, stdout: proc.stdout(), stderr: proc.stderr() };
}

async function dockerExecStdin(
  container: string,
  argv: string[],
  stdin: string,
): Promise<{ code: number | null; stderr: string }> {
  // spawnManaged uses stdio ["ignore","pipe","pipe"]; for stdin we go direct.
  const { spawn } = await import("node:child_process");
  return new Promise((resolve) => {
    const child = spawn("docker", ["exec", "-i", container, ...argv], {
      stdio: ["pipe", "ignore", "pipe"],
    });
    let stderr = "";
    let settled = false;
    const done = (code: number | null): void => {
      if (settled) return;
      settled = true;
      resolve({ code, stderr });
    };
    child.on("error", (e) => {
      stderr += `\n${String(e)}`;
      done(null);
    });
    child.stderr.on("data", (c: Buffer) => (stderr += c.toString("utf8")));
    child.on("close", (code) => done(code));
    child.stdin.on("error", () => {
      /* EPIPE if the child exits before we finish writing — the exit code carries the failure */
    });
    child.stdin.end(stdin);
  });
}

function dbContainer(project: SupabaseLocalProvisionedProject): string {
  return `supabase_db_${project.projectId}`;
}

interface Snapshot {
  rowIds: string[];
  sequenceLastValue: string;
  authUsers: Array<{ id: string; email: string }>;
  policies: Array<{
    policyname: string;
    cmd: string;
    qual: string | null;
    with_check: string | null;
  }>;
}

/** Runs the L8 verify-upgrade flow. In dry-run mode returns only the plan. */
export async function verifyUpgrade(options: VerifyUpgradeOptions): Promise<VerifyUpgradeReport> {
  const log = options.log ?? (() => {});
  const fromMajor = options.fromMajor;
  const toMajor = options.toMajor;
  const cliVersion = options.cliVersion ?? SUPABASE_CLI_PACKAGE.version;
  const readiness = options.readinessTimeoutMs ?? 180_000;
  const plan = PLAN(fromMajor, toMajor);

  if (!options.execute) {
    return {
      format: "supadiff.verify-upgrade",
      formatVersion: "1",
      fromMajor,
      toMajor,
      dryRun: true,
      mutated: false,
      plan,
      checks: [
        {
          name: "dry-run",
          status: "skipped",
          detail:
            "Mandatory dry-run: no stack was provisioned and nothing was mutated. Re-run with " +
            "execute:true (CLI: --execute) to perform the upgrade verification.",
        },
      ],
      ok: true,
    };
  }

  const checks: UpgradeCheck[] = [];
  const destParent = options.destParentDir ?? tmpdir();
  const sourceWorkdir = mkdtempSync(path.join(destParent, "sd-upgrade-src-"));
  const destWorkdir = mkdtempSync(path.join(destParent, "sd-upgrade-dst-"));
  let source: SupabaseLocalProvisionedProject | undefined;
  let dest: SupabaseLocalProvisionedProject | undefined;

  const finish = async (ok: boolean): Promise<VerifyUpgradeReport> => {
    if (dest) await stopStack(dest).catch(() => {});
    if (dest) await forceCleanupProject(dest.projectId).catch(() => {});
    if (source) await stopStack(source).catch(() => {});
    if (source) await forceCleanupProject(source.projectId).catch(() => {});
    cleanupWorkdir(sourceWorkdir);
    cleanupWorkdir(destWorkdir);
    return {
      format: "supadiff.verify-upgrade",
      formatVersion: "1",
      fromMajor,
      toMajor,
      dryRun: false,
      mutated: true,
      plan,
      checks,
      sourceCliVersion: source?.cliVersion,
      destCliVersion: dest?.cliVersion,
      destWorkdir,
      ok,
    };
  };

  try {
    // --- source stack ---
    log(`provisioning source stack (pg ${fromMajor})...\n`);
    source = await scaffoldSupabaseLocalProject(
      sourceWorkdir,
      localConfig(fromMajor, readiness),
      cliVersion,
    );
    await startStack(source);

    await sql(source.dbUrl, FIXTURE_SCHEMA + DATA_API_GRANTS);

    const admin = createClient(source.baseUrl, source.secretKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const email = `upgrade-owner-${Date.now()}@example.test`;
    const password = "upgrade-pw-12345678";
    const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
    if (created.error) throw new Error(`source signup failed: ${created.error.message}`);
    const ownerId = created.data.user.id;

    const signIn = await createClient(source.baseUrl, source.publishableKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    }).auth.signInWithPassword({ email, password });
    if (signIn.error) throw new Error(`source signin failed: ${signIn.error.message}`);
    const preUpgradeToken = signIn.data.session.access_token;

    const ownerClient = createClient(source.baseUrl, source.publishableKey, {
      global: { headers: { Authorization: `Bearer ${preUpgradeToken}` } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const ins = await ownerClient
      .from("todos")
      .insert([
        { owner_id: ownerId, title: "kept row A" },
        { owner_id: ownerId, title: "kept row B" },
      ])
      .select();
    if (ins.error) throw new Error(`source insert failed: ${ins.error.message}`);
    await sql(source.dbUrl, `insert into public.counters (label) values ('a'),('b'),('c');`);

    // --- snapshot BEFORE upgrade ---
    const snap: Snapshot = {
      rowIds: (
        await sql<{ id: string }>(source.dbUrl, `select id from public.todos order by title`)
      ).map((r) => r.id),
      sequenceLastValue: String(
        (
          await sql<{ last_value: string }>(
            source.dbUrl,
            `select last_value from public.counters_id_seq`,
          )
        )[0]?.last_value ?? "0",
      ),
      authUsers: await sql<{ id: string; email: string }>(
        source.dbUrl,
        `select id::text, email from auth.users order by email`,
      ),
      policies: await sql(
        source.dbUrl,
        `select policyname, cmd, qual, with_check from pg_policies where schemaname='public' order by policyname`,
      ),
    };

    checks.push({
      name: "storage-preservation",
      status: "skipped",
      detail:
        "unsupported — recorded before any Storage mutation. The pg_dump-based local upgrade " +
        "path does not carry the Storage volume's object blobs, so Storage byte preservation " +
        "is neither attempted nor claimed (§12).",
    });

    // --- dump ---
    log(`dumping source database...\n`);
    const pubDump = await dockerExecCapture(dbContainer(source), [
      "pg_dump",
      "-U",
      "postgres",
      "-d",
      "postgres",
      "--schema=public",
      "--no-owner",
      "--no-privileges",
    ]);
    if (pubDump.code !== 0) throw new Error(`pg_dump (public) failed: ${pubDump.stderr}`);
    const authDump = await dockerExecCapture(dbContainer(source), [
      "pg_dump",
      "-U",
      "postgres",
      "-d",
      "postgres",
      "--data-only",
      "--table=auth.users",
      "--table=auth.identities",
      "--no-owner",
      "--no-privileges",
    ]);
    if (authDump.code !== 0) throw new Error(`pg_dump (auth) failed: ${authDump.stderr}`);

    // --- stop source, start destination in a fresh workdir ---
    log(`stopping source, provisioning destination stack (pg ${toMajor})...\n`);
    await stopStack(source);
    dest = await scaffoldSupabaseLocalProject(
      destWorkdir,
      localConfig(toMajor, readiness),
      cliVersion,
    );
    await startStack(dest);

    // --- restore ---
    log(`restoring dump into destination...\n`);
    const restorePub = await dockerExecStdin(
      dbContainer(dest),
      ["psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=0", "-q"],
      pubDump.stdout,
    );
    if (restorePub.code !== 0 && !/already exists/.test(restorePub.stderr)) {
      log(`restore (public) stderr: ${restorePub.stderr}\n`);
    }
    const restoreAuth = await dockerExecStdin(
      dbContainer(dest),
      ["psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=0", "-q"],
      `set session_replication_role = replica;\n${authDump.stdout}\nset session_replication_role = default;`,
    );
    if (restoreAuth.code !== 0) log(`restore (auth) stderr: ${restoreAuth.stderr}\n`);
    await sql(dest.dbUrl, DATA_API_GRANTS);

    // --- no session preservation ---
    const oldTokenCheck = await createClient(dest.baseUrl, dest.publishableKey, {
      global: { headers: { Authorization: `Bearer ${preUpgradeToken}` } },
      auth: { persistSession: false, autoRefreshToken: false },
    }).auth.getUser();
    checks.push({
      name: "no-session-preservation",
      status: oldTokenCheck.data.user ? "fail" : "pass",
      detail: oldTokenCheck.data.user
        ? "the pre-upgrade access token was still accepted by the new stack"
        : "the pre-upgrade access token is rejected by the new stack (new JWT secret) — as required",
    });

    // --- reauthentication ---
    const reauth = await createClient(dest.baseUrl, dest.publishableKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    }).auth.signInWithPassword({ email, password });
    const newToken = reauth.data.session?.access_token;
    checks.push({
      name: "reauthentication",
      status: !reauth.error && newToken && newToken !== preUpgradeToken ? "pass" : "fail",
      detail: reauth.error
        ? `re-signin failed: ${reauth.error.message}`
        : "the owner re-authenticated with the same credentials and received a new session",
    });

    // --- ID preservation ---
    const destRowIds = (
      await sql<{ id: string }>(dest.dbUrl, `select id from public.todos order by title`)
    ).map((r) => r.id);
    checks.push({
      name: "id-preservation",
      status:
        destRowIds.length === snap.rowIds.length && destRowIds.every((v, i) => v === snap.rowIds[i])
          ? "pass"
          : "fail",
      detail: `snapshot ${JSON.stringify(snap.rowIds)} vs destination ${JSON.stringify(destRowIds)}`,
    });

    // --- sequence preservation ---
    const destSeq = String(
      (
        await sql<{ last_value: string }>(
          dest.dbUrl,
          `select last_value from public.counters_id_seq`,
        )
      )[0]?.last_value ?? "0",
    );
    const nextCounter = (
      await sql<{ id: string }>(
        dest.dbUrl,
        `insert into public.counters (label) values ('post-upgrade') returning id`,
      )
    )[0]!.id;
    const seqOk =
      BigInt(destSeq) >= BigInt(snap.sequenceLastValue) &&
      BigInt(nextCounter) > BigInt(snap.sequenceLastValue);
    checks.push({
      name: "sequence-preservation",
      status: seqOk ? "pass" : "fail",
      detail: `snapshot last_value=${snap.sequenceLastValue}, destination last_value=${destSeq}, next insert id=${nextCounter} (must not collide with preserved rows)`,
    });

    // --- Auth preservation ---
    const destUsers = await sql<{ id: string; email: string }>(
      dest.dbUrl,
      `select id::text, email from auth.users order by email`,
    );
    const authOk =
      destUsers.length === snap.authUsers.length &&
      destUsers.every(
        (u, i) => u.id === snap.authUsers[i]!.id && u.email === snap.authUsers[i]!.email,
      );
    checks.push({
      name: "auth-preservation",
      status: authOk ? "pass" : "fail",
      detail: `snapshot ${JSON.stringify(snap.authUsers)} vs destination ${JSON.stringify(destUsers)}`,
    });

    // --- RLS preservation (structural + functional) ---
    const destPolicies = await sql<Snapshot["policies"][number]>(
      dest.dbUrl,
      `select policyname, cmd, qual, with_check from pg_policies where schemaname='public' order by policyname`,
    );
    const policiesStructural =
      JSON.stringify(destPolicies) === JSON.stringify(snap.policies) && destPolicies.length >= 2;
    let functionalOk = false;
    if (newToken) {
      const ownerSees = await createClient(dest.baseUrl, dest.publishableKey, {
        global: { headers: { Authorization: `Bearer ${newToken}` } },
        auth: { persistSession: false, autoRefreshToken: false },
      })
        .from("todos")
        .select("*");
      const anonSees = await createClient(dest.baseUrl, dest.publishableKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      })
        .from("todos")
        .select("*");
      functionalOk =
        !ownerSees.error &&
        (ownerSees.data?.length ?? 0) === snap.rowIds.length &&
        !anonSees.error &&
        (anonSees.data?.length ?? 0) === 0;
    }
    checks.push({
      name: "rls-preservation",
      status: policiesStructural && functionalOk ? "pass" : "fail",
      detail:
        `pg_policies preserved: ${policiesStructural} (${destPolicies.length} policies); ` +
        `functional: owner sees own rows / anon denied = ${functionalOk}`,
    });

    const ok = checks.every((c) => c.status !== "fail");
    return finish(ok);
  } catch (err) {
    checks.push({ name: "flow", status: "fail", detail: `verify-upgrade aborted: ${String(err)}` });
    return finish(false);
  } finally {
    try {
      rmSync(sourceWorkdir, { recursive: true, force: true, maxRetries: 2 });
      rmSync(destWorkdir, { recursive: true, force: true, maxRetries: 2 });
    } catch {
      /* already cleaned by finish() */
    }
  }
}
