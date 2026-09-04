import { describe, expect, it } from "vitest";
import { buildExecutionPlan, ClientIdentityMismatchError } from "../../src/index.js";
import { fakeIdentity, fakeTargetSpec, twoStepScenario } from "../fixtures/fake-scenario.js";

/**
 * The client-contract invariant (§2.7): `ScenarioSpec.client.version` is the single source
 * of truth for the `@supabase/supabase-js` build every target must be driven through in
 * one run. `buildExecutionPlan` fails closed if any target's OBSERVED
 * `TargetIdentity.clientVersion` disagrees — a peer comparison is only apples-to-apples
 * when reference and candidate call their targets through the exact same client.
 *
 * Enforced only for `library: "supabase-js"` and only for targets that declare a
 * `TargetSpec.package` (a `fake` target drives no real client).
 */

const POLICY = {
  format: "supadiff.comparison-policy" as const,
  formatVersion: "1.0" as const,
  policyId: "p",
  policyVersion: "1",
  rules: [],
};

/** A target whose declared package version matches its observed implementation version. */
function realTarget(slot: string, role: "reference" | "candidate", clientVersion: string) {
  return {
    slot,
    spec: {
      ...fakeTargetSpec(slot, slot),
      kind: "supalite-sqlite-postgres" as const,
      package: { name: "@supabase/lite", version: "0.9.0" },
    } as never,
    role,
    identity: fakeIdentity({ implementationVersion: "0.9.0", clientVersion }),
    capabilityResolution: [],
  };
}

function plan(clientVersion: string, refClient: string, candClient: string) {
  return buildExecutionPlan({
    scenario: twoStepScenario({ client: { library: "supabase-js", version: clientVersion } }),
    policy: POLICY,
    mode: "peer",
    targets: [
      realTarget("reference", "reference", refClient),
      realTarget("candidate", "candidate", candClient),
    ],
    maxParallelOperations: 1,
    now: () => "2026-09-03T00:00:00.000Z",
  });
}

describe("ExecutionPlan: client-identity agreement (§2.7)", () => {
  it("scenario client 2.97.0 + identities 2.97.0 / 2.97.0 → a plan is frozen", () => {
    expect(() => plan("2.97.0", "2.97.0", "2.97.0")).not.toThrow();
  });

  it("scenario client 2.114.0 + identities 2.114.0 / 2.114.0 → a plan is frozen", () => {
    expect(() => plan("2.114.0", "2.114.0", "2.114.0")).not.toThrow();
  });

  it("scenario client 2.114.0 + reference observed 2.97.0 → fails closed", () => {
    expect(() => plan("2.114.0", "2.97.0", "2.114.0")).toThrow(ClientIdentityMismatchError);
  });

  it("scenario client 2.97.0 + candidate observed 2.114.0 → fails closed", () => {
    expect(() => plan("2.97.0", "2.97.0", "2.114.0")).toThrow(ClientIdentityMismatchError);
  });

  it("a `fake` target is exempt — its placeholder clientVersion is not checked", () => {
    // `twoStepScenario` declares `client: supabase-js@2.97.0`; `fakeIdentity` reports 0.0.0,
    // and the fake spec carries no `package` — so the client check is skipped.
    expect(() =>
      buildExecutionPlan({
        scenario: twoStepScenario(),
        policy: POLICY,
        mode: "peer",
        targets: [
          {
            slot: "reference",
            spec: fakeTargetSpec("reference", "ref") as never,
            role: "reference",
            identity: fakeIdentity(), // clientVersion "0.0.0", no package on the spec
            capabilityResolution: [],
          },
        ],
        maxParallelOperations: 1,
        now: () => "2026-09-03T00:00:00.000Z",
      }),
    ).not.toThrow();
  });
});
