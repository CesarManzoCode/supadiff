import type { ExactPackageIdentity } from "@supadiff/spec";
import {
  SUPABASE_JS_2_97_0,
  SUPABASE_JS_2_114_0,
  type SupabaseJsClientProfile,
} from "../shared/supabase-js-client.js";

/**
 * A `SupalitePackageProfile` is the *complete, exactly-pinned* third-party surface one
 * Supalite run executes against: the `@supabase/lite` implementation under test plus the
 * official `@supabase/supabase-js` client the driver genuinely calls into it, both nailed
 * to a single published version with the registry-verified tarball hashes. There is no
 * dist-tag, no semver range, and no dynamic registry metadata lookup here — the two
 * profiles below are the *only* combinations SupaDiff will provision, and any other
 * requested version fails closed (`resolveSupaliteProfile`).
 *
 * Why a closed set and not "any version": SupaDiff's evidence rules (§4.4) reject floating
 * identities in canonical target recipes, and every reported `TargetIdentity` field
 * (`implementationVersion`, `packageIntegrity`, `clientVersion`) must trace to a value that
 * was read from the real npm registry entry for that exact version, not inferred.
 */
export interface SupalitePackageProfile {
  /**
   * Stable, filesystem-safe key. Deterministically derived from the `@supabase/lite`
   * version and the `@supabase/supabase-js` client version so two profiles can never
   * share a package cache directory (see `package-cache.ts`).
   */
  readonly key: string;
  /** `@supabase/lite` — the implementation under test. */
  readonly lite: Required<ExactPackageIdentity> & { readonly npmShasum: string };
  /**
   * `@supabase/supabase-js` — the official client the driver drives the target with. This
   * is one of the shared `SupabaseJsClientProfile` registrations
   * (`shared/supabase-js-client.ts`), never a locally re-declared integrity constant, so a
   * scenario's `ScenarioSpec.client` and this pairing trace to the same source of truth.
   */
  readonly client: SupabaseJsClientProfile;
  /** `postgres` — the `supalite-postgres` backend driver dependency (unchanged across profiles). */
  readonly postgres: Required<ExactPackageIdentity>;
  /**
   * `TargetIdentity.unknownSourceRevisionReason` for this exact version — npm exposes no
   * gitHead/provenance for `@supabase/lite`, so only tarball hashes are verifiable. Kept
   * per-profile so a 0.10.0 run never reports 0.9.0-specific provenance text.
   */
  readonly sourceRevisionReason: string;
}

const POSTGRES_JS: Required<ExactPackageIdentity> = {
  name: "postgres",
  version: "3.4.8",
  integrity:
    "sha512-d+JFcLM17njZaOLkv6SCev7uoLaBtfK86vMUXhW1Z4glPWh4jozno9APvW/XKFJ3CCxVoC7OL38BqRydtu5nGg==",
};

function sourceRevisionReason(liteVersion: string): string {
  return (
    `npm registry exposes no gitHead/provenance for @supabase/lite@${liteVersion}; only tarball ` +
    "integrity/hashes are verifiable (Architecture Contract C-006, GT §2.1)."
  );
}

/**
 * The v1.0.0 baseline profile. These exact identities were what v1.0.0 was closed against
 * and every historical Supalite recipe/test that pins `@supabase/lite@0.9.0` resolves
 * here — the values MUST NOT drift.
 */
export const SUPALITE_PROFILE_0_9_0: SupalitePackageProfile = {
  key: "lite-0.9.0__client-2.97.0",
  lite: {
    name: "@supabase/lite",
    version: "0.9.0",
    integrity:
      "sha512-fpSWL9qZOqAnQmw+z1g2SEjjEKsNq/HQP9JGwX2vXJh7L32qu/zpR1kWkPUv4QFwKUtB8ShHyW7sZ3A91lpHpA==",
    npmShasum: "a0c1309f62ebdc9787e784799f2aa38a8e57ce0d",
  },
  client: SUPABASE_JS_2_97_0,
  postgres: POSTGRES_JS,
  sourceRevisionReason: sourceRevisionReason("0.9.0"),
};

