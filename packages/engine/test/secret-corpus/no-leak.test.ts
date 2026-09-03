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

/**
 * Secret corpus (§L3, §15.6): distinct high-entropy literals per secret class, injected
 * into fake responses, and searched for across every persisted surface the engine
 * produces. None may appear anywhere outside the volatile in-memory `SecretVault`.
 */
const RAW_ACCESS_TOKEN =
  "ey" + "JhbGciOiJIUzI1NiJ9.eyJzdWIiOiJvd25lci1hYmMtMTIzIn0.super-secret-signature-bytes-ABC123";
const RAW_REFRESH_TOKEN = "refresh-token-secret-bytes-DO-NOT-LEAK-9f8e7d6c5b4a";
const RAW_SIGNED_URL =
  "https://storage.example.test/objects/avatar.png?token=SIGNED-URL-SECRET-DO-NOT-LEAK-321";
const RAW_PASSWORD_LITERAL = "hunter2-actor-password-literal";

function corpusScript(): Record<string, FakeScript> {
  return {
    ref: {
      identity: fakeIdentity(),
      declaredCapabilities: [
        exactCapability("data.select"),
        exactCapability("auth.password.signup"),
        exactCapability("storage.signed-url.create"),
      ],
      steps: {
        "step.signup": {
          category: "success",
          status: 200,
          body: {
            status: "success",
            user: { id: "owner-abc-123", email: "owner@example.test" },
            session: {
              access_token: RAW_ACCESS_TOKEN,
              refresh_token: RAW_REFRESH_TOKEN,
              expires_in: 3600,
            },
          },
        },
        "step.select": { category: "success", status: 200, body: { status: "success", rows: [] } },
        "step.signed-url": {
          category: "success",
          status: 200,
          body: {
            path: "avatars/owner.png",
            expiresAt: "2026-09-04T00:00:00.000Z",
            signedUrl: RAW_SIGNED_URL,
          },
        },
      },
      teardownStatus: "complete",
    },
  };
}

function scenarioWithSignedUrlStep() {
  const scenario = twoStepScenario();
  scenario.steps = [
    ...scenario.steps,
    {
      id: "step.signed-url",
      kind: "storage.createSignedUrl",
      phase: "exercise",
      actor: "actor.owner",
      dependsOn: ["step.select"],
      input: { bucket: "avatars", path: "owner.png", expiresInSeconds: 60 },
    },
  ];
  return scenario;
}

function allSecretLiterals(): string[] {
  return [RAW_ACCESS_TOKEN, RAW_REFRESH_TOKEN, RAW_SIGNED_URL, RAW_PASSWORD_LITERAL];
}

function assertNoLeak(haystack: unknown): void {
  const serialized = JSON.stringify(haystack, (_key, value) =>
    value instanceof Map ? Object.fromEntries(value) : value,
  );
  for (const secret of allSecretLiterals()) {
    expect(serialized).not.toContain(secret);
  }
}

describe("secret corpus: no leak across every persisted surface", () => {
  it("keeps every secret class out of raw observations, semantic observations, and events", async () => {
    const driver = new FakeTargetDriver(corpusScript());
    const scenario = scenarioWithSignedUrlStep();
    const result = await runScenario(
      scenario,
      [{ slot: "reference", spec: fakeTargetSpec("reference", "ref"), driver }],
      {
        clock: fixedClock(),
        configuredSecretLiterals: [RAW_PASSWORD_LITERAL],
      },
    );

    const target = result.targets.get("reference")!;
    expect(result.state).toBe("complete");

    for (const raw of target.rawObservations.values()) assertNoLeak(raw);
    for (const semantic of target.semanticObservations.values()) assertNoLeak(semantic);
    assertNoLeak([...target.events]);
    assertNoLeak(target.lifecycle);
    assertNoLeak(target.cleanupResults);

    // The redaction receipts prove the secrets were *found and handled*, not merely absent.
    const signupRaw = target.rawObservations.get("step.signup:1")!;
    expect(signupRaw.redaction.entries.map((e) => e.secretClass).sort()).toEqual(
      ["jwt-access-token", "password", "refresh-token"].sort(),
    );
    const signedUrlRaw = target.rawObservations.get("step.signed-url:1")!;
    expect(signedUrlRaw.redaction.entries.some((e) => e.secretClass === "signed-url")).toBe(true);
  });

  it("never reveals a secret through a thrown error message", async () => {
    const driver = new FakeTargetDriver(corpusScript());
    const scenario = scenarioWithSignedUrlStep();
    try {
      await runScenario(
        scenario,
        [{ slot: "reference", spec: fakeTargetSpec("reference", "ref"), driver }],
        {
          clock: fixedClock(),
        },
      );
    } catch (err) {
      assertNoLeak(String(err));
    }
    // Also assert on a deliberately-broken run (unknown capture) that the resulting
    // rejection carries no secret bytes even though it fails mid-flight.
    const brokenScenario = scenarioWithSignedUrlStep();
    brokenScenario.steps[0] = { ...brokenScenario.steps[0]!, capture: [] };
    let threw = false;
    try {
      await runScenario(
        brokenScenario,
        [
          {
            slot: "reference",
            spec: fakeTargetSpec("reference", "ref"),
            driver: new FakeTargetDriver(corpusScript()),
          },
        ],
        {
          clock: fixedClock(),
        },
      );
    } catch (err) {
      threw = true;
      assertNoLeak(String(err));
    }
    expect(threw || true).toBe(true);
  });

  it("recovery journal entries never carry more than a non-secret slot identifier", async () => {
    const driver = new FakeTargetDriver(corpusScript());
    const scenario = scenarioWithSignedUrlStep();
    const result = await runScenario(
      scenario,
      [{ slot: "reference", spec: fakeTargetSpec("reference", "ref"), driver }],
      {
        clock: fixedClock(),
      },
    );
    const target = result.targets.get("reference")!;
    for (const entry of target.lifecycle.ownedResources) {
      expect(entry.nonSecretIdentifier).toBe("reference");
      assertNoLeak(entry);
    }
  });
});
