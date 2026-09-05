import { createHash } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type {
  ActorSpec,
  JsonObject,
  StableId,
  TargetCapability,
  TargetIdentity,
} from "@supadiff/spec";
import type {
  ActorBinding,
  OperationRequest,
  RawOperationResult,
  SecretVault,
  TargetSession,
  TeardownReason,
  TeardownReport,
} from "@supadiff/engine/spi";
import { revealSecretRefs } from "../shared/secrets.js";
import {
  authResultToRaw,
  dataResultToRaw,
  dispatchRestOperation,
} from "../shared/rest-dispatch.js";
import { readResourceText } from "../shared/resources.js";
import { declareSupabaseHostedCapabilities } from "./capabilities.js";
import { hostedSecretLiterals } from "./credentials.js";
import { HostedRateLimitError } from "./errors.js";
import {
  cleanupHostedProject,
  listPublicBaseTables,
  nodeRuntimeIdentity,
  type HostedProvisionedProject,
} from "./provision.js";
import { awaitSchemaReadiness, type SchemaReadinessProbeResult } from "./schema-readiness.js";

/**
 * Bounded poll for hosted `schema.apply` readiness (issue #6): PostgREST's schema-cache
 * reload triggered by `notify pgrst, 'reload schema'` is asynchronous, so a `schema.apply`
 * that returns immediately can race the very next Data API operation. 20 attempts × 250ms
 * gives up to ~5s for the cache to converge — small relative to the run's overall budget,
 * but enough headroom for real hosted reload latency — before failing closed.
 */
const SCHEMA_READINESS_MAX_ATTEMPTS = 20;
const SCHEMA_READINESS_DELAY_MS = 250;

/**
 * The same Data-API exposure grants `supabase-local` applies after every scenario schema
 * step (the hosted platform's `auto_expose_new_tables` event trigger has the same effect
 * for `public` tables, but re-applying keeps a scenario authored once byte-identical across
 * `supabase-local` and `supabase-hosted`). Runs through the Management API `database/query`
 * endpoint as the `postgres` role.
 */
const DATA_API_GRANTS = `
grant usage on schema public to anon, authenticated, service_role;
grant all on all tables in schema public to anon, authenticated, service_role;
grant all on all sequences in schema public to anon, authenticated, service_role;
grant all on all routines in schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
notify pgrst, 'reload schema';
`;

export class SupabaseHostedTargetSession implements TargetSession {
  readonly handleId: StableId;
  #project: HostedProvisionedProject;
  #vault: SecretVault;
  #resources: ReadonlyMap<StableId, { source: JsonObject; sensitivity: string }>;

  constructor(
    handleId: StableId,
    project: HostedProvisionedProject,
    vault: SecretVault,
    resources: ReadonlyMap<StableId, { source: JsonObject; sensitivity: string }>,
  ) {
    this.handleId = handleId;
    this.#project = project;
    this.#vault = vault;
    this.#resources = resources;
  }

  get project(): HostedProvisionedProject {
    return this.#project;
  }

  async identify(): Promise<TargetIdentity> {
    const p = this.#project;
    return {
      targetKind: "supabase-hosted",
      implementation: "supabase-platform",
      implementationVersion: p.identity.postgresVersion,
      runtime: nodeRuntimeIdentity(),
      backend: { backend: "postgres", version: p.identity.postgresMajor },
      clientVersion: "2.97.0",
      serviceVersions: { postgres: p.identity.postgresVersion },
      platform: { os: process.platform, arch: process.arch },
      effectiveConfigDigest: `sha256:${createHash("sha256")
        .update(
          JSON.stringify({
            projectRef: p.projectRef,
            region: p.identity.region,
            postgres: p.identity.postgresVersion,
            attachMode: p.config.attachMode,
            namespacePrefix: p.namespacePrefix,
            routePrefixes: p.config.routePrefixes,
          }),
        )
        .digest("hex")}`,
      observedAt: new Date().toISOString(),
    };
  }

