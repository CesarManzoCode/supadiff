import type { ResourceDeclaration, TargetSpec } from "@supadiff/spec";
import { FakeTargetDriver, type FakeScript } from "@supadiff/engine";
import type { TargetDriver } from "@supadiff/engine/spi";
import {
  createSupaliteDriver,
  createSupabaseHostedDriver,
  type SupaliteTargetKind,
} from "@supadiff/targets";

const SUPALITE_KINDS = new Set<string>([
  "supalite-sqlite",
  "supalite-sqlite-postgres",
  "supalite-pglite",
  "supalite-postgres",
]);

/**
 * Builds a real `TargetDriver` for one `TargetSpec`, dispatching by `kind` (§9.2: replay
 * "provisions fresh resources from sanitized target recipes"). `fake` recipes carry their
 * whole fixture script inline in `config` (test infrastructure, §15.2); Supalite recipes
 * carry only kind/package/backend/config — the driver reconstructs a fresh real target
 * from that, plus the scenario's own resources for schema/migration steps.
 */
export function buildDriverForSpec(
  spec: TargetSpec,
  scenarioResources: readonly ResourceDeclaration[],
): TargetDriver {
  if (spec.kind === "fake") {
    const config = spec.config as unknown as { scriptId: string; script?: FakeScript };
    if (!config.script) {
      throw new Error(`target "${spec.id}": fake target config is missing an inline "script"`);
    }
    return new FakeTargetDriver({ [config.scriptId]: config.script });
  }
  if (SUPALITE_KINDS.has(spec.kind)) {
    const postgresUrl = process.env["SUPADIFF_SUPALITE_POSTGRES_URL"];
    return createSupaliteDriver(spec.kind as SupaliteTargetKind, {
      scenarioResources,
      postgresUrl,
    });
  }
  if (spec.kind === "supabase-hosted") {
    // Hosted is opt-in only: the driver itself enforces `SUPADIFF_HOSTED=1`,
    // `safety.allowHosted`, the request/cost budget and the resident-resource refusal
    // before any side effect (§2.7, §4.4; L13).
    return createSupabaseHostedDriver({ scenarioResources });
  }
  throw new Error(
    `target "${spec.id}": no driver registered for kind "${spec.kind}" in this build`,
  );
}
