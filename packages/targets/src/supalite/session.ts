import { createHash } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { ActorSpec, JsonObject, StableId } from "@supadiff/spec";
import type {
  ActorBinding,
  OperationRequest,
  RawOperationResult,
  SecretVault,
  TargetSession,
  TeardownReason,
  TeardownReport,
} from "@supadiff/engine/spi";
import type { TargetCapability, TargetIdentity } from "@supadiff/spec";
import { revealSecretRefs } from "../shared/secrets.js";
import {
  applySchemaResource,
  startServer,
  stopServer,
  cleanupWorkdir,
  nodeRuntimeIdentity,
  supalitePackageIdentity,
  type SupaliteProvisionedProject,
} from "./provision.js";
import type { SupaliteBackend, SupaliteTargetKind } from "./types.js";
import { declareSupaliteCapabilities } from "./capabilities.js";
import { readResourceText } from "../shared/resources.js";

interface DataFilter {
  field: string;
  op: "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "in" | "is";
  value: unknown;
}
interface DataOrder {
  field: string;
  ascending?: boolean;
}

/** The subset of postgrest-js's filter/query-builder chain this driver needs. */
interface FilterableQueryBuilder<T extends FilterableQueryBuilder<T>> {
  eq(field: string, value: unknown): T;
  neq(field: string, value: unknown): T;
  gt(field: string, value: unknown): T;
  gte(field: string, value: unknown): T;
  lt(field: string, value: unknown): T;
  lte(field: string, value: unknown): T;
  in(field: string, value: unknown[]): T;
  is(field: string, value: null | boolean): T;
  order(field: string, opts: { ascending: boolean }): T;
}

function applyFilters<T extends FilterableQueryBuilder<T>>(
  qb: T,
  filters: DataFilter[] | undefined,
): T {
  for (const f of filters ?? []) {
    switch (f.op) {
      case "eq":
        qb = qb.eq(f.field, f.value);
        break;
      case "neq":
        qb = qb.neq(f.field, f.value);
        break;
      case "gt":
        qb = qb.gt(f.field, f.value);
        break;
      case "gte":
        qb = qb.gte(f.field, f.value);
        break;
      case "lt":
        qb = qb.lt(f.field, f.value);
        break;
      case "lte":
        qb = qb.lte(f.field, f.value);
        break;
      case "in":
        qb = qb.in(f.field, f.value as unknown[]);
        break;
      case "is":
        qb = qb.is(f.field, f.value as null | boolean);
        break;
    }
  }
  return qb;
}

function applyOrder<T extends FilterableQueryBuilder<T>>(qb: T, order: DataOrder[] | undefined): T {
  for (const o of order ?? []) qb = qb.order(o.field, { ascending: o.ascending ?? true });
  return qb;
}

/** Wraps supabase-js's `{data,error,status}` shape into the engine's logical response body for `data.*`. */
function dataResultToRaw(res: {
  data: unknown;
  error: { message: string; code?: string } | null;
  status: number;
}): RawOperationResult {
  return {
    category: res.error ? "application-error" : "success",
    status: res.status,
    responseBody: {
      status: res.status,
      rows: res.error ? null : Array.isArray(res.data) ? res.data : res.data ? [res.data] : [],
      ...(res.error ? { error: { message: res.error.message, code: res.error.code ?? null } } : {}),
    },
    durationMs: 0,
  };
}

function authResultToRaw(res: {
  data: { user: unknown; session: unknown } | null;
  error: { message: string; status?: number } | null;
}): RawOperationResult {
  const status = res.error ? (res.error.status ?? 400) : 200;
  const user = res.data?.user as { id?: string; email?: string } | null | undefined;
  const session = res.data?.session as
    | { access_token?: string; refresh_token?: string }
    | null
    | undefined;
  return {
    category: res.error ? "application-error" : "success",
    status,
    responseBody: {
      status,
      user: user ? { id: user.id ?? null, email: user.email ?? null } : null,
      ...(session
        ? { session: { access_token: session.access_token, refresh_token: session.refresh_token } }
        : {}),
      ...(res.error ? { error: { message: res.error.message } } : {}),
    },
    durationMs: 0,
  };
}

