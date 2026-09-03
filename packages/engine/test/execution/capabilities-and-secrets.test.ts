import { describe, expect, it } from "vitest";
import {
  runScenario,
  FakeTargetDriver,
  InMemorySecretVault,
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

function basicScript(overrides: Partial<FakeScript> = {}): FakeScript {
  return {
    identity: fakeIdentity(),
    declaredCapabilities: [exactCapability("data.select"), exactCapability("auth.password.signup")],
    steps: {
      "step.signup": { category: "success", body: { id: "owner-abc-123" } },
      "step.select": { category: "success", body: { rows: [] } },
    },
    teardownStatus: "complete",
    ...overrides,
  };
}

describe("capability resolution", () => {
  it("marks the run unsupported before any mutation when a required capability is missing", async () => {
    const driver = new FakeTargetDriver({
      ref: basicScript({ declaredCapabilities: [] }),
    });
    const scenario = twoStepScenario();
    const result = await runScenario(
      scenario,
      [{ slot: "reference", spec: fakeTargetSpec("reference", "ref"), driver }],
      {
        clock: fixedClock(),
      },
    );
    expect(result.state).toBe("unsupported");
    const target = result.targets.get("reference")!;
    // Nothing was ever attempted: preflight caught it first.
    expect(target.attempts).toHaveLength(0);
  });

  it("downgrades a declared capability at runtime probe time and becomes unsupported (never silently upgrades)", async () => {
    const driver = new FakeTargetDriver({
      ref: basicScript({
        declaredCapabilities: [
          {
            id: "data.select",
            version: "1.0.0",
            level: "exact",
            constraints: {},
            evidence: [],
            observed: false,
          },
          exactCapability("auth.password.signup"),
        ],
        probedCapabilities: [
          {
            id: "data.select",
            version: "1.0.0",
            level: "unsupported",
            constraints: {},
            evidence: [],
            observed: true,
          },
          exactCapability("auth.password.signup"),
        ],
      }),
    });
    const scenario = twoStepScenario();
    const result = await runScenario(
      scenario,
      [{ slot: "reference", spec: fakeTargetSpec("reference", "ref"), driver }],
      {
        clock: fixedClock(),
      },
    );
    expect(result.state).toBe("unsupported");
  });

  it("reports identity-mismatch when the probed capability version falls outside the declared range", async () => {
    const driver = new FakeTargetDriver({
      ref: basicScript({
        probedCapabilities: [
          {
            id: "data.select",
            version: "0.1.0",
            level: "exact",
            constraints: {},
            evidence: [],
            observed: true,
          },
          exactCapability("auth.password.signup"),
        ],
      }),
    });
    const scenario = twoStepScenario();
    const result = await runScenario(
      scenario,
      [{ slot: "reference", spec: fakeTargetSpec("reference", "ref"), driver }],
      {
        clock: fixedClock(),
      },
    );
    expect(result.state).toBe("unsupported");
    const resolution = result.targets
      .get("reference")!
      .capabilityResolution.find((r) => r.requirement.capability === "data.select");
    expect(resolution?.status).toBe("identity-mismatch");
  });
});

describe("secret vault", () => {
  it("keeps put secrets opaque and destroys them after the run finishes", () => {
    const vault = new InMemorySecretVault();
    const handle = vault.put("password", "hunter2");
    expect(vault.reveal(handle)).toBe("hunter2");
    vault.destroy();
    expect(() => vault.reveal(handle)).toThrow();
  });

  it("captures a secret-sensitivity value into a vault handle, never as a persisted value", async () => {
    const driver = new FakeTargetDriver({
      ref: basicScript({
        steps: {
          "step.signup": {
            category: "success",
            body: { id: "owner-abc-123", refreshToken: "rt-xyz" },
          },
        },
      }),
    });
    const scenario = twoStepScenario();
    scenario.steps[0] = {
      ...scenario.steps[0]!,
      capture: [
        ...(scenario.steps[0]!.capture ?? []),
        {
          name: "owner-refresh",
          from: { kind: "semantic", field: "refreshToken" },
          valueType: "secret-handle",
          sensitivity: "secret",
          required: true,
        },
      ],
    };
    const result = await runScenario(
      scenario,
      [{ slot: "reference", spec: fakeTargetSpec("reference", "ref"), driver }],
      {
        clock: fixedClock(),
      },
    );
    const record = result.capturedValueStore.get("reference", "owner-refresh");
    expect(record?.persistedValue).toBeUndefined();
    expect(record?.secretHandle).toMatch(/^sec-/);
  });
});

describe("retries", () => {
  it("rejects an invalid retry spec on a non-idempotent operation as an invalid plan", async () => {
    const driver = new FakeTargetDriver({ ref: basicScript() });
    const scenario = twoStepScenario();
    // auth.signUp is not catalog-idempotent; retry without a stable idempotency key is illegal.
    scenario.steps[0] = {
      ...scenario.steps[0]!,
      retry: {
        maxAttempts: 2,
        retryableCategories: ["disconnect"],
        backoffMs: 0,
        idempotencyProof: "catalog-idempotent",
      },
    };
    const result = await runScenario(
      scenario,
      [{ slot: "reference", spec: fakeTargetSpec("reference", "ref"), driver }],
      {
        clock: fixedClock(),
      },
    );
    expect(result.state).toBe("invalid");
  });

  it("allows and records a legal retry on a catalog-idempotent operation, succeeding on a later attempt", async () => {
    const driver = new FakeTargetDriver({
      ref: basicScript({
        steps: {
          "step.signup": { category: "success", body: { id: "owner-abc-123" } },
          // data.select IS catalog-idempotent; flaky until attempt 2, then succeeds.
          "step.select": { category: "success", body: { rows: [] }, flakyUntilAttempt: 2 },
        },
      }),
    });
    const scenario = twoStepScenario();
    scenario.steps[1] = {
      ...scenario.steps[1]!,
      retry: {
        maxAttempts: 2,
        retryableCategories: ["disconnect"],
        backoffMs: 0,
        idempotencyProof: "catalog-idempotent",
      },
    };
    const result = await runScenario(
      scenario,
      [{ slot: "reference", spec: fakeTargetSpec("reference", "ref"), driver }],
      {
        clock: fixedClock(),
      },
    );
    expect(result.state).toBe("complete");
    const attempts = result.targets
      .get("reference")!
      .attempts.filter((a) => a.stepId === "step.select");
    expect(attempts.map((a) => a.status)).toEqual(["harness-error", "executed"]);
  });
});

describe("recovery journal", () => {
  it("records intent before provisioning and tombstones every entry on clean teardown (no leaks)", async () => {
    const driver = new FakeTargetDriver({ ref: basicScript() });
    const scenario = twoStepScenario();
    const result = await runScenario(
      scenario,
      [{ slot: "reference", spec: fakeTargetSpec("reference", "ref"), driver }],
      {
        clock: fixedClock(),
      },
    );
    const target = result.targets.get("reference")!;
    expect(target.lifecycle.ownedResources.length).toBeGreaterThan(0);
    expect(target.recoveryLeaks).toHaveLength(0);
  });

  it("leaves a leaked recovery entry visible when teardown itself reports leaked", async () => {
    const driver = new FakeTargetDriver({ ref: basicScript({ teardownStatus: "leaked" }) });
    const scenario = twoStepScenario();
    const result = await runScenario(
      scenario,
      [{ slot: "reference", spec: fakeTargetSpec("reference", "ref"), driver }],
      {
        clock: fixedClock(),
      },
    );
    const target = result.targets.get("reference")!;
    expect(target.teardownStatus).toBe("leaked");
    expect(result.state).toBe("inconclusive-cleanup");
  });
});
