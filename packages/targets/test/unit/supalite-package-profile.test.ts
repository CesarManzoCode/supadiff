import { describe, expect, it } from "vitest";
import type { StableId } from "@supadiff/spec";
import {
  DEFAULT_SUPALITE_PROFILE,
  SUPALITE_PROFILE_0_9_0,
  SUPALITE_PROFILE_0_10_0,
  SUPALITE_PROFILES,
  SupaliteProfileError,
  resolveSupaliteProfile,
  supaliteProfileCacheKey,
} from "../../src/supalite/package-profile.js";
import { supaliteProfileCacheDir } from "../../src/shared/package-cache.js";
import { createSupaliteDriver } from "../../src/supalite/driver.js";
import { SupaliteTargetSession } from "../../src/supalite/session.js";
import type { SupaliteProvisionedProject } from "../../src/supalite/provision.js";

/**
 * Targeted coverage for the multi-version Supalite profile mechanism. Entirely hermetic:
 * no npm install, no `lite` process, no Docker — it exercises only the pure resolver, the
 * per-profile cache keying, and `identify()`'s use of the profile it was provisioned with.
 */

describe("resolveSupaliteProfile", () => {
  it("(a) resolves 0.9.0 to exactly the historical v1.0.0 baseline profile", () => {
    const p = resolveSupaliteProfile({ name: "@supabase/lite", version: "0.9.0" });
    expect(p).toBe(SUPALITE_PROFILE_0_9_0);
    expect(p.lite).toEqual({
      name: "@supabase/lite",
      version: "0.9.0",
      integrity:
        "sha512-fpSWL9qZOqAnQmw+z1g2SEjjEKsNq/HQP9JGwX2vXJh7L32qu/zpR1kWkPUv4QFwKUtB8ShHyW7sZ3A91lpHpA==",
      npmShasum: "a0c1309f62ebdc9787e784799f2aa38a8e57ce0d",
    });
    expect(p.client.name).toBe("@supabase/supabase-js");
    expect(p.client.version).toBe("2.97.0");
    expect(DEFAULT_SUPALITE_PROFILE).toBe(SUPALITE_PROFILE_0_9_0);
    // No `package` at all also lands on the historical baseline (unchanged v1 behavior).
    expect(resolveSupaliteProfile(undefined)).toBe(SUPALITE_PROFILE_0_9_0);
  });

  it("(b) resolves 0.10.0 to exactly the new investigation profile", () => {
    const p = resolveSupaliteProfile({ name: "@supabase/lite", version: "0.10.0" });
    expect(p).toBe(SUPALITE_PROFILE_0_10_0);
    expect(p.lite).toEqual({
      name: "@supabase/lite",
      version: "0.10.0",
      integrity:
        "sha512-//mwKgC/AzQ+FXOvSk602wq/MtaiFjiQIjEfbtTC/Vuuobdx87E2fZURltP6KSImRCO0V0JYYs9NKcJ8QC1p4A==",
      npmShasum: "a00ee22fa896a006697773ecd8c0a0b63547b52a",
    });
    expect(p.client.version).toBe("2.114.0");
    expect(p.client.integrity).toBe(
      "sha512-uvmqk2yxVp77c/LjWzJaw1/HId+2a3sck4idbBy3nOTro36l7nVcHdT/XENHj7Fi/IJAvAsJrTSgTEegbYTxvQ==",
    );
  });

  it("(c) an unregistered version fails closed — no ranges, no dist-tags", () => {
    for (const bad of ["0.11.0", "latest", "^0.9.0", "0.9", "2.114.0"]) {
      expect(() => resolveSupaliteProfile({ name: "@supabase/lite", version: bad })).toThrow(
        SupaliteProfileError,
      );
    }
    expect(SUPALITE_PROFILES.size).toBe(2);
  });

  it("(c') a non-@supabase/lite package name fails closed", () => {
    expect(() =>
      resolveSupaliteProfile({ name: "@supabase/supabase-lite", version: "0.9.0" }),
    ).toThrow(SupaliteProfileError);
  });

  it("(d) a declared integrity that does not match the registered profile fails closed", () => {
    expect(() =>
      resolveSupaliteProfile({
        name: "@supabase/lite",
        version: "0.10.0",
        integrity: "sha512-deadbeefwrongintegrityvalue==",
      }),
    ).toThrow(SupaliteProfileError);
    // The correct integrity is accepted.
    expect(
      resolveSupaliteProfile({
        name: "@supabase/lite",
        version: "0.10.0",
        integrity: SUPALITE_PROFILE_0_10_0.lite.integrity,
      }),
    ).toBe(SUPALITE_PROFILE_0_10_0);
  });

  it("(e) the two profiles get distinct, deterministic cache keys and directories", () => {
    const k09 = supaliteProfileCacheKey(SUPALITE_PROFILE_0_9_0);
    const k10 = supaliteProfileCacheKey(SUPALITE_PROFILE_0_10_0);
    expect(k09).not.toBe(k10);
    // Keys encode both the lite version and the client version.
    expect(k09).toContain("0.9.0");
    expect(k09).toContain("2.97.0");
    expect(k10).toContain("0.10.0");
    expect(k10).toContain("2.114.0");
    const d09 = supaliteProfileCacheDir(SUPALITE_PROFILE_0_9_0);
    const d10 = supaliteProfileCacheDir(SUPALITE_PROFILE_0_10_0);
    expect(d09).not.toBe(d10);
    expect(d09.endsWith(k09)).toBe(true);
    expect(d10.endsWith(k10)).toBe(true);
  });
});

