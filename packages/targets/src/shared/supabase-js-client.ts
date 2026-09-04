import type { ClientContract } from "@supadiff/spec";

/**
 * A `SupabaseJsClientProfile` is one exactly-pinned published `@supabase/supabase-js`
 * build — the official client library a driver genuinely calls its target through. It is
 * the *single source of truth* for the client half of a run's third-party surface: the
 * Supalite package profiles (`supalite/package-profile.ts`) pair each `@supabase/lite`
 * version with one of these, and the `supabase-local` driver installs and drives whichever
 * one the scenario's `ScenarioSpec.client` asks for — the integrity constants live here
 * and nowhere else.
 *
 * Only the exact versions actually verified against the npm registry are registered. There
 * is no `latest`, no semver range and no dynamic metadata lookup: an unknown version fails
 * closed (`resolveSupabaseJsClient` / `resolveClientContract`).
 */
export interface SupabaseJsClientProfile {
  readonly name: "@supabase/supabase-js";
  readonly version: string;
  /** `dist.integrity` read directly from the npm registry entry for this exact version. */
  readonly integrity: string;
  /** Filesystem-safe cache key, unique per client version (see `package-cache.ts`). */
  readonly key: string;
}

/** The v1.0.0 baseline client — paired with `@supabase/lite@0.9.0`. */
export const SUPABASE_JS_2_97_0: SupabaseJsClientProfile = {
  name: "@supabase/supabase-js",
  version: "2.97.0",
  integrity:
    "sha512-kTD91rZNO4LvRUHv4x3/4hNmsEd2ofkYhuba2VMUPRVef1RCmnHtm7rIws38Fg0yQnOSZOplQzafn0GSiy6GVg==",
  key: "supabase-js-2.97.0",
};

/** The client investigated alongside `@supabase/lite@0.10.0` for upstream `dswbx/lite-projects#64`. */
export const SUPABASE_JS_2_114_0: SupabaseJsClientProfile = {
  name: "@supabase/supabase-js",
  version: "2.114.0",
  integrity:
    "sha512-uvmqk2yxVp77c/LjWzJaw1/HId+2a3sck4idbBy3nOTro36l7nVcHdT/XENHj7Fi/IJAvAsJrTSgTEegbYTxvQ==",
  key: "supabase-js-2.114.0",
};

/** The only registered clients, keyed by exact version. No `latest`, no ranges. */
export const SUPABASE_JS_CLIENTS: ReadonlyMap<string, SupabaseJsClientProfile> = new Map([
  [SUPABASE_JS_2_97_0.version, SUPABASE_JS_2_97_0],
  [SUPABASE_JS_2_114_0.version, SUPABASE_JS_2_114_0],
]);

/** Used when neither a scenario `ClientContract` nor an explicit client is supplied (historical default). */
export const DEFAULT_SUPABASE_JS_CLIENT = SUPABASE_JS_2_97_0;

export class ClientProfileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClientProfileError";
  }
}

/**
 * Resolves the exact `SupabaseJsClientProfile` for a `@supabase/supabase-js` version.
 * An unregistered version fails closed — a driver must never provision an unpinned client.
 */
export function resolveSupabaseJsClient(version: string): SupabaseJsClientProfile {
  const profile = SUPABASE_JS_CLIENTS.get(version);
  if (!profile) {
    const known = [...SUPABASE_JS_CLIENTS.keys()].join(", ");
    throw new ClientProfileError(
      `Unregistered @supabase/supabase-js version "${version}". SupaDiff drives targets only with ` +
        `exactly-pinned, registry-verified client builds (${known}); dist-tags, ranges and unknown ` +
        `versions fail closed.`,
    );
  }
  return profile;
}

/**
 * Resolves the `SupabaseJsClientProfile` a scenario's `ScenarioSpec.client` selects.
 *
 * - No contract → the historical `2.97.0` baseline (unchanged v1.0.0 behavior).
 * - `library` other than `"supabase-js"` → error: this installer only provisions the
 *   official `@supabase/supabase-js` client. (`raw-http` targets are not client-pinned and
 *   must not reach here.)
 * - `version` not one of the registered clients → error (fail closed).
 */
export function resolveClientContract(client: ClientContract | undefined): SupabaseJsClientProfile {
  if (!client) return DEFAULT_SUPABASE_JS_CLIENT;
  if (client.library !== "supabase-js") {
    throw new ClientProfileError(
      `ScenarioSpec.client.library is "${client.library}", but this driver drives its target ` +
        `through the official @supabase/supabase-js client — only "supabase-js" is installable here.`,
    );
  }
  return resolveSupabaseJsClient(client.version);
}
