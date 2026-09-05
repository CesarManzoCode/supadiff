import type { ExactRuntimeIdentity, TargetSpec } from "@supadiff/spec";
import { createClient } from "@supabase/supabase-js";
import {
  HostedProjectDriftError,
  HostedResidentResourcesError,
  ManagementApiError,
} from "./errors.js";
import { readHostedCredentials, type HostedCredentials } from "./credentials.js";
import { enforceHostedSafety, type HostedSafetyDecision } from "./safety.js";
import {
  HttpManagementClient,
  RequestBudget,
  type ManagementClient,
  type HostedProjectInfo,
} from "./management.js";
import type { HostedProjectIdentity, SupabaseHostedTargetConfig } from "./types.js";
import { newHostedEvidence, type HostedEvidence } from "./evidence.js";

/**
 * The schema SupaDiff owns on an attached hosted project to make crash recovery
 * deterministic (§4.2). It never lives in `public`, so it never trips the resident-resource
 * refusal on a later run, and it is dropped once its last row is gone.
 */
const OWNERSHIP_SCHEMA = "supadiff_ownership";

/**
 * The exact pre-run resource census of an attached hosted project. Teardown and recovery
 * remove precisely the resources that appeared *after* this census and nothing that was in
 * it — "deterministic cleanup of exactly what SupaDiff created".
 */
export interface HostedResourceSnapshot {
  publicTables: string[];
  storageBuckets: string[];
  authUserIds: string[];
}

export interface HostedProvisionedProject {
  readonly projectRef: string;
  /** Project API base URL (`https://<ref>.supabase.co`). */
  readonly baseUrl: string;
  readonly anonKey: string;
  readonly serviceRoleKey: string;
  readonly identity: HostedProjectIdentity;
  readonly config: SupabaseHostedTargetConfig;
  readonly runNamespace: string;
  readonly namespacePrefix: string;
  readonly budget: RequestBudget;
  readonly management: ManagementClient;
  readonly snapshot: HostedResourceSnapshot;
  readonly decision: HostedSafetyDecision;
  /** True when this driver created the project itself (`create-ephemeral`). */
  readonly createdEphemeral: boolean;
  readonly evidence: HostedEvidence;
}

export interface ProvisionHostedInput {
  spec: TargetSpec;
  config: SupabaseHostedTargetConfig;
  env: NodeJS.ProcessEnv;
  runNamespace: string;
  /** Expected project identity — a mismatch is drift and aborts before any side effect (§2.7). */
  expected?: { projectRef?: string; postgresMajor?: string; region?: string };
}

function sqlLiteral(v: string): string {
  return `'${v.replace(/'/g, "''")}'`;
}

function identOf(info: HostedProjectInfo): HostedProjectIdentity {
  const major = /^(\d+)/.exec(info.databaseVersion)?.[1] ?? "unknown";
  return {
    postgresVersion: info.databaseVersion,
    postgresMajor: major,
    region: info.region,
    status: info.status,
  };
}

/**
 * The current `public` base tables, straight from `information_schema` — the same source of
 * truth the pre-run census uses, so a caller (e.g. hosted schema-readiness polling, §issue
 * #6) never has to regex-parse an applied SQL resource to know which relations should now be
 * visible through the Data API.
 */
export async function listPublicBaseTables(
  management: ManagementClient,
  ref: string,
): Promise<string[]> {
  const tables = await management.runQuery(
    ref,
    "select table_name as name from information_schema.tables " +
      "where table_schema = 'public' and table_type = 'BASE TABLE' order by 1",
  );
  return tables.rows.map((r) => String(r["name"]));
}

async function captureSnapshot(
  management: ManagementClient,
  ref: string,
): Promise<HostedResourceSnapshot> {
  const publicTables = await listPublicBaseTables(management, ref);
  const buckets = await management.runQuery(
    ref,
    "select id as name from storage.buckets order by 1",
  );
  const users = await management.runQuery(ref, "select id::text as id from auth.users order by 1");
  return {
    publicTables,
    storageBuckets: buckets.rows.map((r) => String(r["name"])),
    authUserIds: users.rows.map((r) => String(r["id"])),
  };
}

