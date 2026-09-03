import { describe, expect, it } from "vitest";
import { runScenario, FakeTargetDriver, type FakeScript } from "../../src/index.js";
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

function scriptWithSignupBody(body: unknown): FakeScript {
  return {
    identity: fakeIdentity(),
    declaredCapabilities: [exactCapability("data.select"), exactCapability("auth.password.signup")],
    steps: {
      "step.signup": { category: "success", status: 200, body },
      "step.select": {
        category: "success",
        status: 200,
        body: { status: "success", rows: [{ id: 1 }] },
      },
    },
    teardownStatus: "complete",
  };
}

describe("semantic projectors", () => {
  it("is a pure function of the raw observation: same raw input, same semantic output", async () => {
    const body = {
      status: "success",
      user: { id: "owner-abc-123", email: "owner@example.test" },
      session: { access_token: "ey.raw.jwt", refresh_token: "rt-raw-secret", expires_in: 3600 },
    };
    const driver = new FakeTargetDriver({ ref: scriptWithSignupBody(body) });
    const scenario = twoStepScenario();
    const result = await runScenario(
      scenario,
      [{ slot: "reference", spec: fakeTargetSpec("reference", "ref"), driver }],
      { clock: fixedClock() },
    );
    const target = result.targets.get("reference")!;
    const semantic = target.semanticObservations.get("step.signup:1")!;
    expect(semantic.contractFields["/status"]).toBe("success");
    expect(semantic.contractFields["/user/id"]).toBe("owner-abc-123");
    expect(semantic.stateFacts).toEqual([{ label: "session-presence", value: true }]);
  });

  it("records a token relationship without ever comparing token bytes (§6.5)", async () => {
    const body = {
      status: "success",
      user: { id: "owner-abc-123", email: "owner@example.test" },
      session: { access_token: "ey.raw.jwt.A", refresh_token: "rt-A", expires_in: 3600 },
    };
    const driver = new FakeTargetDriver({ ref: scriptWithSignupBody(body) });
    const scenario = twoStepScenario();
    const result = await runScenario(
      scenario,
      [{ slot: "reference", spec: fakeTargetSpec("reference", "ref"), driver }],
      { clock: fixedClock() },
    );
    const semantic = result.targets.get("reference")!.semanticObservations.get("step.signup:1")!;
    expect(semantic.relationships).toEqual([
      {
        predicate: "session.belongs-to-actor",
        subject: "step.signup-session",
        object: "actor:actor.owner",
      },
    ]);
    // No field anywhere in the semantic record carries the literal token string.
    expect(JSON.stringify(semantic)).not.toContain("ey.raw.jwt.A");
    expect(JSON.stringify(semantic)).not.toContain("rt-A");
  });

  it("preserves null vs missing distinctly across the raw-to-semantic pipeline", async () => {
    const withNull = scriptWithSignupBody({
      status: "success",
      user: { id: "u1", email: null },
      session: {},
    });
    const driver = new FakeTargetDriver({ ref: withNull });
    const scenario = twoStepScenario();
    const result = await runScenario(
      scenario,
      [{ slot: "reference", spec: fakeTargetSpec("reference", "ref"), driver }],
      { clock: fixedClock() },
    );
    const semantic = result.targets.get("reference")!.semanticObservations.get("step.signup:1")!;
    expect(semantic.contractFields["/user/email"]).toBeNull();
  });

  it("marks an unaccounted raw field as unassessed (fail closed) rather than silently dropping it", async () => {
    const body = {
      status: "success",
      user: { id: "owner-abc-123", email: "owner@example.test" },
      session: { access_token: "x", refresh_token: "y" },
      surpriseField: "not covered by the projector contract",
    };
    const driver = new FakeTargetDriver({ ref: scriptWithSignupBody(body) });
    const scenario = twoStepScenario();
    const result = await runScenario(
      scenario,
      [{ slot: "reference", spec: fakeTargetSpec("reference", "ref"), driver }],
      { clock: fixedClock() },
    );
    const semantic = result.targets.get("reference")!.semanticObservations.get("step.signup:1")!;
    expect(semantic.coverage.unassessedFields).toContain("/surpriseField");
  });

  it("does not mark a declared contractual field as unassessed", async () => {
    const body = {
      status: "success",
      user: { id: "owner-abc-123", email: "e@x.test" },
      session: {},
    };
    const driver = new FakeTargetDriver({ ref: scriptWithSignupBody(body) });
    const scenario = twoStepScenario();
    const result = await runScenario(
      scenario,
      [{ slot: "reference", spec: fakeTargetSpec("reference", "ref"), driver }],
      { clock: fixedClock() },
    );
    const semantic = result.targets.get("reference")!.semanticObservations.get("step.signup:1")!;
    expect(semantic.coverage.unassessedFields).toHaveLength(0);
  });
});
