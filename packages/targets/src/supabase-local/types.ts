/** Route prefixes for the Kong-fronted local API (identical shape to the Supalite config). */
export interface SupabaseLocalRoutePrefixes {
  auth: string;
  rest: string;
  storage: string;
}

/**
 * Closed, spec-validated config for a `supabase-local` target (§4.4; mirror of
 * `packages/spec/src/target/schema.ts`'s `SUPABASE_LOCAL_CONFIG_SCHEMA`). Every field is
 * explicit — no implicit engine default decides a version/privilege-relevant fact.
 */
export interface SupabaseLocalTargetConfig {
  dbMajorVersion: number;
  excludedServices: string[];
  experimentalFeatures: Array<"storage">;
  keyMode: "opaque-v1";
  routePrefixes: SupabaseLocalRoutePrefixes;
  analytics: boolean;
  readinessTimeoutMs: number;
}

export const DEFAULT_ROUTE_PREFIXES: SupabaseLocalRoutePrefixes = {
  auth: "/auth/v1",
  rest: "/rest/v1",
  storage: "/storage/v1",
};

/**
 * Compose services the driver always excludes: they are not part of the observable
 * surface this build compares and every one of them either binds a fixed host port
 * (studio 54323, analytics 54327/4000, inbucket/mailpit 54324) or adds startup latency.
 * `db`, `kong`, `gotrue`, `postgrest`, `storage-api` are never excluded.
 */
export const ALWAYS_EXCLUDED_SERVICES = [
  "studio",
  "imgproxy",
  "mailpit",
  "postgres-meta",
  "edge-runtime",
  "logflare",
  "vector",
  "supavisor",
] as const;