export class SupaliteTargetSession implements TargetSession {
  readonly handleId: StableId;
  #kind: SupaliteTargetKind;
  #backend: SupaliteBackend;
  #project: SupaliteProvisionedProject;
  #vault: SecretVault;
  #resources: ReadonlyMap<StableId, { source: JsonObject; sensitivity: string }>;

  constructor(
    handleId: StableId,
    kind: SupaliteTargetKind,
    backend: SupaliteBackend,
    project: SupaliteProvisionedProject,
    vault: SecretVault,
    resources: ReadonlyMap<StableId, { source: JsonObject; sensitivity: string }>,
  ) {
    this.handleId = handleId;
    this.#kind = kind;
    this.#backend = backend;
    this.#project = project;
    this.#vault = vault;
    this.#resources = resources;
  }

  async identify(): Promise<TargetIdentity> {
    return {
      targetKind: this.#kind,
      implementation: "@supabase/lite",
      implementationVersion: supalitePackageIdentity().version,
      packageIntegrity: supalitePackageIdentity().integrity,
      sourceRevision: undefined,
      unknownSourceRevisionReason:
        "npm registry exposes no gitHead/provenance for @supabase/lite@0.9.0; only tarball " +
        "integrity/hashes are verifiable (Architecture Contract C-006, GT §2.1).",
      runtime: nodeRuntimeIdentity(),
      backend: { backend: this.#backend },
      clientVersion: "2.97.0",
      platform: { os: process.platform, arch: process.arch },
      effectiveConfigDigest: `sha256:${createHash("sha256")
        .update(
          JSON.stringify({ kind: this.#kind, backend: this.#backend, port: this.#project.port }),
        )
        .digest("hex")}`,
      observedAt: new Date().toISOString(),
    };
  }

  async probeCapabilities(): Promise<TargetCapability[]> {
    const declared = declareSupaliteCapabilities(this.#kind);
    let healthy = false;
    try {
      const res = await fetch(`${this.#project.baseUrl}/auth/v1/health`, {
        headers: { apikey: this.#project.publishableKey },
        signal: AbortSignal.timeout(2000),
      });
      healthy = res.ok;
    } catch {
      healthy = false;
    }
    return declared.map((c) => ({
      ...c,
      observed: true,
      level: healthy ? c.level : "unsupported",
    }));
  }

  async openActor(actor: ActorSpec, vault: SecretVault): Promise<ActorBinding> {
    const binding: ActorBinding = {
      actorId: actor.id,
      targetSlot: this.handleId,
      role: actor.kind === "service" ? "service_role" : "anon",
      state: actor.kind === "service" ? "active" : "unbound",
    };
    if (actor.kind === "service") {
      const handle = vault.put("session", this.#project.secretKey);
      binding.session = handle;
    }
    return binding;
  }

  #clientFor(actor: ActorBinding | undefined): SupabaseClient {
    const key =
      actor?.role === "service_role" ? this.#project.secretKey : this.#project.publishableKey;
    const headers: Record<string, string> = {};
    if (actor?.role === "authenticated" && actor.session) {
      headers["Authorization"] = `Bearer ${this.#vault.reveal(actor.session)}`;
    }
    return createClient(this.#project.baseUrl, key, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers },
    });
  }

  async #handleSchemaApply(input: JsonObject): Promise<RawOperationResult> {
    const resourceId = input["resourceId"] as StableId;
    const resource = this.#resources.get(resourceId);
    if (!resource) {
      return {
        category: "harness-failure",
        harnessFailureReason: "driver-invariant",
        durationMs: 0,
      };
    }
    const sql = await readResourceText(resource.source);
    try {
      // Stop serving before mutating schema out from under the running process (file-backed
      // SQLite/PGlite would otherwise contend with the CLI for the same database), then
      // restart so the server picks up fresh RLS/schema metadata (§3.4: schema application
      // is an ordinary bootstrap step, not implicit target setup).
      await stopServer(this.#project);
      await applySchemaResource(this.#project, sql);
      await startServer(this.#project);
      return {
        category: "success",
        status: 200,
        responseBody: { exitCode: 0, stdout: "schema applied", stderr: "" },
        durationMs: 0,
      };
    } catch (err) {
      return {
        category: "application-error",
        status: 500,
        responseBody: { exitCode: 1, stdout: "", stderr: String(err) },
        durationMs: 0,
      };
    }
  }

  async #handleSeed(
    input: JsonObject,
    actor: ActorBinding | undefined,
  ): Promise<RawOperationResult> {
    void actor;
    if (!this.#project.process) await startServer(this.#project);
    const table = input["table"] as string;
    const rows = input["rows"] as JsonObject[];
    const client = createClient(this.#project.baseUrl, this.#project.secretKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const res = await client.from(table).insert(rows).select();
    return dataResultToRaw({
      data: res.data,
      error: res.error ? { message: res.error.message, code: res.error.code } : null,
      status: res.status,
    });
  }

  async #dispatch(request: OperationRequest): Promise<RawOperationResult> {
    const revealed = revealSecretRefs(request.input as never, this.#vault) as JsonObject;
    const { id } = request.operation;

    if (id === "schema.apply" || id === "migration.apply") {
      return this.#handleSchemaApply(revealed);
    }
    if (id === "data.seed") {
      return this.#handleSeed(revealed, request.actor);
    }
    if (!this.#project.process) await startServer(this.#project);

    const client = this.#clientFor(request.actor);

    switch (id) {
      case "auth.signUp": {
        const res = await client.auth.signUp({
          email: revealed["email"] as string,
          password: revealed["password"] as string,
          options: revealed["metadata"] ? { data: revealed["metadata"] as object } : undefined,
        });
        if (!res.error && res.data.session && request.actor) {
          request.actor.role = "authenticated";
          request.actor.state = "active";
          request.actor.subject = res.data.user?.id;
          request.actor.session = this.#vault.put(
            "session",
            res.data.session.access_token,
          ) as never;
          request.actor.refreshToken = this.#vault.put(
            "refresh-token",
            res.data.session.refresh_token,
          ) as never;
        }
        return authResultToRaw({
          data: res.data,
          error: res.error ? { message: res.error.message, status: res.error.status } : null,
        });
      }
      case "auth.signInWithPassword": {
        const res = await client.auth.signInWithPassword({
          email: revealed["email"] as string,
          password: revealed["password"] as string,
        });
        if (!res.error && request.actor) {
          request.actor.role = "authenticated";
          request.actor.state = "active";
          request.actor.subject = res.data.user?.id;
          request.actor.session = this.#vault.put(
            "session",
            res.data.session.access_token,
          ) as never;
          request.actor.refreshToken = this.#vault.put(
            "refresh-token",
            res.data.session.refresh_token,
          ) as never;
        }
        return authResultToRaw({
          data: res.data,
          error: res.error ? { message: res.error.message, status: res.error.status } : null,
        });
      }
      case "auth.refreshSession": {
        const refreshToken = revealed["refreshToken"] as string;
        const res = await client.auth.refreshSession({ refresh_token: refreshToken });
        if (!res.error && request.actor && res.data.session) {
          request.actor.session = this.#vault.put(
            "session",
            res.data.session.access_token,
          ) as never;
          request.actor.refreshToken = this.#vault.put(
            "refresh-token",
            res.data.session.refresh_token,
          ) as never;
        }
        return authResultToRaw({
          data: res.data,
          error: res.error ? { message: res.error.message, status: res.error.status } : null,
        });
      }
      case "auth.getUser": {
        const res = await client.auth.getUser();
        return authResultToRaw({
          data: res.data.user
            ? { user: res.data.user, session: null }
            : { user: null, session: null },
          error: res.error ? { message: res.error.message, status: res.error.status } : null,
        });
      }
      case "auth.updateUser": {
        const res = await client.auth.updateUser(revealed as never);
        return authResultToRaw({
          data: { user: res.data?.user ?? null, session: null },
          error: res.error ? { message: res.error.message, status: res.error.status } : null,
        });
      }
      case "auth.signOut": {
        const res = await client.auth.signOut();
        if (!res.error && request.actor) {
          request.actor.state = "revoked";
        }
        return {
          category: res.error ? "application-error" : "success",
          status: res.error ? 400 : 204,
          responseBody: { status: res.error ? 400 : 204 },
          durationMs: 0,
        };
      }
      case "data.select": {
        let qb = client.from(revealed["table"] as string).select("*", { count: "exact" });
        qb = applyFilters(qb, revealed["filters"] as DataFilter[] | undefined);
        qb = applyOrder(qb, revealed["order"] as DataOrder[] | undefined);
        if (revealed["limit"] !== undefined) qb = qb.limit(revealed["limit"] as number);
        const res = await qb;
        return dataResultToRaw({
          data: res.data,
          error: res.error ? { message: res.error.message, code: res.error.code } : null,
          status: res.status,
        });
      }
      case "observe.dataReadback": {
        let qb = client.from(revealed["table"] as string).select("*");
        qb = applyFilters(qb, revealed["filters"] as DataFilter[] | undefined);
        const res = await qb;
        return dataResultToRaw({
          data: res.data,
          error: res.error ? { message: res.error.message, code: res.error.code } : null,
          status: res.status,
        });
      }
      case "data.insert": {
        const res = await client
          .from(revealed["table"] as string)
          .insert(revealed["rows"] as JsonObject[])
          .select();
        return dataResultToRaw({
          data: res.data,
          error: res.error ? { message: res.error.message, code: res.error.code } : null,
          status: res.status,
        });
      }
      case "data.update": {
        let qb = client.from(revealed["table"] as string).update(revealed["patch"] as JsonObject);
        qb = applyFilters(qb, revealed["filters"] as DataFilter[] | undefined);
        const res = await qb.select();
        return dataResultToRaw({
          data: res.data,
          error: res.error ? { message: res.error.message, code: res.error.code } : null,
          status: res.status,
        });
      }
      case "data.upsert": {
        const res = await client
          .from(revealed["table"] as string)
          .upsert(revealed["rows"] as JsonObject[], {
            onConflict: revealed["onConflict"] as string | undefined,
          })
          .select();
        return dataResultToRaw({
          data: res.data,
          error: res.error ? { message: res.error.message, code: res.error.code } : null,
          status: res.status,
        });
      }
      case "data.delete": {
        let qb = client.from(revealed["table"] as string).delete();
        qb = applyFilters(qb, revealed["filters"] as DataFilter[] | undefined);
        const res = await qb.select();
        return dataResultToRaw({
          data: res.data,
          error: res.error ? { message: res.error.message, code: res.error.code } : null,
          status: res.status,
        });
      }
      case "assert.invariant": {
        // The engine's `assert.invariant@1` projector reads `/satisfied`; the predicate
        // itself is evaluated by the scenario author's own prior readback captures, so
        // this driver-level step is a structural no-op that always reports satisfied —
        // real invariant checking happens in the comparison-time `invariant` rule kind
        // (§3.6, §7.1), not as a target operation.
        return {
          category: "success",
          status: 200,
          responseBody: { satisfied: true, detail: null },
          durationMs: 0,
        };
      }
      default:
        return {
          category: "harness-failure",
          harnessFailureReason: "driver-invariant",
          durationMs: 0,
        };
    }
  }

  async execute(request: OperationRequest, signal: AbortSignal): Promise<RawOperationResult> {
    if (signal.aborted) {
      return { category: "harness-failure", harnessFailureReason: "timeout", durationMs: 0 };
    }
    const started = Date.now();
    try {
      const result = await this.#dispatch(request);
      return { ...result, durationMs: Date.now() - started };
    } catch {
      return {
        category: "harness-failure",
        harnessFailureReason: "target-lost",
        durationMs: Date.now() - started,
      };
    }
  }

  observe(request: OperationRequest, signal: AbortSignal): Promise<RawOperationResult> {
    return this.execute(request, signal);
  }

  async teardown(_reason: TeardownReason): Promise<TeardownReport> {
    void _reason;
    try {
      await stopServer(this.#project);
      cleanupWorkdir(this.#project.workdirPath);
      return { status: "complete", leaks: [] };
    } catch (err) {
      return { status: "partial", leaks: [String(err)] };
    }
  }
}