/**
 * The 0.10.0 investigation profile. Identities verified directly against the npm registry
 * during the real investigation of upstream issue dswbx/lite-projects#64 (Supalite's
 * `createSignedUrl` returns JSON key `signedUrl` and a `/storage/v1`-prefixed path, both
 * of which the official `@supabase/storage-js` wire contract — `signedURL`, no prefix —
 * disagrees with). Paired with `@supabase/supabase-js@2.114.0` exactly as investigated.
 */
export const SUPALITE_PROFILE_0_10_0: SupalitePackageProfile = {
  key: "lite-0.10.0__client-2.114.0",
  lite: {
    name: "@supabase/lite",
    version: "0.10.0",
    integrity:
      "sha512-//mwKgC/AzQ+FXOvSk602wq/MtaiFjiQIjEfbtTC/Vuuobdx87E2fZURltP6KSImRCO0V0JYYs9NKcJ8QC1p4A==",
    npmShasum: "a00ee22fa896a006697773ecd8c0a0b63547b52a",
  },
  client: SUPABASE_JS_2_114_0,
  postgres: POSTGRES_JS,
  sourceRevisionReason: sourceRevisionReason("0.10.0"),
};

/** The only registered profiles, keyed by exact `@supabase/lite` version. No `latest`. */
export const SUPALITE_PROFILES: ReadonlyMap<string, SupalitePackageProfile> = new Map([
  [SUPALITE_PROFILE_0_9_0.lite.version, SUPALITE_PROFILE_0_9_0],
  [SUPALITE_PROFILE_0_10_0.lite.version, SUPALITE_PROFILE_0_10_0],
]);

export const EXPECTED_SUPALITE_PACKAGE_NAME = "@supabase/lite";

/** The baseline used when a `TargetSpec` carries no `package` at all (historical default). */
export const DEFAULT_SUPALITE_PROFILE = SUPALITE_PROFILE_0_9_0;

export class SupaliteProfileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SupaliteProfileError";
  }
}

/**
 * Resolves the exact `SupalitePackageProfile` a `TargetSpec.package` selects.
 *
 * - No `package` → the historical `0.9.0` baseline (unchanged v1.0.0 behavior).
 * - `package.name` other than `@supabase/lite` → error (the implementation identity is fixed).
 * - `package.version` not one of the two registered versions → error (fail closed; no
 *   ranges, no `latest`, no dynamic lookup).
 * - `package.integrity` present and not byte-identical to the registered profile → error.
 */
export function resolveSupaliteProfile(
  pkg: ExactPackageIdentity | undefined,
): SupalitePackageProfile {
  if (!pkg) return DEFAULT_SUPALITE_PROFILE;

  if (pkg.name !== EXPECTED_SUPALITE_PACKAGE_NAME) {
    throw new SupaliteProfileError(
      `Supalite target package must be "${EXPECTED_SUPALITE_PACKAGE_NAME}", got "${pkg.name}".`,
    );
  }

  const profile = SUPALITE_PROFILES.get(pkg.version);
  if (!profile) {
    const known = [...SUPALITE_PROFILES.keys()].join(", ");
    throw new SupaliteProfileError(
      `Unregistered @supabase/lite version "${pkg.version}". SupaDiff runs only exactly-pinned ` +
        `profiles (${known}); dist-tags, ranges and unknown versions fail closed.`,
    );
  }

  if (pkg.integrity !== undefined && pkg.integrity !== profile.lite.integrity) {
    throw new SupaliteProfileError(
      `Integrity mismatch for @supabase/lite@${pkg.version}: TargetSpec declares "${pkg.integrity}" ` +
        `but the registered profile is "${profile.lite.integrity}".`,
    );
  }

  return profile;
}

/** Deterministic package-cache subdirectory name for a profile (lite + client version). */
export function supaliteProfileCacheKey(profile: SupalitePackageProfile): string {
  return profile.key;
}
