import { describe, expect, it } from "vitest";
import {
  buildExecutionPlan,
  IncompletePlanInputError,
  TargetIdentityMismatchError,
  FakeTargetDriver,
  runScenario,
  scanPlanForSecretsOrEndpoints,
  type FakeScript,
} from "../../src/index.js";
import {
  exactCapability,
  fakeIdentity,
  fakeTargetSpec,
  twoStepScenario,
} from "../fixtures/fake-scenario.js";

function fixedClock() {
  let n = 0;
  return () => new Date(Date.UTC(2026, 0, 1, 0, 0, n++)).toISOString();
}

function baseScript(overrides: Partial<FakeScript> = {}): FakeScript {
  return {
    identity: fakeIdentity(),
    declaredCapabilities: [exactCapability("data.select"), exactCapability("auth.password.signup")],
    steps: {
      "step.signup": {
        category: "success",
        status: 200,
        body: {
          status: "success",
          user: { id: "owner-abc-123", email: "owner@example.test" },
          session: { access_token: "t", refresh_token: "r", expires_in: 1 },
        },
      },
      "step.select": {
        category: "success",
        status: 200,
        body: { status: "success", rows: [{ id: 1 }] },
      },
    },
    teardownStatus: "complete",
    ...overrides,
  };
}

describe("ExecutionPlan: ordering invariant (§5.1) — cannot be frozen before runtime probes complete", () => {
  it("throws IncompletePlanInputError when a target's identity is missing (probes never ran)", () => {
    const scenario = twoStepScenario();
    expect(() =>
      buildExecutionPlan({
        scenario,
        policy: {
          format: "supadiff.comparison-policy",
          formatVersion: "1.0",
          policyId: "p",
          policyVersion: "1",
          rules: [],
        },
        mode: "peer",
        targets: [
          {
            slot: "reference",
            spec: fakeTargetSpec("reference", "ref") as never,
            role: "reference",
            identity: undefined, // never probed
            capabilityResolution: [],
          },
        ],
        maxParallelOperations: 1,
        now: () => "2026-09-03T00:00:00.000Z",
      }),
    ).toThrow(IncompletePlanInputError);
  });

  it("a real runScenario() run only carries a plan once probing genuinely completed", async () => {
    const driver = new FakeTargetDriver({ ref: baseScript() });
    const scenario = twoStepScenario();
    const result = await runScenario(
      scenario,
      [{ slot: "reference", spec: fakeTargetSpec("reference", "ref"), driver }],
      { clock: fixedClock() },
    );
    expect(result.state).toBe("complete");
    expect(result.plan).toBeDefined();
    expect(result.plan!.format).toBe("supadiff.plan");
    expect(result.plan!.targetSlots).toHaveLength(1);
    expect(result.plan!.targetSlots[0]!.identity.observedAt).toBeDefined();
  });
});

describe("ExecutionPlan: target identity mismatch prevents an executable plan (§2.7)", () => {
  it("a requested package version that disagrees with the observed identity yields inconclusive, not a frozen plan", async () => {
    const spec = {
      ...fakeTargetSpec("reference", "ref"),
      package: { name: "supalite", version: "0.9.0" },
    };
    const driver = new FakeTargetDriver({
      ref: baseScript({ identity: fakeIdentity({ implementationVersion: "0.5.0" }) }), // drifted
    });
    const scenario = twoStepScenario();
    const result = await runScenario(
      scenario,
      [{ slot: "reference", spec: spec as never, driver }],
      {
        clock: fixedClock(),
      },
    );
    expect(result.state).toBe("inconclusive");
    expect(result.plan).toBeUndefined();
  });

  it("buildExecutionPlan itself throws TargetIdentityMismatchError for the same condition", () => {
    const scenario = twoStepScenario();
    const spec = {
      ...fakeTargetSpec("reference", "ref"),
      package: { name: "supalite", version: "0.9.0" },
    };
    expect(() =>
      buildExecutionPlan({
        scenario,
        policy: {
          format: "supadiff.comparison-policy",
          formatVersion: "1.0",
          policyId: "p",
          policyVersion: "1",
          rules: [],
        },
        mode: "peer",
        targets: [
          {
            slot: "reference",
            spec: spec as never,
            role: "reference",
            identity: fakeIdentity({ implementationVersion: "0.5.0" }),
            capabilityResolution: [],
          },
        ],
        maxParallelOperations: 1,
        now: () => "2026-09-03T00:00:00.000Z",
      }),
    ).toThrow(TargetIdentityMismatchError);
  });

  it("does NOT throw when the requested and observed versions agree", () => {
    const scenario = twoStepScenario();
    const spec = {
      ...fakeTargetSpec("reference", "ref"),
      package: { name: "supalite", version: "1.0.0" },
    };
    expect(() =>
      buildExecutionPlan({
        scenario,
        policy: {
          format: "supadiff.comparison-policy",
          formatVersion: "1.0",
          policyId: "p",
          policyVersion: "1",
          rules: [],
        },
        mode: "peer",
        targets: [
          {
            slot: "reference",
            spec: spec as never,
            role: "reference",
            identity: fakeIdentity({ implementationVersion: "1.0.0" }),
            capabilityResolution: [],
          },
        ],
        maxParallelOperations: 1,
        now: () => "2026-09-03T00:00:00.000Z",
      }),
    ).not.toThrow();
  });
});

