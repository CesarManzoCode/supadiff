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
import { dataResultToRaw, dispatchRestOperation } from "../shared/rest-dispatch.js";
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

  #serviceClient(): SupabaseClient {
    return createClient(this.#project.baseUrl, this.#project.secretKey, {
      auth: { persistSession: false, autoRefreshToken: false },
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

  async #handleSeed(input: JsonObject): Promise<RawOperationResult> {
    if (!this.#project.process) await startServer(this.#project);
    const table = input["table"] as string;
    const rows = input["rows"] as JsonObject[];
    const res = await this.#serviceClient().from(table).insert(rows).select();
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
      return this.#handleSeed(revealed);
    }
    if (!this.#project.process) await startServer(this.#project);

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
