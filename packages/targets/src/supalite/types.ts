import type { TargetKind } from "@supadiff/spec";

/** The four explicit Supalite target identities (§2.7, §4.1). No generic "supalite" kind. */
export type SupaliteTargetKind = Extract<
  TargetKind,
  "supalite-sqlite" | "supalite-sqlite-postgres" | "supalite-pglite" | "supalite-postgres"
>;

/** The `[db].driver` value in `supabase/config.toml`, one-to-one with `SupaliteTargetKind`. */
export type SupaliteBackend = "sqlite" | "sqlite-postgres" | "pglite" | "postgres";

export const SUPALITE_BACKEND_BY_KIND: Record<SupaliteTargetKind, SupaliteBackend> = {
  "supalite-sqlite": "sqlite",
  "supalite-sqlite-postgres": "sqlite-postgres",
  "supalite-pglite": "pglite",
  "supalite-postgres": "postgres",
};

export interface SupaliteRoutePrefixes {
  auth: string;
  rest: string;
  storage: string;
}

export interface SupaliteTargetConfig {
  admin: boolean;
  forceRollback: boolean;
  experimentalFeatures: Array<"storage">;
  keyMode: "opaque-v1";
  routePrefixes: SupaliteRoutePrefixes;
  transport: "socket-server";
  readinessTimeoutMs: number;
  /**
   * Only meaningful for `supalite-postgres`: a Postgres connection string this driver
   * provisions the target against (§4.4: "`supalite-postgres` owns or explicitly attaches
   * to an isolated PostgreSQL database"). Not part of the closed spec-validated config
   * schema (it is environment/credential-shaped, resolved by the CLI secret source per
   * §4.5) — supplied out of band via `SUPADIFF_SUPALITE_POSTGRES_URL`.
   */
}

export const DEFAULT_ROUTE_PREFIXES: SupaliteRoutePrefixes = {
  auth: "/auth/v1",
  rest: "/rest/v1",
  storage: "/storage/v1",
};