async function recordOwnership(
  management: ManagementClient,
  ref: string,
  runNamespace: string,
  snapshot: HostedResourceSnapshot,
): Promise<void> {
  await management.runQuery(
    ref,
    `create schema if not exists ${OWNERSHIP_SCHEMA};
     create table if not exists ${OWNERSHIP_SCHEMA}.runs (
       run_namespace text primary key,
       project_ref text not null,
       pre_public_tables jsonb not null,
       pre_storage_buckets jsonb not null,
       pre_auth_users jsonb not null,
       created_at timestamptz not null default now()
     );
     insert into ${OWNERSHIP_SCHEMA}.runs
       (run_namespace, project_ref, pre_public_tables, pre_storage_buckets, pre_auth_users)
     values (
       ${sqlLiteral(runNamespace)}, ${sqlLiteral(ref)},
       ${sqlLiteral(JSON.stringify(snapshot.publicTables))}::jsonb,
       ${sqlLiteral(JSON.stringify(snapshot.storageBuckets))}::jsonb,
       ${sqlLiteral(JSON.stringify(snapshot.authUserIds))}::jsonb
     )
     on conflict (run_namespace) do update set
       pre_public_tables = excluded.pre_public_tables,
       pre_storage_buckets = excluded.pre_storage_buckets,
       pre_auth_users = excluded.pre_auth_users;`,
  );
}

/**
 * Provisions an attached (or, for `create-ephemeral`, a freshly created) hosted Supabase
 * project. Every safety gate runs *before* the first management-plane side effect
 * (`enforceHostedSafety`), credentials are read from the environment only, and an attached
 * project that already holds `public` tables / Storage buckets / auth users is refused
 * unless `safety.allowHostedDestructive` acknowledges the risk.
 */
export async function provisionHostedProject(
  input: ProvisionHostedInput,
): Promise<HostedProvisionedProject> {
  const { spec, config, env, runNamespace } = input;
  const decision = enforceHostedSafety(spec, config, env);
  const creds: HostedCredentials = readHostedCredentials(env, config);
  const budget = new RequestBudget(config.maxRequests);
  const management = new HttpManagementClient({
    baseUrl: config.managementApiBaseUrl,
    accessToken: creds.accessToken,
    budget,
    timeoutMs: Math.min(config.readinessTimeoutMs, 60_000),
  });
  const evidence = newHostedEvidence(runNamespace);

  if (config.attachMode === "create-ephemeral") {
    return provisionEphemeral(input, { creds, budget, management, decision, evidence });
  }

  const ref = creds.projectRef!;
  if (input.expected?.projectRef && input.expected.projectRef !== ref) {
    throw new HostedProjectDriftError("projectRef", input.expected.projectRef, ref);
  }

  const info = await management.getProject(ref);
  const identity = identOf(info);
  if (input.expected?.postgresMajor && input.expected.postgresMajor !== identity.postgresMajor) {
    throw new HostedProjectDriftError(
      "postgresMajor",
      input.expected.postgresMajor,
      identity.postgresMajor,
    );
  }
  if (input.expected?.region && input.expected.region !== identity.region) {
    throw new HostedProjectDriftError("region", input.expected.region, identity.region);
  }
  if (info.status !== "ACTIVE_HEALTHY") {
    throw new ManagementApiError(
      `GET /v1/projects/${ref}`,
      200,
      `project status is ${info.status}`,
    );
  }

  const keys =
    creds.anonKey && creds.serviceRoleKey
      ? { anonKey: creds.anonKey, serviceRoleKey: creds.serviceRoleKey }
      : await management.getApiKeys(ref);
  const baseUrl = creds.apiUrl ?? `https://${ref}.supabase.co`;

  const snapshot = await captureSnapshot(management, ref);
  if (!decision.allowDestructive) {
    if (snapshot.publicTables.length > 0) {
      throw new HostedResidentResourcesError("tables in public", snapshot.publicTables);
    }
    if (snapshot.storageBuckets.length > 0) {
      throw new HostedResidentResourcesError("Storage buckets", snapshot.storageBuckets);
    }
    if (snapshot.authUserIds.length > 0) {
      throw new HostedResidentResourcesError("auth users", snapshot.authUserIds);
    }
  }

  await recordOwnership(management, ref, runNamespace, snapshot);
  evidence.note("provisioned", {
    projectRef: ref,
    region: identity.region,
    postgresVersion: identity.postgresVersion,
    status: identity.status,
    preExistingPublicTables: snapshot.publicTables.length,
    preExistingBuckets: snapshot.storageBuckets.length,
    preExistingAuthUsers: snapshot.authUserIds.length,
  });

  return {
    projectRef: ref,
    baseUrl,
    anonKey: keys.anonKey,
    serviceRoleKey: keys.serviceRoleKey,
    identity,
    config,
    runNamespace,
    namespacePrefix: config.namespacePrefix,
    budget,
    management,
    snapshot,
    decision,
    createdEphemeral: false,
    evidence,
  };
}

