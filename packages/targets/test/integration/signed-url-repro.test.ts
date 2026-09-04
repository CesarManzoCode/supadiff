import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { compareStep, runScenario, type TargetHandle } from "@supadiff/engine";
import {
  computeScenarioDigest,
  parseKnownDivergence,
  parseScenarioSpec,
  parseTargetSpec,
  sha256OfCanonicalJson,
  type ComparisonPolicy,
  type KnownDivergence,
  type ScenarioSpec,
} from "@supadiff/spec";
import {
  createSupabaseLocalDriver,
  createSupaliteDriver,
  forceCleanupProject,
} from "../../src/index.js";

/**
 * Focused reproduction of upstream `dswbx/lite-projects#64` — Supalite's `createSignedUrl`
 * wire-contract mismatch — isolated from Storage RLS by using a `service_role` actor, run
 * against BOTH pinned Supalite profiles with `supabase-local` as the reference.
 *
 * Methodological invariant this test now enforces: reference and candidate are driven
 * through the EXACT SAME `@supabase/supabase-js` build in a given run. The client version
 * is `ScenarioSpec.client.version` (the single source of truth) — passed to BOTH drivers,
 * and independently enforced by the planner (`ClientIdentityMismatchError`). Run A pins
 * client 2.97.0 (with lite 0.9.0); run B pins client 2.114.0 (with lite 0.10.0). No run
 * mixes client versions across targets.
 *
 * It does not register any new divergence for 0.10.0: it observes and prints the real
 * classification so a human can decide what (if anything) to register.
 *
 * Needs Docker (for `supabase-local`) and network (npm) — integration-only, never in `pnpm check`.
 */

const REPO_ROOT = path.resolve(fileURLToPath(new URL("../../../../", import.meta.url)));

/**
 * Loads the base repro scenario, optionally overriding `client.version` so a single
 * authored scenario file can express "this run pins client X". Each returned `ScenarioSpec`
 * is exactly one run's contract: one implementation pairing, one client version.
 */
function loadScenario(name: string, clientVersion?: string): ScenarioSpec {
  const raw = JSON.parse(
    readFileSync(path.join(REPO_ROOT, "scenarios", "deterministic", name), "utf8"),
  ) as { client: { library: string; version: string } };
  if (clientVersion) raw.client = { ...raw.client, version: clientVersion };
  return parseScenarioSpec(raw);
}

function loadActiveDivergences(): KnownDivergence[] {
  const dir = path.join(REPO_ROOT, "divergences", "active");
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => parseKnownDivergence(JSON.parse(readFileSync(path.join(dir, f), "utf8"))));
}