describe("ExecutionPlan: capabilityResolution is present and populated", () => {
  it("carries a resolution entry per requirement per target", () => {
    const scenario = twoStepScenario();
    const plan = buildExecutionPlan({
      scenario,
      policy: {
        format: "supadiff.comparison-policy",
        formatVersion: "1.0",
        policyId: "p",
        policyVersion: "1",
        rules: [],
      },
      mode: "peer",
      targets: [
        {
          slot: "reference",
          spec: fakeTargetSpec("reference", "ref") as never,
          role: "reference",
          identity: fakeIdentity(),
          capabilityResolution: [
            {
              requirement: { capability: "data.select", range: "^1.0.0", accept: ["exact"] },
              status: "satisfied",
              matchedCapability: exactCapability("data.select"),
            },
          ],
        },
      ],
      maxParallelOperations: 1,
      now: () => "2026-09-03T00:00:00.000Z",
    });
    expect(plan.capabilityResolution).toHaveLength(1);
    expect(plan.capabilityResolution[0]).toMatchObject({
      targetSlot: "reference",
      capability: "data.select",
      status: "satisfied",
      level: "exact",
    });
  });
});

describe("ExecutionPlan: determinism (§2.3)", () => {
  function samePlanInputs() {
    const scenario = twoStepScenario();
    const policy = {
      format: "supadiff.comparison-policy" as const,
      formatVersion: "1.0" as const,
      policyId: "p",
      policyVersion: "1",
      rules: [],
    };
    const targets = [
      {
        slot: "reference",
        spec: fakeTargetSpec("reference", "ref") as never,
        role: "reference" as const,
        identity: fakeIdentity(),
        capabilityResolution: [],
      },
    ];
    return { scenario, policy, targets };
  }

  it("same scenario/identity/policy produces the same planId, scenarioDigest, and policyDigest across two builds", () => {
    const { scenario, policy, targets } = samePlanInputs();
    const planA = buildExecutionPlan({
      scenario,
      policy,
      mode: "peer",
      targets,
      maxParallelOperations: 1,
      now: () => "2026-09-03T00:00:00.000Z",
    });
    const planB = buildExecutionPlan({
      scenario,
      policy,
      mode: "peer",
      targets,
      maxParallelOperations: 1,
      now: () => "2026-09-03T05:00:00.000Z",
    });
    expect(planA.planId).toBe(planB.planId);
    expect(planA.scenarioDigest).toBe(planB.scenarioDigest);
    expect(planA.policyDigest).toBe(planB.policyDigest);
    expect(planA.targetSlots).toEqual(planB.targetSlots);
    expect(planA.capabilityResolution).toEqual(planB.capabilityResolution);
    // createdAt is explicitly allowed to differ (§2.3: it is timing metadata, not plan content).
    expect(planA.createdAt).not.toBe(planB.createdAt);
  });

  it("a different observed identity changes the planId (content-derived, not random)", () => {
    const { scenario, policy, targets } = samePlanInputs();
    const planA = buildExecutionPlan({
      scenario,
      policy,
      mode: "peer",
      targets,
      maxParallelOperations: 1,
      now: () => "2026-09-03T00:00:00.000Z",
    });
    const targetsB = [
      { ...targets[0]!, identity: fakeIdentity({ implementationVersion: "2.0.0" }) },
    ];
    const planB = buildExecutionPlan({
      scenario,
      policy,
      mode: "peer",
      targets: targetsB,
      maxParallelOperations: 1,
      now: () => "2026-09-03T00:00:00.000Z",
    });
    expect(planA.planId).not.toBe(planB.planId);
  });
});

describe("ExecutionPlan: no secrets, no live endpoints in the serialized plan (§2.3, §6.4)", () => {
  it("scanPlanForSecretsOrEndpoints finds nothing in a normal plan", () => {
    const scenario = twoStepScenario();
    const plan = buildExecutionPlan({
      scenario,
      policy: {
        format: "supadiff.comparison-policy",
        formatVersion: "1.0",
        policyId: "p",
        policyVersion: "1",
        rules: [],
      },
      mode: "peer",
      targets: [
        {
          slot: "reference",
          spec: fakeTargetSpec("reference", "ref") as never,
          role: "reference",
          identity: fakeIdentity(),
          capabilityResolution: [],
        },
      ],
      maxParallelOperations: 1,
      now: () => "2026-09-03T00:00:00.000Z",
    });
    expect(scanPlanForSecretsOrEndpoints(plan)).toEqual([]);
    expect(JSON.stringify(plan)).not.toMatch(/https?:\/\//);
  });

  it("a plan built from a full runScenario() run (with actor secrets in play) is still secret-free", async () => {
    const driver = new FakeTargetDriver({ ref: baseScript() });
    const scenario = twoStepScenario();
    const result = await runScenario(
      scenario,
      [{ slot: "reference", spec: fakeTargetSpec("reference", "ref"), driver }],
      { clock: fixedClock() },
    );
    expect(result.plan).toBeDefined();
    expect(scanPlanForSecretsOrEndpoints(result.plan!)).toEqual([]);
  });
});

describe("ExecutionPlan: the executor consumes the frozen plan, never re-decides target identity/capabilities", () => {
  it("the returned plan object is frozen (Object.isFrozen)", () => {
    const scenario = twoStepScenario();
    const plan = buildExecutionPlan({
      scenario,
      policy: {
        format: "supadiff.comparison-policy",
        formatVersion: "1.0",
        policyId: "p",
        policyVersion: "1",
        rules: [],
      },
      mode: "peer",
      targets: [
        {
          slot: "reference",
          spec: fakeTargetSpec("reference", "ref") as never,
          role: "reference",
          identity: fakeIdentity(),
          capabilityResolution: [],
        },
      ],
      maxParallelOperations: 1,
      now: () => "2026-09-03T00:00:00.000Z",
    });
    expect(Object.isFrozen(plan)).toBe(true);
  });
});
