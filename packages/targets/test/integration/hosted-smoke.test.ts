import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runScenario, type TargetHandle } from "@supadiff/engine";
import { parseScenarioSpec, parseTargetSpec, type ScenarioSpec } from "@supadiff/spec";
import {
  createSupabaseHostedDriver,
  enforceHostedSafety,
  estimateHostedCostUsd,
  readHostedCredentials,
  recoverHostedNamespace,
  RequestBudget,
  HttpManagementClient,
  HostedBudgetError,
  HostedCredentialsMissingError,
  HostedProjectDriftError,
  HostedRateLimitError,
  HostedResidentResourcesError,
  HostedSafetyError,
  provisionHostedProject,
  defaultHostedConfig,
  type SupabaseHostedTargetConfig,
} from "../../src/index.js";

/**
 * L13 acceptance gate (`SUPADIFF_HOSTED=1 pnpm test:integration:hosted-smoke`). Executes
 * against the *real* dedicated hosted project `supadiff-v1-smoke` — never a mock, never
 * skipped when the opt-in and credentials are present. Covers: the canonical Data + Auth +
 * owner-scoped RLS scenario end to end on real hosted PostgREST / GoTrue / PostgreSQL;
 * explicit-opt-in and budget refusals; identity/drift; and deterministic cleanup +
 * crash-recovery of exactly the resources the run created.
 */

const REPO_ROOT = path.resolve(fileURLToPath(new URL("../../../../", import.meta.url)));
const HOSTED = process.env["SUPADIFF_HOSTED"] === "1";
const HAS_CREDS =
  !!process.env["SUPADIFF_HOSTED_ACCESS_TOKEN"] && !!process.env["SUPADIFF_HOSTED_PROJECT_REF"];

function loadScenario(name: string): ScenarioSpec {
  return parseScenarioSpec(
    JSON.parse(readFileSync(path.join(REPO_ROOT, "scenarios", "deterministic", name), "utf8")),
  );
}

const BASE_CONFIG: SupabaseHostedTargetConfig = {
  ...defaultHostedConfig(),
  namespacePrefix: "sd",
  maxRequests: 400,
  readinessTimeoutMs: 60_000,
};

function hostedSpec(
  overrides: Record<string, unknown> = {},
  configOverrides: Record<string, unknown> = {},
) {
  return parseTargetSpec({
    id: "target.hosted",
    kind: "supabase-hosted",
    runtime: { runtime: "node", version: process.version },
    backend: { backend: "postgres", version: "17" },
    config: { ...BASE_CONFIG, ...configOverrides },
    credentialRefs: ["cred.hosted-access-token"],
    lifecycle: {
      allocation: "attach-explicit",
      isolation: "fresh-instance",
      readinessTimeoutMs: 60_000,
      teardownTimeoutMs: 60_000,
      cleanup: "always",
      keepOnFailure: "deny",
    },
    safety: {
      allowHosted: true,
      allowHostedCreate: false,
      allowHostedDestructive: false,
      maxHostedCostUsd: 0,
    },
    ...overrides,
  });
}

describe("L13 hosted safety + budget refusals (no network)", () => {
  const config = BASE_CONFIG;

  it("refuses without the SUPADIFF_HOSTED=1 environment opt-in", () => {
    expect(() => enforceHostedSafety(hostedSpec(), config, {})).toThrow(HostedSafetyError);
  });

  it("refuses when the spec does not set safety.allowHosted", () => {
    const spec = hostedSpec({
      safety: {
        allowHosted: false,
        allowHostedCreate: false,
        allowHostedDestructive: false,
        maxHostedCostUsd: 0,
      },
    });
    expect(() => enforceHostedSafety(spec, config, { SUPADIFF_HOSTED: "1" })).toThrow(
      HostedSafetyError,
    );
  });

  it("refuses create-ephemeral without safety.allowHostedCreate", () => {
    const spec = hostedSpec();
    const ephemeral = { ...config, attachMode: "create-ephemeral" as const };
    expect(() => enforceHostedSafety(spec, ephemeral, { SUPADIFF_HOSTED: "1" })).toThrow(
      HostedSafetyError,
    );
  });

  it("refuses when the estimated cost exceeds safety.maxHostedCostUsd", () => {
    const spec = hostedSpec({
      safety: {
        allowHosted: true,
        allowHostedCreate: true,
        allowHostedDestructive: false,
        maxHostedCostUsd: 0,
      },
    });
    const proEphemeral = {
      ...config,
      attachMode: "create-ephemeral" as const,
      plan: "pro" as const,
    };
    expect(estimateHostedCostUsd(proEphemeral)).toBeGreaterThan(0);
    expect(() => enforceHostedSafety(spec, proEphemeral, { SUPADIFF_HOSTED: "1" })).toThrow(
      HostedBudgetError,
    );
  });

  it("names exactly the missing credential variables", () => {
    try {
      readHostedCredentials({ SUPADIFF_HOSTED: "1" }, config);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(HostedCredentialsMissingError);
      expect((err as HostedCredentialsMissingError).missing).toContain(
        "SUPADIFF_HOSTED_ACCESS_TOKEN",
      );
      expect((err as HostedCredentialsMissingError).missing).toContain(
        "SUPADIFF_HOSTED_PROJECT_REF",
      );
    }
  });

  it("the per-run request budget aborts once the cap is reached", () => {
    const budget = new RequestBudget(2);
    budget.spend();
    budget.spend();
    expect(() => budget.spend()).toThrow(HostedRateLimitError);
    expect(budget.used).toBe(3);
  });
});