function supaliteSpec(id: string, liteVersion: string) {
  return parseTargetSpec({
    id,
    kind: "supalite-sqlite-postgres",
    package: { name: "@supabase/lite", version: liteVersion },
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
  evidence: [{ kind: "note", value: "target-local value" }],
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
  policyId: "policy.supalite-signed-url-repro",
  policyVersion: "1",
  rules: [
    rule("r.bucket-status", "storage.createBucket", "/status", EXACT, "bucket creation status"),
    rule("r.upload-status", "storage.upload", "/status", EXACT, "upload status"),
    rule("r.upload-digest", "storage.upload", "/bytesDigest", EXACT, "uploaded byte identity"),
    rule("r.upload-length", "storage.upload", "/contentLength", EXACT, "uploaded byte length"),
    rule("r.sign-status", "storage.createSignedUrl", "/status", EXACT, "sign call status"),
    rule("r.sign-path", "storage.createSignedUrl", "/path", EXACT, "signed path"),
    rule(
      "r.sign-expires",
      "storage.createSignedUrl",
      "/expiresAt",
      IGNORE("wall-clock derived at each target's own step time"),
      "wall-clock",
    ),
    rule(
      "r.sign-url",
      "storage.createSignedUrl",
      "/signedUrl",
      IGNORE("target-local URL string; redemption behavior is judged at step.redeem"),
      "judge redemption, not the URL",
    ),
    rule("r.redeem-status", "storage.redeemUrl", "/status", EXACT, "redemption HTTP status"),
    rule(
      "r.redeem-digest",
      "storage.redeemUrl",
      "/bytesDigest",
      EXACT,
      "redeemed bytes must equal the uploaded bytes",
    ),
    rule("r.redeem-length", "storage.redeemUrl", "/contentLength", EXACT, "redeemed byte length"),
  ],
};

const COMPARED_STEPS = ["step.create-bucket", "step.upload", "step.sign", "step.redeem"];

interface StepBody {
  /** HTTP status from `transport.status` (authoritative even when the body omits it, e.g. sign). */
  status?: number | null;
  name?: string | null;
  path?: string | null;
  bytesDigest?: string | null;
  contentLength?: number | null;
  signedUrl?: string | null;
}

interface ReproOutcome {
  liteVersion: string;
  scenarioClientVersion: string;
  refIdentity: { implementation: string; version: string; client: string };
  candIdentity: { implementation: string; version: string; client: string };
  sameClientVersion: boolean;
  scenarioState: string;
  attempts: Record<string, string>;
  reference: {
    createBucket: StepBody | undefined;
    upload: StepBody | undefined;
    sign: StepBody | undefined;
    redeem: StepBody | undefined;
  };
  candidate: {
    createBucket: StepBody | undefined;
    upload: StepBody | undefined;
    sign: StepBody | undefined;
    redeem: StepBody | undefined;
  };
  uploadedFixture: { digest: string | undefined; length: number | undefined };
  referenceRedeemsUploaded: boolean;
  candidateRedeemsUploaded: boolean | undefined;
  comparison: Array<{ step: string; path: string; outcome: string; divergenceId?: string }>;
}

async function runRepro(liteVersion: string, clientVersion: string): Promise<ReproOutcome> {
  const scenario = loadScenario("supalite-signed-url-repro.json", clientVersion);
  const handles: TargetHandle[] = [
    {
      slot: "reference",
      spec: supabaseLocalSpec("reference"),
      driver: createSupabaseLocalDriver({
        scenarioResources: scenario.resources,
        client: scenario.client,
      }),
    },
    {
      slot: "candidate",
      spec: supaliteSpec("candidate", liteVersion),
      driver: createSupaliteDriver("supalite-sqlite-postgres", {
        scenarioResources: scenario.resources,
        client: scenario.client,
      }),
    },
  ];

  const result = await runScenario(scenario, handles);
  const reference = result.targets.get("reference")!;
  const candidate = result.targets.get("candidate")!;
  const scenarioDigest = computeScenarioDigest(scenario);
  const registry = loadActiveDivergences();

  const attempts: Record<string, string> = {};
  for (const a of candidate.attempts) attempts[a.stepId] = a.status;

  const rawBody = (t: typeof reference, step: string): StepBody | undefined => {
    const obs = t.rawObservations.get(`${step}:1`);
    if (!obs) return undefined;
    const body = (obs.transport.responseBody ?? {}) as Record<string, unknown>;
    return { ...(body as StepBody), status: obs.transport.status ?? (body["status"] as number) };
  };

  const refUpload = rawBody(reference, "step.upload");
  const refRedeem = rawBody(reference, "step.redeem");
  const candUpload = rawBody(candidate, "step.upload");
  const candRedeem = rawBody(candidate, "step.redeem");

  // The reference upload reports the authoritative bytes actually stored.
  const uploadedDigest = refUpload?.bytesDigest ?? undefined;
  const uploadedLength = refUpload?.contentLength ?? undefined;

  const comparison: ReproOutcome["comparison"] = [];
  if (result.state === "complete") {
    for (const stepId of COMPARED_STEPS) {
      const refObs = reference.semanticObservations.get(`${stepId}:1`);
      const candObs = candidate.semanticObservations.get(`${stepId}:1`);
      if (!refObs || !candObs) continue;
      const results = compareStep({
        scenarioId: scenario.id,
        scenarioDigest,
        scenarioRevision: scenario.revision,
        stepId,
        referenceSlot: "reference",
        candidateSlot: "candidate",
        referenceTarget: {
          kind: "supabase-local",
          version: reference.identity!.implementationVersion,
        },
        candidateTarget: { kind: "supalite-sqlite-postgres", version: liteVersion },
        referenceObservation: refObs,
        candidateObservation: candObs,
        referenceRawDigest: sha256OfCanonicalJson(
          reference.rawObservations.get(`${stepId}:1`) as never,
        ),
        candidateRawDigest: sha256OfCanonicalJson(
          candidate.rawObservations.get(`${stepId}:1`) as never,
        ),
        policy: POLICY,
        registry,
        now: new Date(),
      });
      for (const r of results) {
        comparison.push({
          step: r.stepId,
          path: r.observablePath,
          outcome: r.outcome,
          ...(r.divergenceId ? { divergenceId: r.divergenceId } : {}),
        });
      }
    }
  }

  const refClient = reference.identity?.clientVersion ?? "?";
  const candClient = candidate.identity?.clientVersion ?? "?";

  return {
    liteVersion,
    scenarioClientVersion: scenario.client.version,
    refIdentity: {
      implementation: reference.identity?.implementation ?? "?",
      version: reference.identity?.implementationVersion ?? "?",
      client: refClient,
    },
    candIdentity: {
      implementation: candidate.identity?.implementation ?? "?",
      version: candidate.identity?.implementationVersion ?? "?",
      client: candClient,
    },
    sameClientVersion: refClient === candClient && refClient === scenario.client.version,
    scenarioState: result.state,
    attempts,
    reference: {
      createBucket: rawBody(reference, "step.create-bucket"),
      upload: refUpload,
      sign: rawBody(reference, "step.sign"),
      redeem: refRedeem,
    },
    candidate: {
      createBucket: rawBody(candidate, "step.create-bucket"),
      upload: candUpload,
      sign: rawBody(candidate, "step.sign"),
      redeem: candRedeem,
    },
    uploadedFixture: { digest: uploadedDigest, length: uploadedLength },
    referenceRedeemsUploaded:
      uploadedDigest !== undefined && refRedeem?.bytesDigest === uploadedDigest,
    candidateRedeemsUploaded:
      uploadedDigest !== undefined && candRedeem?.bytesDigest != null
        ? candRedeem.bytesDigest === uploadedDigest
        : candRedeem?.bytesDigest === null
          ? false
          : undefined,
    comparison,
  };
}

const projects = ["reference", "candidate"];
afterEach(async () => {
  for (const id of projects) await forceCleanupProject(id).catch(() => undefined);
});

describe("Focused signed-URL repro (upstream #64) across pinned Supalite profiles", () => {
  it("A. supabase-local vs Supalite 0.9.0 — both driven by @supabase/supabase-js 2.97.0", async () => {
    const o = await runRepro("0.9.0", "2.97.0");
    console.log("REPRO A (lite 0.9.0, client 2.97.0):\n" + JSON.stringify(o, null, 2));

    // Same client version on BOTH targets — the differential is clean.
    expect(o.refIdentity.client).toBe("2.97.0");
    expect(o.candIdentity.client).toBe("2.97.0");
    expect(o.sameClientVersion).toBe(true);

    expect(o.candIdentity.version).toBe("0.9.0");
    expect(o.refIdentity.implementation).toBe("supabase");
    expect(o.scenarioState).toBe("complete");

    // Steps reach createSignedUrl/redeem cleanly.
    expect(o.reference.createBucket?.status).toBe(200);
    expect(o.candidate.createBucket?.status).toBe(200);
    expect(o.reference.upload?.status).toBe(200);
    expect(o.candidate.upload?.status).toBe(200);

    // Reference redeems the true uploaded bytes; candidate does not.
    expect(o.referenceRedeemsUploaded).toBe(true);
    expect(o.candidateRedeemsUploaded).toBe(false);

    const redeemDigestCmp = o.comparison.find(
      (c) => c.step === "step.redeem" && c.path === "/bytesDigest",
    );
    expect(redeemDigestCmp?.outcome).toBe("new-divergence");
  }, 300_000);

  it("B. supabase-local vs Supalite 0.10.0 — both driven by @supabase/supabase-js 2.114.0", async () => {
    const o = await runRepro("0.10.0", "2.114.0");
    console.log("REPRO B (lite 0.10.0, client 2.114.0):\n" + JSON.stringify(o, null, 2));

    // The whole point of the fix: identical client version across reference and candidate.
    expect(o.refIdentity.client).toBe("2.114.0");
    expect(o.candIdentity.client).toBe("2.114.0");
    expect(o.sameClientVersion).toBe(true);

    expect(o.candIdentity.version).toBe("0.10.0");
    expect(o.refIdentity.implementation).toBe("supabase");
    expect(o.scenarioState).toBe("complete");

    // No earlier incompatibility contaminates the result — every prior step is clean.
    expect(o.reference.createBucket?.status).toBe(200);
    expect(o.candidate.createBucket?.status).toBe(200);
    expect(o.reference.upload?.status).toBe(200);
    expect(o.candidate.upload?.status).toBe(200);
    expect(o.candidate.sign?.status).toBe(200);

    // Reference redeems exactly the uploaded bytes; candidate does NOT.
    expect(o.referenceRedeemsUploaded).toBe(true);
    expect(o.candidateRedeemsUploaded).toBe(false);
    // Contract §13: NO new KnownDivergence is registered here — this run only measures.
  }, 300_000);
});
