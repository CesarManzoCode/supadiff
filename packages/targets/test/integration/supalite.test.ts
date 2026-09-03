import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runScenario, type TargetHandle } from "@supadiff/engine";
import { parseScenarioSpec, parseTargetSpec, type ScenarioSpec } from "@supadiff/spec";
import { createSupaliteDriver, type SupaliteTargetKind } from "../../src/index.js";
import type { Sql } from "postgres";

const REPO_ROOT = path.resolve(fileURLToPath(new URL("../../../../", import.meta.url)));

function loadScenario(name: string): ScenarioSpec {
  const text = readFileSync(path.join(REPO_ROOT, "scenarios", "deterministic", name), "utf8");
  return parseScenarioSpec(JSON.parse(text));
}

function targetSpecFor(kind: SupaliteTargetKind, id: string) {
  return parseTargetSpec({
    id,
    kind,
    package: { name: "@supabase/lite", version: "0.9.0" },
    runtime: { runtime: "node", version: process.version },
    backend: { backend: kind.replace("supalite-", "") },
    config: {
      admin: false,
      forceRollback: false,
      experimentalFeatures: [],
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

const ALL_KINDS: SupaliteTargetKind[] = [
  "supalite-sqlite",
  "supalite-sqlite-postgres",
  "supalite-pglite",
  "supalite-postgres",
];

let postgresAdminSql: Sql | undefined;
let postgresAvailable = false;
const provisionedPostgresDbs: string[] = [];

async function makePostgresUrl(): Promise<string | undefined> {
  if (!postgresAvailable) return undefined;
  const dbName = `supadiff_test_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  await postgresAdminSql!.unsafe(`CREATE DATABASE ${dbName}`);
  provisionedPostgresDbs.push(dbName);
  const adminUrl = new URL(
    process.env.SUPADIFF_TEST_POSTGRES_ADMIN_URL ??
      "postgresql://postgres:supadiff@127.0.0.1:5432/postgres",
  );
  adminUrl.pathname = `/${dbName}`;
  return adminUrl.toString();
}

beforeAll(async () => {
  const { default: postgres } = await import("postgres");
  const adminUrl =
    process.env.SUPADIFF_TEST_POSTGRES_ADMIN_URL ??
    "postgresql://postgres:supadiff@127.0.0.1:5432/postgres";
  try {
    postgresAdminSql = postgres(adminUrl, { connect_timeout: 3 });
    await postgresAdminSql`select 1`;
    postgresAvailable = true;
  } catch {
    postgresAvailable = false;
  }
}, 15000);

afterAll(async () => {
  if (postgresAdminSql) {
    for (const db of provisionedPostgresDbs) {
      try {
        await postgresAdminSql.unsafe(`DROP DATABASE IF EXISTS ${db}`);
      } catch {
        /* best-effort cleanup */
      }
    }
    await postgresAdminSql.end({ timeout: 3 });
  }
});

/**
 * L6 acceptance (`pnpm test:integration:supalite`): the same ordinary scenario runs
 * reproducibly on all four explicit Supalite target kinds, exercising the real
 * published `@supabase/lite@0.9.0` package end to end — never a `FakeTargetDriver`.
 */
describe("L6 Supalite target family — data smoke (all four backends)", () => {
  const scenario = loadScenario("supalite-data-smoke.json");

  it.each(ALL_KINDS)(
    "runs to completion on %s",
    async (kind) => {
      const postgresUrl = kind === "supalite-postgres" ? await makePostgresUrl() : undefined;
      if (kind === "supalite-postgres" && !postgresUrl) {
        // Documented, precise external blocker (no `sudo`/native postgres reachable in
        // this environment) — skipped, never silently faked (Integration Honesty).
        console.warn(
          "supalite-postgres: skipping — no reachable admin PostgreSQL at " +
            "SUPADIFF_TEST_POSTGRES_ADMIN_URL / postgresql://postgres:supadiff@127.0.0.1:5432/postgres",
        );
        return;
      }
      const driver = createSupaliteDriver(kind, {
        scenarioResources: scenario.resources,
        postgresUrl,
      });
      const handle: TargetHandle = {
        slot: `t-${kind}`,
        spec: targetSpecFor(kind, `t-${kind}`),
        driver,
      };
      const result = await runScenario(scenario, [handle]);

      expect(result.state).toBe("complete");
      const target = result.targets.get(handle.slot)!;
      const selectRaw = [...target.rawObservations.entries()].find(([k]) =>
        k.startsWith("step.select:"),
      )?.[1];
      expect(selectRaw).toBeDefined();
      const body = selectRaw!.transport.responseBody as { status: number; rows: unknown[] };
      expect(body.status).toBe(200);
      expect(body.rows).toHaveLength(1);
      expect((body.rows[0] as { title: string }).title).toBe("hello supalite");
    },
    60000,
  );
});

describe("L6 Supalite target family — Auth + RLS smoke", () => {
  const scenario = loadScenario("supalite-auth-rls-smoke.json");
  const rlsCapableKinds: SupaliteTargetKind[] = [
    "supalite-sqlite-postgres",
    "supalite-pglite",
    "supalite-postgres",
  ];

  it.each(rlsCapableKinds)(
    "owner sees own row, anon does not, on %s",
    async (kind) => {
      const postgresUrl = kind === "supalite-postgres" ? await makePostgresUrl() : undefined;
      if (kind === "supalite-postgres" && !postgresUrl) {
        console.warn("supalite-postgres: skipping RLS smoke — no reachable admin PostgreSQL.");
        return;
      }
      const driver = createSupaliteDriver(kind, {
        scenarioResources: scenario.resources,
        postgresUrl,
      });
      const handle: TargetHandle = {
        slot: `t-${kind}`,
        spec: targetSpecFor(kind, `t-${kind}`),
        driver,
      };
      const result = await runScenario(scenario, [handle]);

      expect(result.state).toBe("complete");
      const target = result.targets.get(handle.slot)!;

      const ownerSelect = [...target.rawObservations.entries()].find(([k]) =>
        k.startsWith("step.select-owner:"),
      )?.[1];
      const anonSelect = [...target.rawObservations.entries()].find(([k]) =>
        k.startsWith("step.select-anon:"),
      )?.[1];
      expect(ownerSelect).toBeDefined();
      expect(anonSelect).toBeDefined();

      const ownerBody = ownerSelect!.transport.responseBody as { rows: unknown[] };
      const anonBody = anonSelect!.transport.responseBody as { rows: unknown[] };
      expect(ownerBody.rows).toHaveLength(1);
      expect(anonBody.rows).toHaveLength(0);
    },
    60000,
  );

  it("resolves unsupported (not a false pass or failure) on supalite-sqlite", async () => {
    const driver = createSupaliteDriver("supalite-sqlite", {
      scenarioResources: scenario.resources,
    });
    const handle: TargetHandle = {
      slot: "t-supalite-sqlite",
      spec: targetSpecFor("supalite-sqlite", "t-supalite-sqlite"),
      driver,
    };
    const result = await runScenario(scenario, [handle]);
    expect(result.state).toBe("unsupported");
  }, 30000);
});