  async probeCapabilities(): Promise<TargetCapability[]> {
    const declared = declareSupabaseHostedCapabilities();
    let healthy = false;
    try {
      const res = await fetch(`${this.#project.baseUrl}/auth/v1/health`, {
        headers: { apikey: this.#project.anonKey },
        signal: AbortSignal.timeout(5000),
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
      binding.session = vault.put("session", this.#project.serviceRoleKey);
    }
    return binding;
  }

  #clientFor(actor: ActorBinding | undefined): SupabaseClient {
    const key =
      actor?.role === "service_role" ? this.#project.serviceRoleKey : this.#project.anonKey;
    const headers: Record<string, string> = {};
    if (actor?.role === "authenticated" && actor.session) {
      headers["Authorization"] = `Bearer ${this.#vault.reveal(actor.session)}`;
    }
    return createClient(this.#project.baseUrl, key, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers },
    });
  }

  #serviceClient(): SupabaseClient {
    return createClient(this.#project.baseUrl, this.#project.serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }

  /**
   * A single Data-API visibility probe for one `public` table (issue #6 readiness poll,
   * service-role so RLS is never a confounder). `limit(0)` keeps the request cheap while
   * still returning a full response body — unlike a HEAD request, whose empty body would
   * hide the `PGRST205` code a HEAD 404 carries no payload for.
   */
  async #probeTableReadiness(table: string): Promise<SchemaReadinessProbeResult> {
    this.#project.budget.spend();
    const res = await this.#serviceClient().from(table).select("*", { count: "exact" }).limit(0);
    if (!res.error) return { status: "ready" };
    if (res.error.code === "PGRST205") return { status: "not-ready" };
    return {
      status: "error",
      error: new Error(
        `hosted schema readiness: Data API probe for "${table}" failed with an unrelated ` +
          `error: ${res.error.message} (code=${res.error.code ?? "none"})`,
      ),
    };
  }

  async #handleSchemaApply(input: JsonObject): Promise<RawOperationResult> {
    const resource = this.#resources.get(input["resourceId"] as StableId);
    if (!resource) {
      return {
        category: "harness-failure",
        harnessFailureReason: "driver-invariant",
        durationMs: 0,
      };
    }
    try {
      const sql = await readResourceText(resource.source);
      await this.#project.management.runQuery(
        this.#project.projectRef,
        `${sql}\n${DATA_API_GRANTS}`,
      );
      const tables = await listPublicBaseTables(this.#project.management, this.#project.projectRef);
      await awaitSchemaReadiness({
        tables,
        probe: (table) => this.#probeTableReadiness(table),
        maxAttempts: SCHEMA_READINESS_MAX_ATTEMPTS,
        delayMs: SCHEMA_READINESS_DELAY_MS,
      });
      this.#project.evidence.note("schema.apply", {
        resourceId: input["resourceId"],
        bytes: sql.length,
      });
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

  /**
   * `auth.signUp` on the hosted platform. The dedicated `supadiff-v1-smoke` project has no
   * SMTP configured and the supplied project-scoped Management token cannot toggle
   * `mailer_autoconfirm`, so the public `/signup` mailer flow cannot complete. This uses the
   * *real* GoTrue admin API (`auth.admin.createUser` with `email_confirm: true`) to create
   * the confirmed user, then a *real* GoTrue password grant (`signInWithPassword`) to obtain
   * the session — both genuine hosted GoTrue, never a mock. Documented in docs/TARGETS.md.
   */
  async #handleHostedSignUp(
    request: OperationRequest,
    revealed: JsonObject,
  ): Promise<RawOperationResult> {
    const email = revealed["email"] as string;
    const password = revealed["password"] as string;
    const admin = this.#serviceClient();
    const created = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: (revealed["metadata"] as object | undefined) ?? undefined,
    });
    if (created.error) {
      return authResultToRaw({
        data: null,
        error: { message: created.error.message, status: created.error.status },
      });
    }
    const anon = createClient(this.#project.baseUrl, this.#project.anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const signIn = await anon.auth.signInWithPassword({ email, password });
    if (signIn.error || !signIn.data.session) {
      return authResultToRaw({
        data: { user: created.data.user, session: null },
        error: signIn.error
          ? { message: signIn.error.message, status: signIn.error.status }
          : { message: "hosted signup: no session returned from password grant", status: 500 },
      });
    }
    if (request.actor) {
      request.actor.role = "authenticated";
      request.actor.state = "active";
      request.actor.subject = signIn.data.user?.id;
      request.actor.session = this.#vault.put("session", signIn.data.session.access_token) as never;
      request.actor.refreshToken = this.#vault.put(
        "refresh-token",
        signIn.data.session.refresh_token,
      ) as never;
    }
    this.#project.evidence.note("auth.signUp", { subject: signIn.data.user?.id ?? null });
    return authResultToRaw({
      data: { user: signIn.data.user, session: signIn.data.session },
      error: null,
    });
  }

  async #handleSeed(input: JsonObject): Promise<RawOperationResult> {
    const res = await this.#serviceClient()
      .from(input["table"] as string)
      .insert(input["rows"] as JsonObject[])
      .select();
    return dataResultToRaw({
      data: res.data,
      error: res.error ? { message: res.error.message, code: res.error.code } : null,
      status: res.status,
    });
  }

  async #dispatch(request: OperationRequest): Promise<RawOperationResult> {
    const revealed = revealSecretRefs(request.input as never, this.#vault) as JsonObject;
    const { id } = request.operation;
    if (id === "schema.apply" || id === "migration.apply") return this.#handleSchemaApply(revealed);
    if (id === "auth.signUp") return this.#handleHostedSignUp(request, revealed);
    if (id === "data.seed") return this.#handleSeed(revealed);

    const result = await dispatchRestOperation(request, revealed, {
      clientForActor: (actor) => this.#clientFor(actor),
      serviceClient: () => this.#serviceClient(),
      vault: this.#vault,
      resources: this.#resources,
    });
    return (
      result ?? {
        category: "harness-failure",
        harnessFailureReason: "driver-invariant",
        durationMs: 0,
      }
    );
  }

  async execute(request: OperationRequest, signal: AbortSignal): Promise<RawOperationResult> {
    if (signal.aborted) {
      return { category: "harness-failure", harnessFailureReason: "timeout", durationMs: 0 };
    }
    const started = Date.now();
    try {
      // Every data-plane operation counts against the per-run request cap, exactly as the
      // management-plane calls do — hitting it aborts rather than spending further.
      this.#project.budget.spend();
      const result = await this.#dispatch(request);
      return { ...result, durationMs: Date.now() - started };
    } catch (err) {
      if (err instanceof HostedRateLimitError) {
        return {
          category: "harness-failure",
          harnessFailureReason: "driver-invariant",
          responseBody: { error: err.message },
          durationMs: Date.now() - started,
        };
      }
      return {
        category: "harness-failure",
        harnessFailureReason: "target-lost",
        responseBody: { error: String(err) },
        durationMs: Date.now() - started,
      };
    }
  }

  observe(request: OperationRequest, signal: AbortSignal): Promise<RawOperationResult> {
    return this.execute(request, signal);
  }

  async teardown(_reason: TeardownReason): Promise<TeardownReport> {
    void _reason;
    const p = this.#project;
    try {
      const result = await cleanupHostedProject(p);
      p.evidence.redact(
        hostedSecretLiterals(
          {
            accessToken: "",
            projectRef: p.projectRef,
          },
          { anonKey: p.anonKey, serviceRoleKey: p.serviceRoleKey },
        ),
      );
      const leaked =
        result.droppedPublicTables.length === 0 &&
        result.deletedStorageBuckets.length === 0 &&
        result.deletedAuthUsers.length === 0 &&
        result.deletedProject === null;
      void leaked;
      return { status: "complete", leaks: [] };
    } catch (err) {
      return {
        status: "partial",
        leaks: [`supabase-hosted ${p.projectRef}/${p.runNamespace}: ${String(err)}`],
      };
    }
  }
}
