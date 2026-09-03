import { describe, expect, it } from "vitest";
import { parseTargetSpec, SpecValidationError } from "../src/index.js";

function validFakeTarget() {
  return {
    id: "target.fake-a",
    kind: "fake",
    runtime: { runtime: "node", version: "22.10.0" },
    config: { scriptId: "fake-basic" },
    credentialRefs: [],
    lifecycle: {
      allocation: "provision-new",
      isolation: "fresh-instance",
      readinessTimeoutMs: 5000,
      teardownTimeoutMs: 5000,
      cleanup: "always",
      keepOnFailure: "deny",
    },
    safety: {
      allowHosted: false,
      allowHostedCreate: false,
      allowHostedDestructive: false,
      maxHostedCostUsd: 0,
    },
  };
}

describe("parseTargetSpec", () => {
  it("accepts a valid fake target", () => {
    const t = parseTargetSpec(validFakeTarget() as never);
    expect(t.kind).toBe("fake");
  });

  it("rejects an unknown config key (closed target config schema)", () => {
    const bad = validFakeTarget();
    (bad.config as Record<string, unknown>)["extraneous"] = true;
    expect(() => parseTargetSpec(bad as never)).toThrow(SpecValidationError);
  });

  it("rejects a malformed TargetSpec missing required fields", () => {
    const bad = validFakeTarget() as Record<string, unknown>;
    delete bad["lifecycle"];
    expect(() => parseTargetSpec(bad as never)).toThrow();
  });

  it("rejects a target kind with no driver in this build", () => {
    const bad = validFakeTarget();
    (bad as unknown as { kind: string }).kind = "supalite-sqlite";
    expect(() => parseTargetSpec(bad as never)).toThrow(SpecValidationError);
  });
});
