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
import { scaffoldSupaliteProject, startServer } from "./provision.js";
import { resolveSupaliteProfile, SupaliteProfileError } from "./package-profile.js";
import { SupaliteTargetSession } from "./session.js";
import { declareSupaliteCapabilities } from "./capabilities.js";
import {
  DEFAULT_ROUTE_PREFIXES,
  SUPALITE_BACKEND_BY_KIND,
  type SupaliteTargetKind,
} from "./types.js";
import { createWorkdir } from "../shared/workdir.js";
import type { SupaliteTargetConfig } from "./types.js";

export interface SupaliteDriverOptions {
  /**
   * Resources referenced by the scenario's `schema.apply`/`migration.apply` steps,
   * supplied by the wiring layer (CLI or test harness) that already holds the parsed
   * `ScenarioSpec` — the `TargetDriver`/`TargetSession` SPI (§2.9) intentionally does
   * not thread the scenario itself through `execute()`, only `{resourceId, mode}`.
   */
  scenarioResources: readonly ResourceDeclaration[];
  /** Required only for `supalite-postgres` (§4.4). */
  postgresUrl?: string;
  /**
   * The scenario's `ScenarioSpec.client`. Supalite pins the client per package profile
   * (0.9.0 ↔ 2.97.0, 0.10.0 ↔ 2.114.0); when this is supplied it MUST agree with the
   * profile the `TargetSpec.package` selects — a mismatched (unregistered) combination
   * fails closed here, before provisioning. Never an env var.
   */
  client?: ClientContract;
}

function defaultConfig(kind: SupaliteTargetKind): SupaliteTargetConfig {
  return {
    admin: false,
    forceRollback: false,
    experimentalFeatures: kind === "supalite-sqlite" ? [] : ["storage"],
    keyMode: "opaque-v1",
    routePrefixes: DEFAULT_ROUTE_PREFIXES,
    transport: "socket-server",
    readinessTimeoutMs: 20_000,
  };
}

export function createSupaliteDriver(
  kind: SupaliteTargetKind,
  options: SupaliteDriverOptions,
): TargetDriver {
  const backend = SUPALITE_BACKEND_BY_KIND[kind];
  const resources = new Map(
    options.scenarioResources.map((r) => [
      r.id,
      { source: r.source as never, sensitivity: r.sensitivity },
    ]),
  );

  return {
    kind,

    async declareCapabilities(_spec: TargetSpec): Promise<TargetCapability[]> {
      return declareSupaliteCapabilities(kind);
    },

    async provision(spec: TargetSpec, ctx: ProvisionContext): Promise<TargetSession> {
      const config = (spec.config as unknown as Partial<SupaliteTargetConfig>) ?? {};
      const merged: SupaliteTargetConfig = { ...defaultConfig(kind), ...config };
      // The effective pinned versions come from `TargetSpec.package` — never an env var,
      // never a dist-tag. An unregistered version or a mismatched integrity fails closed here.
      const profile = resolveSupaliteProfile(spec.package);
      // The scenario's client contract, when present, must name exactly the client this
      // profile is pinned to — Supalite provisions only the registered lite↔client pairs.
      if (
        options.client?.library === "supabase-js" &&
        options.client.version !== profile.client.version
      ) {
        throw new SupaliteProfileError(
          `Unregistered combination: scenario asks for @supabase/supabase-js@${options.client.version} ` +
            `but @supabase/lite@${profile.lite.version} is pinned to client ${profile.client.version}. ` +
            `SupaDiff provisions only the registered lite↔client pairs; this fails closed.`,
        );
      }
      const workdir = createWorkdir(`sd-supalite-${backend}`);
      const project = await scaffoldSupaliteProject(
        workdir.path,
        backend,
        merged,
        options.postgresUrl,
        profile,
      );
      // Start serving immediately (with only the system schema) so `identify()`/
      // `probeCapabilities()` observe a live target before any scenario step runs;
      // `schema.apply`/`migration.apply` restart the process once the user schema
      // lands, since that is genuinely required to pick up new RLS/schema metadata.
      await startServer(project);
      const handleId = `${ctx.runNamespace}` as StableId;
      return new SupaliteTargetSession(handleId, kind, backend, project, ctx.vault, resources);
    },

    async recover(_record: RecoveryRecord): Promise<void> {
      // Local Supalite resources are process + workdir only; a leaked entry names a
      // workdir path (§4.2) that `supadiff inspect recovery --recover-owned` can rm -rf.
      // No cross-process PID/port reattachment is attempted here (§19 R-025: only
      // journaled owned resources, never a broad sweep).
    },
  };
}
