import type { ResourceDeclaration, StableId, TargetCapability, TargetSpec } from "@supadiff/spec";
import type {
  ProvisionContext,
  RecoveryRecord,
  TargetDriver,
  TargetSession,
} from "@supadiff/engine/spi";
import { declareSupabaseHostedCapabilities } from "./capabilities.js";
import { HOSTED_ENV } from "./credentials.js";
import { provisionHostedProject, recoverHostedNamespace } from "./provision.js";
import { SupabaseHostedTargetSession } from "./session.js";
import { defaultHostedConfig, type SupabaseHostedTargetConfig } from "./types.js";

export interface SupabaseHostedDriverOptions {
  scenarioResources: readonly ResourceDeclaration[];
  /**
   * Expected project identity. A mismatch against what the Management API actually reports
   * is drift and aborts provisioning before any side effect (§2.7). Typically the caller
   * passes the project ref it configured so an accidental token/ref swap is caught loudly.
   */
  expectedIdentity?: { projectRef?: string; postgresMajor?: string; region?: string };
  /** Environment override (tests); defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
}

/**
 * `supabase-hosted` `TargetDriver` (§2.7, §4.4; L13). Runs a scenario against a *real*
 * hosted Supabase project reached over its public API and the Supabase Management API.
 *
 * Hosted runs are never implicit: `SUPADIFF_HOSTED=1` must be in the environment, the
 * `TargetSpec.safety.allowHosted` flag must be set, and `attach-explicit` refuses a project
 * that already holds `public` tables / Storage buckets / auth users unless
 * `safety.allowHostedDestructive` acknowledges the risk. Teardown removes exactly the
 * resources the run created (diffed against the pre-run census) and nothing else; a crash
 * is recoverable from the non-secret ownership handle alone.
 */
export function createSupabaseHostedDriver(options: SupabaseHostedDriverOptions): TargetDriver {
  const resources = new Map(
    options.scenarioResources.map((r) => [
      r.id,
      { source: r.source as never, sensitivity: r.sensitivity },
    ]),
  );
  const env = options.env ?? process.env;

  return {
    kind: "supabase-hosted",

    async declareCapabilities(_spec: TargetSpec): Promise<TargetCapability[]> {
      return declareSupabaseHostedCapabilities();
    },

    async provision(spec: TargetSpec, ctx: ProvisionContext): Promise<TargetSession> {
      const config: SupabaseHostedTargetConfig = {
        ...defaultHostedConfig(),
        ...(spec.config as unknown as Partial<SupabaseHostedTargetConfig>),
      };
      const project = await provisionHostedProject({
        spec,
        config,
        env,
        runNamespace: ctx.runNamespace,
        expected: options.expectedIdentity,
      });
      // Non-secret recovery handle: `hosted-namespace:<ref>:<runNamespace>` names the
      // ownership row a leaked-resource sweep reads to know exactly what this run created.
      ctx.vault.put("note", `hosted-namespace:${project.projectRef}:${ctx.runNamespace}`);
      const handleId = `${ctx.runNamespace}` as StableId;
      return new SupabaseHostedTargetSession(handleId, project, ctx.vault, resources);
    },

    async recover(record: RecoveryRecord): Promise<void> {
      const accessToken = env[HOSTED_ENV.accessToken]?.trim();
      if (!accessToken) return;
      const baseUrl = env["SUPADIFF_HOSTED_MANAGEMENT_URL"]?.trim() || "https://api.supabase.com";
      for (const entry of record.entries) {
        const m = /hosted-namespace:([a-z0-9]{20}):(.+)/.exec(entry.nonSecretIdentifier);
        if (!m) continue;
        await recoverHostedNamespace({
          projectRef: m[1]!,
          runNamespace: m[2]!,
          accessToken,
          managementApiBaseUrl: baseUrl,
        }).catch(() => undefined);
      }
    },
  };
}