async function provisionEphemeral(
  input: ProvisionHostedInput,
  parts: {
    creds: HostedCredentials;
    budget: RequestBudget;
    management: ManagementClient;
    decision: HostedSafetyDecision;
    evidence: HostedEvidence;
  },
): Promise<HostedProvisionedProject> {
  const { config, runNamespace } = input;
  const { creds, budget, management, decision, evidence } = parts;
  const name = `${config.namespacePrefix}-${runNamespace}`.slice(0, 56);
  const created = await management.createProject({
    name,
    organizationId: creds.organizationId!,
    region: config.region,
    dbPass: creds.dbPassword!,
    plan: config.plan,
  });
  const ref = created.ref;
  const deadline = Date.now() + config.readinessTimeoutMs;
  let info = created;
  while (info.status !== "ACTIVE_HEALTHY" && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 5_000));
    info = await management.getProject(ref);
  }
  if (info.status !== "ACTIVE_HEALTHY") {
    await management.deleteProject(ref).catch(() => undefined);
    throw new ManagementApiError(
      `GET /v1/projects/${ref}`,
      200,
      `created project did not become healthy within ${config.readinessTimeoutMs}ms`,
    );
  }
  const keys = await management.getApiKeys(ref);
  const identity = identOf(info);
  const snapshot: HostedResourceSnapshot = {
    publicTables: [],
    storageBuckets: [],
    authUserIds: [],
  };
  evidence.note("provisioned-ephemeral", { projectRef: ref, region: identity.region });
  return {
    projectRef: ref,
    baseUrl: `https://${ref}.supabase.co`,
    anonKey: keys.anonKey,
    serviceRoleKey: keys.serviceRoleKey,
    identity,
    config,
    runNamespace,
    namespacePrefix: config.namespacePrefix,
    budget,
    management,
    snapshot,
    decision,
    createdEphemeral: true,
    evidence,
  };
}

export interface HostedCleanupResult {
  droppedPublicTables: string[];
  deletedStorageBuckets: string[];
  deletedAuthUsers: string[];
  deletedProject: string | null;
}

function diff(current: string[], baseline: string[]): string[] {
  const base = new Set(baseline);
  return current.filter((x) => !base.has(x)).sort();
}

/**
 * Removes exactly the resources that appeared after `project.snapshot` — new `public`
 * tables, new Storage buckets, new auth users — then forgets this run's ownership row (and
 * drops the ownership schema once no run owns anything). For `create-ephemeral` it deletes
 * the whole project instead. Idempotent: safe to run twice, safe after a partial run.
 */
export async function cleanupHostedProject(
  project: HostedProvisionedProject,
): Promise<HostedCleanupResult> {
  const { management, projectRef: ref } = project;

  if (project.createdEphemeral) {
    await management.deleteProject(ref);
    project.evidence.note("cleanup-ephemeral", { deletedProject: ref });
    return {
      droppedPublicTables: [],
      deletedStorageBuckets: [],
      deletedAuthUsers: [],
      deletedProject: ref,
    };
  }

  const now = await captureSnapshot(management, ref);
  const newTables = diff(now.publicTables, project.snapshot.publicTables);
  const newBuckets = diff(now.storageBuckets, project.snapshot.storageBuckets);
  const newUsers = diff(now.authUserIds, project.snapshot.authUserIds);

  const stmts: string[] = [];
  for (const t of newTables)
    stmts.push(`drop table if exists public."${t.replace(/"/g, '""')}" cascade;`);
  for (const b of newBuckets) {
    stmts.push(`delete from storage.objects where bucket_id = ${sqlLiteral(b)};`);
    stmts.push(`delete from storage.buckets where id = ${sqlLiteral(b)};`);
  }
  if (newUsers.length > 0) {
    // `auth.refresh_tokens.user_id` is `varchar`, the others are `uuid` — compare on `::text`
    // so one statement shape is correct for every child table.
    const list = newUsers.map((u) => sqlLiteral(u)).join(", ");
    stmts.push(`delete from auth.identities where user_id::text in (${list});`);
    stmts.push(`delete from auth.sessions where user_id::text in (${list});`);
    stmts.push(`delete from auth.refresh_tokens where user_id::text in (${list});`);
    stmts.push(`delete from auth.one_time_tokens where user_id::text in (${list});`);
    stmts.push(`delete from auth.mfa_factors where user_id::text in (${list});`);
    stmts.push(`delete from auth.users where id::text in (${list});`);
  }
  stmts.push(
    `delete from ${OWNERSHIP_SCHEMA}.runs where run_namespace = ${sqlLiteral(project.runNamespace)};`,
  );
  stmts.push(
    `do $$ begin
       if not exists (select 1 from ${OWNERSHIP_SCHEMA}.runs) then
         execute 'drop schema ${OWNERSHIP_SCHEMA} cascade';
       end if;
     end $$;`,
  );

  if (stmts.length > 0) await management.runQuery(ref, stmts.join("\n"));

  project.evidence.note("cleanup", {
    droppedPublicTables: newTables,
    deletedStorageBuckets: newBuckets,
    deletedAuthUsers: newUsers.length,
  });

  return {
    droppedPublicTables: newTables,
    deletedStorageBuckets: newBuckets,
    deletedAuthUsers: newUsers,
    deletedProject: null,
  };
}

