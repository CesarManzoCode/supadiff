/** Route prefixes for the hosted API gateway (identical shape to the other target configs). */
export interface SupabaseHostedRoutePrefixes {
  auth: string;
  rest: string;
  storage: string;
}

/**
 * Closed, spec-validated config for a `supabase-hosted` target (§4.4; L13; mirror of
 * `packages/spec/src/target/schema.ts`'s `SUPABASE_HOSTED_CONFIG_SCHEMA`). No credential
 * literal is ever a field here — project ref, Management-API access token and API keys are
 * read from the environment and only ever live in the run's `SecretVault`.
 */
export interface SupabaseHostedTargetConfig {
  attachMode: "attach-explicit" | "create-ephemeral";
  managementApiBaseUrl: string;
  namespacePrefix: string;
  region: string;
  plan: "free" | "pro";
  maxRequests: number;
  keyMode: "opaque-v1";
  routePrefixes: SupabaseHostedRoutePrefixes;
  readinessTimeoutMs: number;
}

export const DEFAULT_HOSTED_ROUTE_PREFIXES: SupabaseHostedRoutePrefixes = {
  auth: "/auth/v1",
  rest: "/rest/v1",
  storage: "/storage/v1",
};

export function defaultHostedConfig(): SupabaseHostedTargetConfig {
  return {
    attachMode: "attach-explicit",
    managementApiBaseUrl: "https://api.supabase.com",
    namespacePrefix: "sd",
    region: "us-east-1",
    plan: "free",
    maxRequests: 500,
    keyMode: "opaque-v1",
    routePrefixes: DEFAULT_HOSTED_ROUTE_PREFIXES,
    readinessTimeoutMs: 180_000,
  };
}

/** The subset of a hosted project's observable identity the driver records (§2.7). No secrets. */
export interface HostedProjectIdentity {
  /** PostgreSQL version string the platform reports (e.g. `15.8.1.093`). */
  postgresVersion: string;
  /** Postgres major version, for `TargetIdentity.backend.version`. */
  postgresMajor: string;
  region: string;
  /** Platform lifecycle status at identification time (e.g. `ACTIVE_HEALTHY`). */
  status: string;
}
