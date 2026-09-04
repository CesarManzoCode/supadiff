import { describe, expect, it } from "vitest";
import {
  ClientProfileError,
  DEFAULT_SUPABASE_JS_CLIENT,
  SUPABASE_JS_2_97_0,
  SUPABASE_JS_2_114_0,
  SUPABASE_JS_CLIENTS,
  resolveClientContract,
  resolveSupabaseJsClient,
} from "../../src/shared/supabase-js-client.js";
import {
  SUPALITE_PROFILE_0_9_0,
  SUPALITE_PROFILE_0_10_0,
} from "../../src/supalite/package-profile.js";

/**
 * The `@supabase/supabase-js` client contract is the single source of truth for which
 * client build a run is driven through, and it fails closed on anything unregistered.
 * Entirely hermetic — pure resolver, no npm install.
 */

describe("resolveSupabaseJsClient / resolveClientContract", () => {
  it("registers exactly the two verified clients, keyed by exact version, no latest/ranges", () => {
    expect([...SUPABASE_JS_CLIENTS.keys()].sort()).toEqual(["2.114.0", "2.97.0"]);
    expect(resolveSupabaseJsClient("2.97.0")).toBe(SUPABASE_JS_2_97_0);
    expect(resolveSupabaseJsClient("2.114.0")).toBe(SUPABASE_JS_2_114_0);
    expect(DEFAULT_SUPABASE_JS_CLIENT).toBe(SUPABASE_JS_2_97_0);
  });

  it("an unregistered version fails closed", () => {
    for (const bad of ["2.100.0", "latest", "^2.97.0", "2.97", "0.9.0"]) {
      expect(() => resolveSupabaseJsClient(bad)).toThrow(ClientProfileError);
    }
  });

  it("resolveClientContract: no contract → the 2.97.0 baseline", () => {
    expect(resolveClientContract(undefined)).toBe(SUPABASE_JS_2_97_0);
  });

  it("resolveClientContract: supabase-js@<registered> resolves; unknown fails closed", () => {
    expect(resolveClientContract({ library: "supabase-js", version: "2.114.0" })).toBe(
      SUPABASE_JS_2_114_0,
    );
    expect(() => resolveClientContract({ library: "supabase-js", version: "9.9.9" })).toThrow(
      ClientProfileError,
    );
  });

  it("resolveClientContract: a non-supabase-js library is not installable here → fails closed", () => {
    expect(() => resolveClientContract({ library: "raw-http", version: "1" })).toThrow(
      ClientProfileError,
    );
  });
});

describe("Supalite package profiles reference the shared client registry (no duplicated integrity)", () => {
  it("0.9.0 ↔ 2.97.0 and 0.10.0 ↔ 2.114.0 are the SAME objects, not re-declared constants", () => {
    expect(SUPALITE_PROFILE_0_9_0.client).toBe(SUPABASE_JS_2_97_0);
    expect(SUPALITE_PROFILE_0_10_0.client).toBe(SUPABASE_JS_2_114_0);
    // Integrity is defined once, in the client registry.
    expect(SUPALITE_PROFILE_0_9_0.client.integrity).toBe(SUPABASE_JS_2_97_0.integrity);
    expect(SUPALITE_PROFILE_0_10_0.client.integrity).toBe(SUPABASE_JS_2_114_0.integrity);
  });
});