/**
 * Crash-recovery path (§4.2, §19 R-025): given only the non-secret ownership handle
 * `hosted-namespace:<ref>:<runNamespace>`, re-reads the persisted pre-run census from the
 * project's own `supadiff_ownership.runs` row and removes exactly what that run created.
 * Touches nothing it cannot prove it owns; a no-op when the row is already gone.
 */
export async function recoverHostedNamespace(opts: {
  projectRef: string;
  runNamespace: string;
  accessToken: string;
  managementApiBaseUrl: string;
}): Promise<HostedCleanupResult> {
  const budget = new RequestBudget(200);
  const management = new HttpManagementClient({
    baseUrl: opts.managementApiBaseUrl,
    accessToken: opts.accessToken,
    budget,
  });
  const ref = opts.projectRef;

  const rows = await management.runQuery(
    ref,
    `select 1 from information_schema.tables where table_schema = '${OWNERSHIP_SCHEMA}' and table_name = 'runs'`,
  );
  if (rows.rows.length === 0) {
    return {
      droppedPublicTables: [],
      deletedStorageBuckets: [],
      deletedAuthUsers: [],
      deletedProject: null,
    };
  }
  const owned = await management.runQuery(
    ref,
    `select pre_public_tables, pre_storage_buckets, pre_auth_users from ${OWNERSHIP_SCHEMA}.runs ` +
      `where run_namespace = ${sqlLiteral(opts.runNamespace)}`,
  );
  if (owned.rows.length === 0) {
    return {
      droppedPublicTables: [],
      deletedStorageBuckets: [],
      deletedAuthUsers: [],
      deletedProject: null,
    };
  }
  const row = owned.rows[0]!;
  const asArr = (v: unknown): string[] =>
    Array.isArray(v) ? v.map(String) : typeof v === "string" ? (JSON.parse(v) as string[]) : [];
  const snapshot: HostedResourceSnapshot = {
    publicTables: asArr(row["pre_public_tables"]),
    storageBuckets: asArr(row["pre_storage_buckets"]),
    authUserIds: asArr(row["pre_auth_users"]),
  };

  return cleanupHostedProject({
    projectRef: ref,
    baseUrl: `https://${ref}.supabase.co`,
    anonKey: "",
    serviceRoleKey: "",
    identity: { postgresVersion: "", postgresMajor: "", region: "", status: "" },
    config: {} as SupabaseHostedTargetConfig,
    runNamespace: opts.runNamespace,
    namespacePrefix: "",
    budget,
    management,
    snapshot,
    decision: { estimatedUsd: 0, attachMode: "attach-explicit", allowDestructive: false },
    createdEphemeral: false,
    evidence: newHostedEvidence(opts.runNamespace),
  });
}

export function nodeRuntimeIdentity(): ExactRuntimeIdentity {
  return { runtime: "node", version: process.version };
}

/** Service-role client for the attached project (bucket census, seed, ownership readback). */
export function hostedServiceClient(project: HostedProvisionedProject) {
  return createClient(project.baseUrl, project.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
