import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export const SCENARIO = {
  format: "supadiff.scenario",
  formatVersion: "1.0",
  id: "scn.cli-test",
  revision: "1",
  title: "CLI test scenario",
  tags: [],
  seed: "1",
  client: { library: "supabase-js", version: "2.97.0" },
  requirements: [
    { capability: "auth.password.signup", range: "^1.0.0", accept: ["exact"] },
    { capability: "data.select", range: "^1.0.0", accept: ["exact"] },
  ],
  resources: [],
  actors: [
    {
      id: "actor.owner",
      kind: "user",
      credentialSource: { kind: "generated", recipe: { id: "fixture.password", version: "1" } },
      initialContext: "anonymous",
      sessionPolicy: "fresh-per-target",
    },
  ],
  steps: [
    {
      id: "step.signup",
      kind: "auth.signUp",
      phase: "bootstrap",
      actor: "actor.owner",
      input: { email: "owner@example.test", password: { $secretRef: "fixture.password" } },
      capture: [
        {
          name: "owner-id",
          from: { kind: "semantic", field: "id" },
          valueType: "identifier",
          sensitivity: "identifier",
          required: true,
        },
      ],
    },
  ],
  cleanup: [],
  comparison: { policyId: "policy.cli-test", policyVersion: "1" },
  expectedOutcomes: [],
  limits: {
    maxSteps: 10,
    maxWallTimeMs: 30000,
    maxArtifactBytes: 10000000,
    maxRequestsPerTarget: 20,
    maxHostedCostUsd: 0,
    maxParallelOperations: 1,
  },
  provenance: { origin: "authored", createdAt: "2026-09-03T00:00:00.000Z", author: "test" },
};

function fakeTargetJson(id: string, scriptId: string, status: string) {
  return {
    id,
    kind: "fake",
    runtime: { runtime: "node", version: "22.10.0" },
    config: {
      scriptId,
      script: {
        identity: {
          targetKind: "fake",
          implementation: "fake-target",
          implementationVersion: "1.0.0",
          runtime: { runtime: "node", version: "22.10.0" },
          clientVersion: "0.0.0",
          platform: { os: "linux", arch: "x64" },
          effectiveConfigDigest: `sha256:${"0".repeat(64)}`,
          observedAt: "2026-09-03T00:00:00.000Z",
        },
        declaredCapabilities: [
          {
            id: "auth.password.signup",
            version: "1.0.0",
            level: "exact",
            constraints: {},
            evidence: [],
            observed: false,
          },
          {
            id: "data.select",
            version: "1.0.0",
            level: "exact",
            constraints: {},
            evidence: [],
            observed: false,
          },
        ],
        steps: {
          "step.signup": {
            category: "success",
            status: 200,
            body: {
              status,
              user: { id: "owner-abc-123", email: "owner@example.test" },
              session: { access_token: "t", refresh_token: "r", expires_in: 1 },
            },
          },
        },
        teardownStatus: "complete",
      },
    },
    credentialRefs: [],
    lifecycle: {
      allocation: "provision-new",
      isolation: "fresh-instance",
      readinessTimeoutMs: 2000,
      teardownTimeoutMs: 2000,
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

export const POLICY = {
  format: "supadiff.comparison-policy",
  formatVersion: "1.0",
  policyId: "policy.cli-test",
  policyVersion: "1",
  rules: [
    {
      id: "rule.status",
      version: "1",
      selector: {
        service: "auth",
        operationId: "auth.signUp",
        operationVersion: "1",
        observablePath: "/status",
        referenceTargetSelector: { kind: "fake" },
        candidateTargetSelector: { kind: "fake" },
      },
      inputType: "string",
      rule: { kind: "exact" },
      strictness: "contract",
      rationale: "status must match",
      evidence: [{ kind: "note", value: "test" }],
    },
    {
      id: "rule.user-id",
      version: "1",
      selector: {
        service: "auth",
        operationId: "auth.signUp",
        operationVersion: "1",
        observablePath: "/user/id",
        referenceTargetSelector: { kind: "fake" },
        candidateTargetSelector: { kind: "fake" },
      },
      inputType: "string",
      rule: { kind: "exact" },
      strictness: "contract",
      rationale: "id must match",
      evidence: [{ kind: "note", value: "test" }],
    },
    {
      id: "rule.user-email",
      version: "1",
      selector: {
        service: "auth",
        operationId: "auth.signUp",
        operationVersion: "1",
        observablePath: "/user/email",
        referenceTargetSelector: { kind: "fake" },
        candidateTargetSelector: { kind: "fake" },
      },
      inputType: "string",
      rule: { kind: "exact" },
      strictness: "contract",
      rationale: "email must match",
      evidence: [{ kind: "note", value: "test" }],
    },
  ],
};

export interface CliFixtureDir {
  dir: string;
  scenarioPath: string;
  referencePath: string;
  matchPath: string;
  mismatchPath: string;
  policyPath: string;
}

/** Writes a fresh temp directory with scenario/target/policy JSON files for CLI tests. */
export async function writeCliFixtures(): Promise<CliFixtureDir> {
  const dir = await mkdtemp(path.join(tmpdir(), "supadiff-cli-test-"));
  const scenarioPath = path.join(dir, "scenario.json");
  const referencePath = path.join(dir, "reference.json");
  const matchPath = path.join(dir, "match.json");
  const mismatchPath = path.join(dir, "mismatch.json");
  const policyPath = path.join(dir, "policy.json");

  await writeFile(scenarioPath, JSON.stringify(SCENARIO));
  await writeFile(
    referencePath,
    JSON.stringify(fakeTargetJson("target.reference", "cli-reference", "success")),
  );
  await writeFile(
    matchPath,
    JSON.stringify(fakeTargetJson("target.match", "cli-match", "success")),
  );
  await writeFile(
    mismatchPath,
    JSON.stringify(fakeTargetJson("target.mismatch", "cli-mismatch", "error")),
  );
  await writeFile(policyPath, JSON.stringify(POLICY));

  return { dir, scenarioPath, referencePath, matchPath, mismatchPath, policyPath };
}

export async function freshOutDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "supadiff-cli-out-"));
  const out = path.join(dir, "run.supadiff");
  await mkdir(dir, { recursive: true });
  return out;
}
