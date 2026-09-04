import type {
  ClientContract,
  ResourceDeclaration,
  StableId,
  TargetCapability,
  TargetSpec,
} from "@supadiff/spec";
import type {
  ProvisionContext,
  RecoveryRecord,
  TargetDriver,
  TargetSession,
} from "@supadiff/engine/spi";
import { createWorkdir } from "../shared/workdir.js";
import { SUPABASE_CLI_PACKAGE } from "../shared/supabase-cli-cache.js";
import { loadSupabaseJs } from "../shared/package-cache.js";
import { resolveClientContract } from "../shared/supabase-js-client.js";
import { declareSupabaseLocalCapabilities } from "./capabilities.js";
import { forceCleanupProject, scaffoldSupabaseLocalProject, startStack } from "./provision.js";
import { SupabaseLocalTargetSession } from "./session.js";
import { DEFAULT_ROUTE_PREFIXES, type SupabaseLocalTargetConfig } from "./types.js";

export interface SupabaseLocalDriverOptions {
  scenarioResources: readonly ResourceDeclaration[];
  /** CLI version override (L8 upgrade verification drives the same driver at two versions). */
  cliVersion?: string;
  /**
   * The scenario's `ScenarioSpec.client` — the single source of truth for which exact
   * `@supabase/supabase-js` build this target is driven through (and reports as
   * `TargetIdentity.clientVersion`). The wiring layer that holds the parsed `ScenarioSpec`
   * passes it here; omitted → the historical `2.97.0` baseline. An unregistered version
   * fails closed (`resolveClientContract`). Never an env var.
   */
  client?: ClientContract;
}

function defaultConfig(): SupabaseLocalTargetConfig {
  return {
    dbMajorVersion: 17,
    excludedServices: [],
    experimentalFeatures: ["storage"],
    keyMode: "opaque-v1",
    routePrefixes: DEFAULT_ROUTE_PREFIXES,
    analytics: false,
    readinessTimeoutMs: 90_000,
  };
}

/**
 * `supabase-local` `TargetDriver` (§2.9, §13.2; L7). Same SPI shape as the Supalite
 * drivers — imports only `@supadiff/engine/spi` — but provisions a real Supabase stack
 * via a pinned `supabase` CLI over Docker Compose rather than a `lite start` subprocess.
 */
export function createSupabaseLocalDriver(options: SupabaseLocalDriverOptions): TargetDriver {
  const resources = new Map(
    options.scenarioResources.map((r) => [
      r.id,
      { source: r.source as never, sensitivity: r.sensitivity },
    ]),
  );

  return {
    kind: "supabase-local",

    async declareCapabilities(_spec: TargetSpec): Promise<TargetCapability[]> {
      return declareSupabaseLocalCapabilities();
    },

    async provision(spec: TargetSpec, ctx: ProvisionContext): Promise<TargetSession> {
      const config: SupabaseLocalTargetConfig = {
        ...defaultConfig(),
        ...(spec.config as unknown as Partial<SupabaseLocalTargetConfig>),
      };
      // The CLI version to *install* comes from the driver option (L8 drives two), then
      // falls back to the pinned default — never from `spec.package.version`, which the
      // engine owns as the *requested* identity it checks against the observed one (§2.7).
      const cliVersion = options.cliVersion ?? SUPABASE_CLI_PACKAGE.version;
      // Resolve + install the exact client the scenario asks for BEFORE bringing the stack
      // up, so an unregistered client version fails closed without provisioning anything.
      const clientProfile = resolveClientContract(options.client);
      const client = await loadSupabaseJs(clientProfile);
      const workdir = createWorkdir("sd-supabase-local");
      const project = await scaffoldSupabaseLocalProject(workdir.path, config, cliVersion);
      // Record the recovery identifier (§4.2: write-before-allocate is done by the engine's
      // journal; this is the non-secret handle a leaked-resource sweep would target).
      ctx.vault.put("note", `project:${project.projectId}`);
      await startStack(project);
      const handleId = `${ctx.runNamespace}` as StableId;
      return new SupabaseLocalTargetSession(handleId, project, ctx.vault, resources, client);
    },

    async recover(record: RecoveryRecord): Promise<void> {
      // A leaked entry names `project:<projectId>` (the non-secret identifier). Tear down
      // any container/network still bearing that project id — never a broad docker sweep
      // (§19 R-025: only journaled owned resources).
      for (const entry of record.entries) {
        const m = /project:([a-z0-9]+)/.exec(entry.nonSecretIdentifier);
        if (m) await forceCleanupProject(m[1]!);
      }
    },
  };
}