/**
 * Fail-closed acceptance precondition. `SUPADIFF_HOSTED=1 pnpm test:integration:hosted-smoke`
 * is the canonical L13 gate; it MUST NOT be able to exit 0 by silently skipping the networked
 * suite. When the opt-in is set but the dedicated smoke-project credentials are absent, this is
 * a hard failure — never a skip. Without the opt-in, ordinary local/unit runs skip it.
 */
describe.skipIf(!HOSTED || HAS_CREDS)(
  "L13 hosted acceptance precondition (SUPADIFF_HOSTED=1)",
  () => {
    it("fails closed when hosted credentials are absent under the opt-in", () => {
      const missing = (
        [
          ["SUPADIFF_HOSTED_ACCESS_TOKEN", process.env["SUPADIFF_HOSTED_ACCESS_TOKEN"]],
          ["SUPADIFF_HOSTED_PROJECT_REF", process.env["SUPADIFF_HOSTED_PROJECT_REF"]],
        ] as const
      )
        .filter(([, v]) => !v)
        .map(([k]) => k);
      expect.fail(
        `SUPADIFF_HOSTED=1 is set but ${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} ` +
          `absent. The L13 hosted acceptance gate cannot pass by skipping the real hosted suite — ` +
          `provide the dedicated smoke-project credentials, or run without SUPADIFF_HOSTED=1.`,
      );
    });
  },
);

