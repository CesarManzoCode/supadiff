import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { runScenario, compareStep, type TargetHandle } from "@supadiff/engine";
import {
  parseScenarioSpec,
  parseTargetSpec,
  parseKnownDivergence,
  computeScenarioDigest,
  sha256OfCanonicalJson,
  type ComparisonPolicy,
  type KnownDivergence,
  type ScenarioSpec,
} from "@supadiff/spec";
import {
  createSupaliteDriver,
  createSupabaseLocalDriver,
  forceCleanupProject,
} from "../../src/index.js";

const REPO_ROOT = path.resolve(fileURLToPath(new URL("../../../../", import.meta.url)));

function loadScenario(name: string): ScenarioSpec {
  return parseScenarioSpec(
    JSON.parse(readFileSync(path.join(REPO_ROOT, "scenarios", "deterministic", name), "utf8")),
  );
}

function loadActiveDivergences(): KnownDivergence[] {
  const dir = path.join(REPO_ROOT, "divergences", "active");
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => parseKnownDivergence(JSON.parse(readFileSync(path.join(dir, f), "utf8"))));
}

function supaliteSpec(id: string) {
  return parseTargetSpec({
    id,
    kind: "supalite-sqlite-postgres",
    package: { name: "@supabase/lite", version: "0.9.0" },
    runtime: { runtime: "node", version: process.version },
    backend: { backend: "sqlite-postgres" },
    config: {
      admin: false,
      forceRollback: false,
      experimentalFeatures: ["storage"],
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

function supabaseLocalSpec(id: string) {
  return parseTargetSpec({
    id,
    kind: "supabase-local",
    package: { name: "supabase", version: "2.116.0" },
    runtime: { runtime: "node", version: process.version },
    backend: { backend: "postgres", version: "17" },
    config: {
      dbMajorVersion: 17,
      excludedServices: [],
      experimentalFeatures: ["storage"],
      keyMode: "opaque-v1",
      routePrefixes: { auth: "/auth/v1", rest: "/rest/v1", storage: "/storage/v1" },
      analytics: false,
      readinessTimeoutMs: 120000,
    },
    credentialRefs: [],
    lifecycle: {
      allocation: "provision-new",
      isolation: "fresh-instance",
      readinessTimeoutMs: 120000,
      teardownTimeoutMs: 60000,
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

const EXACT = { kind: "exact" as const };
const IGNORE = (reason: string): ComparisonPolicy["rules"][number]["rule"] => ({
  kind: "explicit-ignore",
  reason,
  evidence: [{ kind: "note", value: "Architecture Contract §9.3 (target-local value)" }],
});

function rule(
  ruleId: string,
  operationId: string,
  observablePath: string,
  r: ComparisonPolicy["rules"][number]["rule"],
  rationale: string,
): ComparisonPolicy["rules"][number] {
  return {
    id: ruleId,
    version: "1",
    selector: {
      service: "storage",
      operationId,
      operationVersion: "1",
      observablePath,
      referenceTargetSelector: { kind: "supabase-local" },
      candidateTargetSelector: { kind: "supalite-sqlite-postgres" },
    },
    inputType: "any",
    rule: r,
    strictness: "contract",
    rationale,
    evidence: [],
  };
}

const POLICY: ComparisonPolicy = {
  format: "supadiff.comparison-policy",
  formatVersion: "1.0",
  policyId: "policy.peer-storage-smoke",
  policyVersion: "1",
  rules: [
    rule(
      "rule.ps-bucket-status",
      "storage.createBucket",
      "/status",
      EXACT,
      "bucket creation succeeds identically",
    ),
    rule(
      "rule.ps-bucket-name",
      "storage.createBucket",
      "/name",
      EXACT,
      "created bucket name is scenario-authored",
    ),
    rule(
      "rule.ps-upload-status",
      "storage.upload",
      "/status",
      EXACT,
      "upload succeeds identically",
    ),
    rule(
      "rule.ps-upload-path",
      "storage.upload",
      "/path",
      EXACT,
      "uploaded path is scenario-authored",
    ),
    rule(
      "rule.ps-upload-digest",
      "storage.upload",
      "/bytesDigest",
      EXACT,
      "byte identity of the uploaded fixture",
    ),
    rule(
      "rule.ps-upload-length",
      "storage.upload",
      "/contentLength",
      EXACT,
      "byte length of the fixture",
    ),
    rule(
      "rule.ps-upload-owner",
      "storage.upload",
      "/owner",
      EXACT,
      "driver never populates owner at upload time",
    ),
    rule(
      "rule.ps-download-status",
      "storage.download",
      "/status",
      EXACT,
      "download succeeds identically",
    ),
    rule(
      "rule.ps-download-digest",
      "storage.download",
      "/bytesDigest",
      EXACT,
      "byte identity on readback",
    ),
    rule(
      "rule.ps-download-length",
      "storage.download",
      "/contentLength",
      EXACT,
      "byte length on readback",
    ),
    rule("rule.ps-list-status", "storage.list", "/status", EXACT, "list succeeds identically"),
    rule(
      "rule.ps-list-entries",
      "storage.list",
      "/entries",
      IGNORE(
        "list-entry name shape differs by design: Supalite returns the full object path in " +
          "`name` even when listed under a prefix; real Supabase Storage returns a name relative " +
          "to the prefix (docs/TARGETS.md). A separate, documented behavioral difference, not the " +
          "byte-identity/redemption behavior this peer test measures.",
      ),
      "list name shape is a separate documented difference",
    ),
    rule(
      "rule.ps-observe-owner",
      "observe.storageObject",
      "/owner",
      IGNORE("owner is the uploading actor's target-local UUID from that target's own signup"),
      "ownership id is not portable across independently provisioned targets",
    ),
    rule(
      "rule.ps-observe-digest",
      "observe.storageObject",
      "/bytesDigest",
      EXACT,
      "byte identity via metadata readback",
    ),
    rule(
      "rule.ps-observe-length",
      "observe.storageObject",
      "/contentLength",
      EXACT,
      "byte length via metadata readback",
    ),
    rule("rule.ps-copy-status", "storage.copy", "/status", EXACT, "copy succeeds identically"),
    rule(
      "rule.ps-copy-digest",
      "storage.copy",
      "/bytesDigest",
      EXACT,
      "the copy is byte-identical to the source",
    ),
    rule("rule.ps-move-status", "storage.move", "/status", EXACT, "move succeeds identically"),
    rule(
      "rule.ps-remove-status",
      "storage.remove",
      "/status",
      EXACT,
      "remove succeeds identically",
    ),
    rule("rule.ps-remove-removed", "storage.remove", "/removed", EXACT, "removed names, sorted"),
    rule(
      "rule.ps-sign-path",
      "storage.createSignedUrl",
      "/path",
      EXACT,
      "signed URL issued for the scenario path",
    ),
    rule(
      "rule.ps-sign-expires",
      "storage.createSignedUrl",
      "/expiresAt",
      IGNORE("expiresAt is now+expiresInSeconds computed at each target's own step time"),
      "wall-clock derived, excluded like §9.3 excludes wall time",
    ),
    rule(
      "rule.ps-sign-url",
      "storage.createSignedUrl",
      "/signedUrl",
      IGNORE("the signed URL string is target-local; redemption behavior is judged at step.redeem"),
      "§6.5: judge redemption, not the URL",
    ),
    rule("rule.ps-redeem-status", "storage.redeemUrl", "/status", EXACT, "redemption HTTP status"),
    rule(
      "rule.peer-storage-redeem-bytesdigest",
      "storage.redeemUrl",
      "/bytesDigest",
      EXACT,
      "redeemed bytes must be byte-identical across targets (the signedUrl/signedURL bug — div.supalite-signed-url-key-name)",
    ),
    rule(
      "rule.peer-storage-redeem-contentlength",
      "storage.redeemUrl",
      "/contentLength",
      EXACT,
      "redeemed byte length (div.supalite-signed-url-key-name-length)",
    ),
  ],
};

const COMPARED_STEPS = [
  "step.create-bucket",
  "step.upload",
  "step.download",
  "step.list",
  "step.observe-owner",
  "step.copy",
  "step.move",
  "step.signed-url",
  "step.redeem",
  "step.remove",
];

const projects: string[] = [];
afterEach(async () => {
  for (const id of projects.splice(0)) await forceCleanupProject(id).catch(() => undefined);
});

describe("L11 peer Storage: Supabase-local vs Supalite (real ↔ real)", () => {
  it("byte-identity holds everywhere except signed-URL redemption, which is the registered signedUrl/signedURL divergence", async () => {
    const scenario = loadScenario("supalite-storage-smoke.json");
    const referenceKind = "supabase-local" as const;
    const candidateKind = "supalite-sqlite-postgres" as const;

    const handles: TargetHandle[] = [
      {
        slot: "reference",
        spec: supabaseLocalSpec("reference"),
        driver: createSupabaseLocalDriver({ scenarioResources: scenario.resources }),
      },
      {
        slot: "candidate",
        spec: supaliteSpec("candidate"),
        driver: createSupaliteDriver(candidateKind, { scenarioResources: scenario.resources }),
      },
    ];

    const result = await runScenario(scenario, handles);
    expect(
      result.state,
      JSON.stringify(
        [...result.targets].map(([s, t]) => [s, t.attempts.map((a) => `${a.stepId}:${a.status}`)]),
      ),
    ).toBe("complete");

    const reference = result.targets.get("reference")!;
    const candidate = result.targets.get("candidate")!;
    const scenarioDigest = computeScenarioDigest(scenario);
    const registry = loadActiveDivergences();

    const compareAll = (withRegistry: boolean) =>
      COMPARED_STEPS.flatMap((stepId) => {
        const refObs = reference.semanticObservations.get(`${stepId}:1`);
        const candObs = candidate.semanticObservations.get(`${stepId}:1`);
        expect(refObs, `reference obs ${stepId}`).toBeDefined();
        expect(candObs, `candidate obs ${stepId}`).toBeDefined();
        return compareStep({
          scenarioId: scenario.id,
          scenarioDigest,
          scenarioRevision: scenario.revision,
          stepId,
          referenceSlot: "reference",
          candidateSlot: "candidate",
          referenceTarget: {
            kind: referenceKind,
            version: reference.identity!.implementationVersion,
          },
          candidateTarget: { kind: candidateKind, version: "0.9.0" },
          referenceObservation: refObs!,
          candidateObservation: candObs!,
          referenceRawDigest: sha256OfCanonicalJson(
            reference.rawObservations.get(`${stepId}:1`) as never,
          ),
          candidateRawDigest: sha256OfCanonicalJson(
            candidate.rawObservations.get(`${stepId}:1`) as never,
          ),
          policy: POLICY,
          registry: withRegistry ? registry : [],
          now: new Date(),
        });
      });

    // Without the registry: the signed-URL redemption bytes/length are a genuine new-divergence.
    const raw = compareAll(false);
    const rawByPath = new Map(raw.map((r) => [`${r.stepId}${r.observablePath}`, r]));
    expect(rawByPath.get("step.redeemUrl")).toBeUndefined();
    expect(rawByPath.get("step.redeem/bytesDigest")?.outcome).toBe("new-divergence");
    expect(rawByPath.get("step.redeem/contentLength")?.outcome).toBe("new-divergence");

    // Everything else agrees (byte-identity of the uploaded/downloaded/copied object).
    const otherRaw = raw.filter((r) => r.stepId !== "step.redeem");
    expect(
      otherRaw.filter((r) => r.outcome === "new-divergence" || r.outcome === "inconclusive"),
      JSON.stringify(
        otherRaw
          .filter((r) => r.outcome === "new-divergence" || r.outcome === "inconclusive")
          .map((r) => ({
            step: r.stepId,
            path: r.observablePath,
            outcome: r.outcome,
            why: r.explanation.summary,
          })),
        null,
        2,
      ),
    ).toEqual([]);

    // With the registry: the redemption divergence is a KNOWN divergence, nothing new.
    const withReg = compareAll(true);
    const withByPath = new Map(withReg.map((r) => [`${r.stepId}${r.observablePath}`, r]));
    expect(withByPath.get("step.redeem/bytesDigest")?.outcome).toBe("known-divergence");
    expect(withByPath.get("step.redeem/bytesDigest")?.divergenceId).toBe(
      "div.supalite-signed-url-key-name",
    );
    expect(withByPath.get("step.redeem/contentLength")?.outcome).toBe("known-divergence");
    expect(withReg.some((r) => r.outcome === "new-divergence")).toBe(false);
    expect(withReg.some((r) => r.outcome === "inconclusive")).toBe(false);

    // Direct byte-identity evidence, independent of the comparator.
    const digestOf = (t: typeof reference, step: string) =>
      (t.rawObservations.get(`${step}:1`)!.transport.responseBody as { bytesDigest: string })
        .bytesDigest;
    expect(digestOf(reference, "step.upload")).toBe(digestOf(candidate, "step.upload"));
    expect(digestOf(reference, "step.download")).toBe(digestOf(reference, "step.upload"));

    // The real bug, locked in against raw evidence: supabase-local redeems the true bytes,
    // Supalite redeems something else with the same HTTP 200.
    const refRedeem = reference.rawObservations.get("step.redeem:1")!.transport.responseBody as {
      status: number;
      bytesDigest: string;
    };
    const candRedeem = candidate.rawObservations.get("step.redeem:1")!.transport.responseBody as {
      status: number;
      bytesDigest: string;
    };
    expect(refRedeem.status).toBe(200);
    expect(candRedeem.status).toBe(200);
    expect(refRedeem.bytesDigest).toBe(digestOf(reference, "step.upload"));
    expect(candRedeem.bytesDigest).not.toBe(refRedeem.bytesDigest);
  }, 300_000);
});
