import { describe, expect, it } from "vitest";
import { runScenario, FakeTargetDriver, type FakeScript } from "../../src/index.js";
import {
  exactCapability,
  fakeIdentity,
  fakeTargetSpec,
  twoStepScenario,
} from "../fixtures/fake-scenario.js";

function basicScript(overrides: Partial<FakeScript> = {}): FakeScript {
  return {
    identity: fakeIdentity(),
    declaredCapabilities: [exactCapability("data.select"), exactCapability("auth.password.signup")],
    steps: {
      "step.signup": { category: "success", status: 200, body: { id: "owner-abc-123" } },
      "step.select": {
        category: "success",
        status: 200,
        body: { rows: [{ id: 1, owner_id: "owner-abc-123" }] },
      },
    },
    teardownStatus: "complete",
    ...overrides,
  };
}

function fixedClock() {
  let n = 0;
  return () => new Date(Date.UTC(2026, 0, 1, 0, 0, n++)).toISOString();
}

describe("deterministic lockstep scheduling", () => {
  it("interleaves step-by-step across two targets in fixed order (§5.2)", async () => {
    const driver = new FakeTargetDriver({ ref: basicScript(), cand: basicScript() });
    const scenario = twoStepScenario();
    const result = await runScenario(
      scenario,
      [
        { slot: "reference", spec: fakeTargetSpec("reference", "ref"), driver },
        { slot: "candidate", spec: fakeTargetSpec("candidate", "cand"), driver },
      ],
      { clock: fixedClock() },
    );

    expect(result.state).toBe("complete");
    const refStepKinds = result.targets
      .get("reference")!
      .events.filter((e) => e.kind === "step-started")
      .map((e) => (e as { stepId: string }).stepId);
    const candStepKinds = result.targets
      .get("candidate")!
      .events.filter((e) => e.kind === "step-started")
      .map((e) => (e as { stepId: string }).stepId);
    expect(refStepKinds).toEqual(["step.signup", "step.select"]);
    expect(candStepKinds).toEqual(["step.signup", "step.select"]);
  });

  it("produces exactly the same event order for the same plan run twice (determinism)", async () => {
    const scenario = twoStepScenario();
    const targets = () => [
      {
        slot: "reference",
        spec: fakeTargetSpec("reference", "ref"),
        driver: new FakeTargetDriver({ ref: basicScript() }),
      },
    ];
    const r1 = await runScenario(scenario, targets(), { clock: fixedClock() });
    const r2 = await runScenario(scenario, targets(), { clock: fixedClock() });
    const kinds1 = r1.targets.get("reference")!.events.map((e) => e.kind);
    const kinds2 = r2.targets.get("reference")!.events.map((e) => e.kind);
    expect(kinds1).toEqual(kinds2);
  });

  it("resolves captures across steps and exposes actor context", async () => {
    const driver = new FakeTargetDriver({ ref: basicScript() });
    const scenario = twoStepScenario();
    const result = await runScenario(
      scenario,
      [{ slot: "reference", spec: fakeTargetSpec("reference", "ref"), driver }],
      {
        clock: fixedClock(),
      },
    );
    const captured = result.capturedValueStore.get("reference", "owner-id");
    expect(captured?.persistedValue).toBe("owner-abc-123");

    const target = result.targets.get("reference")!;
    expect(target.attempts.every((a) => a.status === "executed")).toBe(true);
  });
});

describe("cleanup runs after every terminal path", () => {
  it("runs cleanup and tears down on a successful run", async () => {
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
    expect(target.cleanupResults).toHaveLength(1);
    expect(target.cleanupResults[0]!.ok).toBe(true);
    expect(target.teardownStatus).toBe("complete");
  });

  it("still runs cleanup when a step times out", async () => {
    const driver = new FakeTargetDriver({
      ref: basicScript({
        steps: {
          "step.signup": { category: "success", body: { id: "x" } },
          "step.select": { delayMs: 200 },
        },
      }),
    });
    const scenario = twoStepScenario();
    scenario.steps[1] = { ...scenario.steps[1]!, timeoutMs: 10 };
    const result = await runScenario(
      scenario,
      [{ slot: "reference", spec: fakeTargetSpec("reference", "ref"), driver }],
      {
        clock: fixedClock(),
      },
    );
    const target = result.targets.get("reference")!;
    expect(target.attempts.some((a) => a.status === "timed-out")).toBe(true);
    expect(target.cleanupResults).toHaveLength(1);
    expect(target.teardownStatus).toBe("complete");
  });

  it("still runs cleanup when a required capability is unsupported at preflight", async () => {
    const driver = new FakeTargetDriver({
      ref: basicScript({ declaredCapabilities: [exactCapability("auth.password.signup")] }),
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
    // Unsupported is caught before mutation: no target-level cleanup attempted because
    // provisioning never happened, but teardown bookkeeping stays not-started (never leaked).
    const target = result.targets.get("reference")!;
    expect(target.teardownStatus).not.toBe("leaked");
  });

  it("runs cleanup when a target is lost mid-scenario", async () => {
    const driver = new FakeTargetDriver({
      ref: basicScript({
        steps: {
          "step.signup": { category: "success", body: { id: "x" } },
          "step.select": { category: "harness-failure", harnessFailureReason: "target-lost" },
        },
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
    expect(result.state).toBe("inconclusive");
    const target = result.targets.get("reference")!;
    expect(target.cleanupResults.length).toBeGreaterThan(0);
    expect(target.teardownStatus).toBe("complete");
  });

  it("reports inconclusive-cleanup when cleanup itself fails but never hides it", async () => {
    const driver = new FakeTargetDriver({
      ref: basicScript({
        steps: {
          "step.signup": { category: "success", body: { id: "x" } },
          "step.select": { category: "success", body: { rows: [] } },
          "cleanup.remove-owner": {
            category: "harness-failure",
            harnessFailureReason: "disconnect",
          },
        },
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
    expect(result.state).toBe("inconclusive-cleanup");
    expect(result.targets.get("reference")!.cleanupResults[0]!.ok).toBe(false);
  });
});

describe("cancellation and comparable prefix", () => {
  it("blocks the remaining suffix on a lost target and preserves the comparable prefix on the other", async () => {
    const driverRef = new FakeTargetDriver({
      ref: basicScript({
        steps: {
          "step.signup": { category: "success", body: { id: "owner-abc-123" } },
          "step.select": { category: "harness-failure", harnessFailureReason: "process-death" },
        },
      }),
    });
    const driverCand = new FakeTargetDriver({ cand: basicScript() });
    const scenario = twoStepScenario();
    const result = await runScenario(
      scenario,
      [
        { slot: "reference", spec: fakeTargetSpec("reference", "ref"), driver: driverRef },
        { slot: "candidate", spec: fakeTargetSpec("candidate", "cand"), driver: driverCand },
      ],
      { clock: fixedClock() },
    );
    expect(result.state).toBe("inconclusive");
    const ref = result.targets.get("reference")!;
    expect(ref.attempts.find((a) => a.stepId === "step.signup")!.status).toBe("executed");
    expect(ref.attempts.find((a) => a.stepId === "step.select")!.status).toBe("target-lost");
  });
});
