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
import { dataResultToRaw, dispatchRestOperation } from "../shared/rest-dispatch.js";
import { readResourceText } from "../shared/resources.js";
import { SUPABASE_LOCAL_PINNED_IMAGES } from "../shared/supabase-cli-cache.js";
import { declareSupabaseLocalCapabilities } from "./capabilities.js";
import {
  cleanupWorkdir,
  forceCleanupProject,
  nodeRuntimeIdentity,
  stopStack,
  type SupabaseLocalProvisionedProject,
} from "./provision.js";

/**
 * Standard Data-API exposure grants — the same effect the Supabase cloud default
 * (`auto_expose_new_tables = true`) has via an event trigger: freshly created `public`
 * tables are reachable by the `anon`/`authenticated`/`service_role` roles so that *RLS*,
 * not a missing table privilege, is what authorizes or denies a request. Applied by the
 * driver after every scenario schema step so a scenario authored once runs identically on
 * `supabase-local` and on the Supalite family (whose PostgREST emulation is RLS-only).
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

export class SupabaseLocalTargetSession implements TargetSession {
  readonly handleId: StableId;
  #project: SupabaseLocalProvisionedProject;
  #vault: SecretVault;
  #resources: ReadonlyMap<StableId, { source: JsonObject; sensitivity: string }>;

  constructor(
    handleId: StableId,
    project: SupabaseLocalProvisionedProject,
    vault: SecretVault,
    resources: ReadonlyMap<StableId, { source: JsonObject; sensitivity: string }>,
  ) {
    this.handleId = handleId;
    this.#project = project;
    this.#vault = vault;
    this.#resources = resources;
  }

  get project(): SupabaseLocalProvisionedProject {
    return this.#project;
  }

  async identify(): Promise<TargetIdentity> {
    return {
      targetKind: "supabase-local",
      implementation: "supabase",
      implementationVersion: this.#project.cliVersion,
      runtime: nodeRuntimeIdentity(),
      backend: { backend: "postgres", version: String(this.#project.config.dbMajorVersion) },
      clientVersion: "2.97.0",
      cliVersion: this.#project.cliVersion,
      serviceVersions: Object.fromEntries(
        Object.entries(SUPABASE_LOCAL_PINNED_IMAGES).map(([k, v]) => [k, v.split(":").pop()!]),
      ),
      containerDigests: this.#project.containerDigests,
      platform: { os: process.platform, arch: process.arch },
      effectiveConfigDigest: `sha256:${createHash("sha256")
        .update(
          JSON.stringify({
            cli: this.#project.cliVersion,
            db: this.#project.config.dbMajorVersion,
            storage: this.#project.config.experimentalFeatures,
            images: SUPABASE_LOCAL_PINNED_IMAGES,
          }),
        )
        .digest("hex")}`,
      observedAt: new Date().toISOString(),
    };
  }

  async probeCapabilities(): Promise<TargetCapability[]> {
    const declared = declareSupabaseLocalCapabilities();
    let healthy = false;
    try {
      const res = await fetch(`${this.#project.baseUrl}/auth/v1/health`, {
        signal: AbortSignal.timeout(3000),
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
    if (actor.kind === "service") binding.session = vault.put("session", this.#project.secretKey);
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

  #serviceClient(): SupabaseClient {
    return createClient(this.#project.baseUrl, this.#project.secretKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }

  async #applySql(sql: string): Promise<void> {
    const { default: postgres } = await import("postgres");
    const client = postgres(this.#project.dbUrl, {
      max: 1,
      connect_timeout: 15,
      onnotice: () => {},
    });
    try {
      await client.unsafe(sql);
      await client.unsafe(DATA_API_GRANTS);
    } finally {
      await client.end({ timeout: 5 });
    }
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
      await this.#applySql(await readResourceText(resource.source));
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

  /** True once the Kong gateway stops answering — i.e. the container stack died under us. */
  async #stackReachable(): Promise<boolean> {
    try {
      const res = await fetch(`${this.#project.baseUrl}/auth/v1/health`, {
        signal: AbortSignal.timeout(2000),
      });
      return res.ok || res.status < 500;
    } catch {
      return false;
    }
  }

  async execute(request: OperationRequest, signal: AbortSignal): Promise<RawOperationResult> {
    if (signal.aborted) {
      return { category: "harness-failure", harnessFailureReason: "timeout", durationMs: 0 };
    }
    const started = Date.now();
    try {
      const result = await this.#dispatch(request);
      // supabase-js swallows a transport failure into `{error, status: 0}` rather than
      // throwing, so a dead container stack would otherwise look like an ordinary
      // application error. Reclassify as target loss (§5.4) only after confirming Kong is
      // actually gone — never downgrade a real 4xx/5xx.
      const body = result.responseBody as { status?: number } | undefined;
      const looksLikeTransportLoss =
        result.category === "application-error" && (result.status === 0 || body?.status === 0);
      if (looksLikeTransportLoss && !(await this.#stackReachable())) {
        return {
          category: "harness-failure",
          harnessFailureReason: "target-lost",
          durationMs: Date.now() - started,
        };
      }
      return { ...result, durationMs: Date.now() - started };
    } catch (err) {
      // Distinguish "the whole container stack is gone" (target death, §5.4) from an
      // ordinary transient error, so the engine can finalize `inconclusive` rather than
      // misreport a behavioral result.
      const reachable = await this.#stackReachable();
      return {
        category: "harness-failure",
        harnessFailureReason: reachable ? "driver-invariant" : "target-lost",
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
    try {
      await stopStack(this.#project);
      await forceCleanupProject(this.#project.projectId);
      cleanupWorkdir(this.#project.workdirPath);
      return { status: "complete", leaks: [] };
    } catch (err) {
      return {
        status: "partial",
        leaks: [`supabase-local ${this.#project.projectId}: ${String(err)}`],
      };
    }
  }
}
