import { HostedCredentialsMissingError } from "./errors.js";
import type { SupabaseHostedTargetConfig } from "./types.js";

/**
 * Resolved hosted credentials for one run. Every field is a live secret; the driver puts
 * each into the run's `SecretVault` immediately and never writes it anywhere else.
 */
export interface HostedCredentials {
  /** Supabase Management API personal access token (`sbp_…`). */
  accessToken: string;
  /** Project ref (`attach-explicit`), or `undefined` for `create-ephemeral`. */
  projectRef?: string;
  /** Explicit project API base URL, or `undefined` to derive `https://<ref>.supabase.co`. */
  apiUrl?: string;
  /** Explicit anon key, or `undefined` to fetch it via the Management API. */
  anonKey?: string;
  /** Explicit service_role key, or `undefined` to fetch it via the Management API. */
  serviceRoleKey?: string;
  /** `create-ephemeral` only: organization to create the throwaway project in. */
  organizationId?: string;
  /** `create-ephemeral` only: database password for the throwaway project. */
  dbPassword?: string;
}

export const HOSTED_ENV = {
  optIn: "SUPADIFF_HOSTED",
  accessToken: "SUPADIFF_HOSTED_ACCESS_TOKEN",
  projectRef: "SUPADIFF_HOSTED_PROJECT_REF",
  apiUrl: "SUPADIFF_HOSTED_API_URL",
  anonKey: "SUPADIFF_HOSTED_ANON_KEY",
  serviceRoleKey: "SUPADIFF_HOSTED_SERVICE_ROLE_KEY",
  organizationId: "SUPADIFF_HOSTED_ORG_ID",
  dbPassword: "SUPADIFF_HOSTED_DB_PASSWORD",
} as const;

function clean(v: string | undefined): string | undefined {
  const t = v?.trim();
  return t && t.length > 0 ? t : undefined;
}

/**
 * Reads and validates the hosted credentials from `env`, given the target `config`. Throws
 * `HostedCredentialsMissingError` naming exactly the variables that are absent — it never
 * partially proceeds. The `SUPADIFF_HOSTED=1` opt-in itself is enforced separately by the
 * safety gate (`enforceHostedSafety`), not here.
 */
export function readHostedCredentials(
  env: NodeJS.ProcessEnv,
  config: SupabaseHostedTargetConfig,
): HostedCredentials {
  const missing: string[] = [];
  const accessToken = clean(env[HOSTED_ENV.accessToken]);
  if (!accessToken) missing.push(HOSTED_ENV.accessToken);

  const projectRef = clean(env[HOSTED_ENV.projectRef]);
  const organizationId = clean(env[HOSTED_ENV.organizationId]);
  const dbPassword = clean(env[HOSTED_ENV.dbPassword]);

  if (config.attachMode === "attach-explicit") {
    if (!projectRef) missing.push(HOSTED_ENV.projectRef);
  } else {
    if (!organizationId) missing.push(HOSTED_ENV.organizationId);
    if (!dbPassword) missing.push(HOSTED_ENV.dbPassword);
  }

  if (missing.length > 0) throw new HostedCredentialsMissingError(missing);

  return {
    accessToken: accessToken!,
    projectRef,
    apiUrl: clean(env[HOSTED_ENV.apiUrl]),
    anonKey: clean(env[HOSTED_ENV.anonKey]),
    serviceRoleKey: clean(env[HOSTED_ENV.serviceRoleKey]),
    organizationId,
    dbPassword,
  };
}

/** All secret literals a hosted run holds — handed to the artifact secret scanner. */
export function hostedSecretLiterals(
  creds: HostedCredentials,
  keys: { anonKey: string; serviceRoleKey: string },
): string[] {
  return [
    creds.accessToken,
    creds.projectRef,
    creds.dbPassword,
    keys.anonKey,
    keys.serviceRoleKey,
  ].filter((v): v is string => typeof v === "string" && v.length > 0);
}
