import { describe, expect, it } from "vitest";
import { parseScenarioSpec, SpecValidationError } from "../src/index.js";
import { minimalScenario } from "./fixtures/minimal-scenario.js";

function expectIssueCode(fn: () => unknown, code: string): void {
  try {
    fn();
    throw new Error("expected SpecValidationError to be thrown");
  } catch (e) {
    if (!(e instanceof SpecValidationError)) throw e;
    expect(e.issues.some((i) => i.code === code)).toBe(true);
  }
}

describe("parseScenarioSpec — valid corpus", () => {
  it("accepts a minimal valid scenario", () => {
    const parsed = parseScenarioSpec(
      minimalScenario() as unknown as Parameters<typeof parseScenarioSpec>[0],
    );
    expect(parsed.id).toBe("scn.minimal");
    expect(parsed.steps).toHaveLength(2);
  });
});

describe("parseScenarioSpec — invalid corpus", () => {
  it("rejects duplicate step ids", () => {
    const s = minimalScenario();
    s.steps = [s.steps[0]!, { ...s.steps[0]! }];
    expectIssueCode(() => parseScenarioSpec(s as never), "duplicate-step-id");
  });

  it("rejects duplicate captures", () => {
    const s = minimalScenario();
    s.steps = [
      s.steps[0]!,
      { ...s.steps[1]!, id: "data.select.todo-02", capture: s.steps[0]!.capture },
    ];
    expectIssueCode(() => parseScenarioSpec(s as never), "duplicate-capture");
  });

  it("rejects a forward capture ref", () => {
    const s = minimalScenario();
    // Step 0 references a capture only step 1 would produce.
    s.steps = [
      {
        ...s.steps[0]!,
        input: { ...s.steps[0]!.input, x: { $ref: "capture:owner-id" } },
        capture: [],
      },
      s.steps[1]!,
    ];
    expectIssueCode(() => parseScenarioSpec(s as never), "unknown-capture-ref");
  });

  it("rejects a dependency cycle", () => {
    const s = minimalScenario();
    s.steps = [
      { ...s.steps[0]!, dependsOn: ["data.select.todo-01"] },
      { ...s.steps[1]!, dependsOn: ["auth.signup.owner"] },
    ];
    expectIssueCode(() => parseScenarioSpec(s as never), "dependency-cycle");
  });

  it("rejects an unknown actor reference", () => {
    const s = minimalScenario();
    s.steps[1]!.actor = "actor.ghost";
    expectIssueCode(() => parseScenarioSpec(s as never), "unknown-actor");
  });

  it("rejects an unknown operation", () => {
    const s = minimalScenario();
    (s.steps[1] as unknown as { kind: string }).kind = "data.teleport";
    expect(() => parseScenarioSpec(s as never)).toThrow();
  });

  it("rejects an invalid StableId", () => {
    const s = minimalScenario();
    s.id = "Not Valid ID!!";
    expect(() => parseScenarioSpec(s as never)).toThrow();
  });

  it("rejects an unknown top-level property (closed schema)", () => {
    const s = minimalScenario() as unknown as Record<string, unknown>;
    s["unexpectedField"] = true;
    expect(() => parseScenarioSpec(s as never)).toThrow();
  });

  it("rejects a credential literal outside secretRef indirection", () => {
    const s = minimalScenario();
    (s.steps[0]!.input as Record<string, unknown>)["password"] = "literal-password-value";
    expectIssueCode(() => parseScenarioSpec(s as never), "credential-literal");
  });

  it("rejects an unsafe resource path", () => {
    const s = minimalScenario();
    s.resources = [
      {
        id: "res.bad",
        mediaType: "application/sql",
        sha256: "sha256:" + "0".repeat(64),
        length: 0,
        source: { kind: "content", path: "../../etc/passwd" },
        sensitivity: "public-fixture",
      },
    ];
    expectIssueCode(() => parseScenarioSpec(s as never), "unsafe-resource-path");
  });

  it("rejects an external URL resource path", () => {
    const s = minimalScenario();
    s.resources = [
      {
        id: "res.bad",
        mediaType: "application/sql",
        sha256: "sha256:" + "0".repeat(64),
        length: 0,
        source: { kind: "content", path: "https://example.com/x.sql" },
        sensitivity: "public-fixture",
      },
    ];
    expectIssueCode(() => parseScenarioSpec(s as never), "unsafe-resource-path");
  });

  it("rejects a resource digest mismatch", () => {
    const s = minimalScenario();
    s.resources = [
      {
        id: "res.bad",
        mediaType: "text/plain",
        sha256: "sha256:" + "0".repeat(64),
        length: 5,
        source: { kind: "inline", value: "hello" },
        sensitivity: "public-fixture",
      },
    ];
    expectIssueCode(() => parseScenarioSpec(s as never), "resource-digest-mismatch");
  });

  it("rejects an unknown major format version", () => {
    const s = minimalScenario();
    (s as unknown as { formatVersion: string }).formatVersion = "2.0";
    expectIssueCode(() => parseScenarioSpec(s as never), "unknown-major-version");
  });
});