describe("createSupaliteDriver: client contract fails closed on an unregistered lite↔client pair", () => {
  const ctx = {
    runNamespace: "ns" as StableId,
    vault: { put: () => "s" as never, reveal: () => "" },
  } as never;

  function spec(liteVersion: string) {
    return {
      id: "candidate" as StableId,
      kind: "supalite-sqlite-postgres" as const,
      package: { name: "@supabase/lite", version: liteVersion },
      runtime: { runtime: "node", version: process.version },
      backend: { backend: "sqlite-postgres" },
      config: {},
      credentialRefs: [],
      lifecycle: {
        allocation: "provision-new" as const,
        isolation: "fresh-instance" as const,
        readinessTimeoutMs: 1000,
        teardownTimeoutMs: 1000,
        cleanup: "always" as const,
        keepOnFailure: "deny" as const,
      },
      safety: {
        allowHosted: false,
        allowHostedCreate: false,
        allowHostedDestructive: false,
        maxHostedCostUsd: 0,
      },
    } as never;
  }

  it("lite 0.9.0 + scenario client 2.114.0 → SupaliteProfileError before any provisioning", async () => {
    const driver = createSupaliteDriver("supalite-sqlite-postgres", {
      scenarioResources: [],
      client: { library: "supabase-js", version: "2.114.0" },
    });
    await expect(driver.provision(spec("0.9.0"), ctx)).rejects.toThrow(SupaliteProfileError);
  });

  it("lite 0.10.0 + scenario client 2.97.0 → SupaliteProfileError", async () => {
    const driver = createSupaliteDriver("supalite-sqlite-postgres", {
      scenarioResources: [],
      client: { library: "supabase-js", version: "2.97.0" },
    });
    await expect(driver.provision(spec("0.10.0"), ctx)).rejects.toThrow(SupaliteProfileError);
  });
});

function fakeProject(profile: typeof SUPALITE_PROFILE_0_9_0): SupaliteProvisionedProject {
  return {
    workdirPath: "/tmp/none",
    backend: "sqlite-postgres",
    port: 54999,
    baseUrl: "http://127.0.0.1:54999",
    publishableKey: "pk",
    secretKey: "sk",
    config: {} as never,
    profile,
    createClient: (() => {
      throw new Error("not used by identify()");
    }) as never,
    clientVersion: profile.client.version,
  };
}

describe("SupaliteTargetSession.identify()", () => {
  it("(f) reports the provisioned profile's versions, not hardcoded constants", async () => {
    const session = new SupaliteTargetSession(
      "h" as StableId,
      "supalite-sqlite-postgres",
      "sqlite-postgres",
      fakeProject(SUPALITE_PROFILE_0_10_0),
      { put: () => "s" as never, reveal: () => "" } as never,
      new Map(),
    );
    const id = await session.identify();
    expect(id.implementationVersion).toBe("0.10.0");
    expect(id.packageIntegrity).toBe(SUPALITE_PROFILE_0_10_0.lite.integrity);
    expect(id.clientVersion).toBe("2.114.0");
    expect(id.implementation).toBe("@supabase/lite");
    // Provenance text must not be pinned to the other version.
    expect(id.unknownSourceRevisionReason).toContain("0.10.0");
    expect(id.unknownSourceRevisionReason).not.toContain("0.9.0");

    const baseline = new SupaliteTargetSession(
      "h" as StableId,
      "supalite-sqlite-postgres",
      "sqlite-postgres",
      fakeProject(SUPALITE_PROFILE_0_9_0),
      { put: () => "s" as never, reveal: () => "" } as never,
      new Map(),
    );
    const idB = await baseline.identify();
    expect(idB.implementationVersion).toBe("0.9.0");
    expect(idB.clientVersion).toBe("2.97.0");
    expect(idB.unknownSourceRevisionReason).toContain("0.9.0");
  });
});