describe.skipIf(!HOSTED || !HAS_CREDS)(
  "L13 real hosted smoke — dedicated project supadiff-v1-smoke",
  () => {
    const scenario = loadScenario("peer-data-auth-rls-smoke.json");
    const config = BASE_CONFIG;
    let ref = "";
    let mgmt: HttpManagementClient;

    async function census(): Promise<{
      tables: number;
      users: number;
      buckets: number;
      ownership: number;
    }> {
      const r = await mgmt.runQuery(
        ref,
        `select
        (select count(*) from information_schema.tables where table_schema='public' and table_type='BASE TABLE') as tables,
        (select count(*) from auth.users) as users,
        (select count(*) from storage.buckets) as buckets,
        (select count(*) from information_schema.schemata where schema_name='supadiff_ownership') as ownership`,
      );
      const row = r.rows[0] as Record<string, number>;
      return {
        tables: Number(row["tables"]),
        users: Number(row["users"]),
        buckets: Number(row["buckets"]),
        ownership: Number(row["ownership"]),
      };
    }

    beforeAll(() => {
      const creds = readHostedCredentials(process.env, config);
      ref = creds.projectRef!;
      mgmt = new HttpManagementClient({
        baseUrl: config.managementApiBaseUrl,
        accessToken: creds.accessToken,
        budget: new RequestBudget(10_000),
      });
    });

    afterAll(async () => {
      // Defensive net: leave the shared project exactly as found even if an assertion aborts.
      await mgmt
        .runQuery(
          ref,
          `drop table if exists public.todos cascade;
         drop schema if exists supadiff_ownership cascade;
         delete from auth.identities; delete from auth.sessions;
         delete from auth.refresh_tokens; delete from auth.one_time_tokens;
         delete from auth.mfa_factors; delete from auth.users;`,
        )
        .catch(() => undefined);
    });

    it("starts from an empty project (throwaway smoke project, not a shared one)", async () => {
      const before = await census();
      expect(before.tables, "public schema must be empty before the run").toBe(0);
      expect(before.users, "no residual auth users before the run").toBe(0);
    });

    it("runs the canonical Data + Auth + RLS scenario end to end on real hosted services and cleans up exactly what it created", async () => {
      const driver = createSupabaseHostedDriver({
        scenarioResources: scenario.resources,
        expectedIdentity: { projectRef: ref },
      });
      const handles: TargetHandle[] = [{ slot: "hosted", spec: hostedSpec(), driver }];

      const result = await runScenario(scenario, handles);
      const target = result.targets.get("hosted")!;
      expect(
        result.state,
        JSON.stringify(target.attempts.map((a) => `${a.stepId}:${a.status}`)),
      ).toBe("complete");

      // Real identity was observed and recorded (§2.7).
      expect(target.identity?.targetKind).toBe("supabase-hosted");
      expect(target.identity?.backend?.version).toBe("17");
      expect(target.identity?.implementation).toBe("supabase-platform");

      // Real RLS enforcement, measured on the raw evidence, independent of any comparator.
      const rows = (step: string) =>
        (target.rawObservations.get(`${step}:1`)!.transport.responseBody as { rows: unknown[] })
          .rows;
      expect(rows("step.select-owner"), "owner sees exactly the owned row").toHaveLength(1);
      expect(rows("step.select-anon"), "anonymous caller sees nothing — RLS enforced").toHaveLength(
        0,
      );

      // Deterministic cleanup: the measured owned-resource census returns to the pre-run empty
      // state — 0 public tables, 0 auth users, 0 Storage buckets, 0 SupaDiff ownership schema.
      // (This is the scoped property actually proven; it is not a byte-for-byte project image.)
      expect(target.teardownStatus).toBe("complete");
      const after = await census();
      expect(after).toEqual({ tables: 0, users: 0, buckets: 0, ownership: 0 });
    }, 180_000);

    it("aborts the run when the per-run request budget is too small to provision", async () => {
      const driver = createSupabaseHostedDriver({ scenarioResources: scenario.resources });
      // Provisioning exceeds the 2-request cap; the run aborts rather than spending further.
      await expect(
        runScenario(scenario, [
          { slot: "hosted", spec: hostedSpec({}, { maxRequests: 2 }), driver },
        ]),
      ).rejects.toBeInstanceOf(HostedRateLimitError);
      // Nothing was left behind by the aborted provision.
      const after = await census();
      expect(after.tables).toBe(0);
      expect(after.users).toBe(0);
    }, 120_000);

    it("refuses to attach to a project that already holds public tables (no accidental destructive access)", async () => {
      await mgmt.runQuery(ref, "create table public.pre_existing (id int primary key)");
      try {
        await expect(
          runScenario(scenario, [
            {
              slot: "hosted",
              spec: hostedSpec(),
              driver: createSupabaseHostedDriver({ scenarioResources: scenario.resources }),
            },
          ]),
        ).rejects.toBeInstanceOf(HostedResidentResourcesError);
        // The pre-existing table is untouched — the driver never dropped a resource it did not create.
        const r = await mgmt.runQuery(
          ref,
          "select count(*) as n from information_schema.tables where table_schema='public' and table_name='pre_existing'",
        );
        expect(Number((r.rows[0] as Record<string, number>)["n"])).toBe(1);
      } finally {
        await mgmt.runQuery(ref, "drop table if exists public.pre_existing cascade");
      }
    }, 120_000);

    it("HostedResidentResourcesError is the specific refusal for a non-empty attached project", async () => {
      await mgmt.runQuery(ref, "create table public.pre_existing (id int primary key)");
      try {
        await expect(
          provisionHostedProject({
            spec: hostedSpec(),
            config,
            env: process.env,
            runNamespace: `resident${Date.now()}`,
            expected: { projectRef: ref },
          }),
        ).rejects.toBeInstanceOf(HostedResidentResourcesError);
      } finally {
        await mgmt.runQuery(ref, "drop table if exists public.pre_existing cascade");
      }
    }, 120_000);

    it("crash recovery removes exactly the run's resources from the non-secret ownership handle alone", async () => {
      const project = await provisionHostedProject({
        spec: hostedSpec(),
        config,
        env: process.env,
        runNamespace: `rectest${Date.now()}`,
      });
      // Simulate work then a hard crash (no teardown): create a table the run owns.
      await project.management.runQuery(
        ref,
        "create table public.crash_table (id int primary key)",
      );
      let mid = await mgmt.runQuery(
        ref,
        "select count(*) as n from information_schema.tables where table_schema='public' and table_name='crash_table'",
      );
      expect(Number((mid.rows[0] as Record<string, number>)["n"])).toBe(1);

      const recovered = await recoverHostedNamespace({
        projectRef: ref,
        runNamespace: project.runNamespace,
        accessToken: process.env["SUPADIFF_HOSTED_ACCESS_TOKEN"]!,
        managementApiBaseUrl: config.managementApiBaseUrl,
      });
      expect(recovered.droppedPublicTables).toContain("crash_table");

      mid = await mgmt.runQuery(
        ref,
        `select
        (select count(*) from information_schema.tables where table_schema='public' and table_name='crash_table') as t,
        (select count(*) from information_schema.schemata where schema_name='supadiff_ownership') as o`,
      );
      const row = mid.rows[0] as Record<string, number>;
      expect(Number(row["t"]), "recovered table is gone").toBe(0);
      expect(Number(row["o"]), "ownership schema dropped once no run owns anything").toBe(0);

      // Idempotent: a second sweep of the same handle is a clean no-op.
      const again = await recoverHostedNamespace({
        projectRef: ref,
        runNamespace: project.runNamespace,
        accessToken: process.env["SUPADIFF_HOSTED_ACCESS_TOKEN"]!,
        managementApiBaseUrl: config.managementApiBaseUrl,
      });
      expect(again.droppedPublicTables).toEqual([]);
    }, 120_000);

    it("drift: a wrong expected project ref aborts before any side effect", async () => {
      await expect(
        provisionHostedProject({
          spec: hostedSpec(),
          config,
          env: process.env,
          runNamespace: `drift${Date.now()}`,
          expected: { projectRef: "wrongprojectref00000" },
        }),
      ).rejects.toBeInstanceOf(HostedProjectDriftError);
    });
  },
);
