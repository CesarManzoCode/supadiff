import { describe, expect, it } from "vitest";
import { runScenario, type TargetHandle } from "@supadiff/engine";
import { parseTargetSpec } from "@supadiff/spec";
import { createSupaliteDriver } from "@supadiff/targets";
import { DataAuthRlsGenerator } from "../../src/generator.js";

/**
 * L12 bounded live sample (§L12 acceptance: "bounded live sample"). Runs a small,
 * fixed number of generated scenarios against a real `@supabase/lite@0.9.0` target --
 * `supalite-sqlite-postgres`, the backend this sprint's L6 work established has
 * working Auth + owner-scoped RLS end to end -- never a fake target. Bounded (5
 * scenarios) so this stays a smoke check, not a second fuzzing campaign; the 10,000-
 * generation validation sweep in `test/generation.test.ts` is what actually exercises
 * generation breadth.
 */
function targetSpecFor(id: string) {
  return parseTargetSpec({
    id,
    kind: "supalite-sqlite-postgres",
    package: { name: "@supabase/lite", version: "0.9.0" },
    runtime: { runtime: "node", version: process.version },
    backend: { backend: "sqlite-postgres" },
    config: {
      admin: false,
      forceRollback: false,
      experimentalFeatures: [],
      keyMode: "opaque-v1",
      routePrefixes: { auth: "/auth/v1", rest: "/rest/v1", storage: "/storage/v1" },
      transport: "socket-server",
      readinessTimeoutMs: 30000,
    },
    credentialRefs: [],
    lifecycle: {
      allocation: "provision-new",
      isolation: "fresh-instance",
      readinessTimeoutMs: 30000,
      teardownTimeoutMs: 10000,
      cleanup: "always",
      keepOnFailure: "deny",
    },
    safety: {
      allowHosted: false,
      allowHostedCreate: false,
      allowHostedDestructive: false,
      maxHostedCostUsd: 0,
    },
  });
}

describe("L12 bounded live sample: generated scenarios against a real Supalite target", () => {
  it("5 generated scenarios each run to completion on supalite-sqlite-postgres", async () => {
    const generator = new DataAuthRlsGenerator();
    const generated = [];
    for await (const gs of generator.generate({
      seed: "live-smoke-1",
      count: 5,
      capabilityEnvelope: [],
    })) {
      generated.push(gs);
    }
    expect(generated).toHaveLength(5);

    for (const { scenario } of generated) {
      const driver = createSupaliteDriver("supalite-sqlite-postgres", {
        scenarioResources: scenario.resources,
      });
      const handle: TargetHandle = {
        slot: "t",
        spec: targetSpecFor(scenario.id),
        driver,
      };
      const result = await runScenario(scenario, [handle]);
      expect(result.state, `${scenario.id} did not complete: ${result.state}`).toBe("complete");

      // Raw observations are only captured for operations with a registered semantic
      // projector (auth.signUp, data.select, data.insert); schema.apply/data.update/
      // data.delete still execute and gate `result.state`, just without evidence capture
      // here, so only assert success directly for the projected subset.
      const target = result.targets.get("t")!;
      for (const step of scenario.steps) {
        const raw = target.rawObservations.get(`${step.id}:1`);
        if (!raw) continue;
        expect(
          raw.outcome.category,
          `${step.id} in ${scenario.id} did not succeed: ${JSON.stringify(raw.transport.responseBody)}`,
        ).toBe("success");
      }
    }
  }, 120_000);
});
