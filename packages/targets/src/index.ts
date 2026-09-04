/**
 * @supadiff/targets — concrete target and transition drivers plus shared lifecycle
 * primitives (Architecture Contract §13.2). Implements the Supalite target family
 * (L6): four explicit `TargetDriver`s built from shared process/port/workdir
 * mechanics, never a generic "supalite" identity (§4.1).
 */
export { createSupaliteDriver, type SupaliteDriverOptions } from "./supalite/driver.js";
export {
  SUPALITE_BACKEND_BY_KIND,
  DEFAULT_ROUTE_PREFIXES,
  type SupaliteBackend,
  type SupaliteTargetKind,
  type SupaliteTargetConfig,
  type SupaliteRoutePrefixes,
} from "./supalite/types.js";
export { declareSupaliteCapabilities } from "./supalite/capabilities.js";
export {
  SUPALITE_PACKAGE,
  SUPABASE_JS_PACKAGE,
  POSTGRES_JS_PACKAGE,
  ensureSupaliteInstall,
  linkSupaliteInstall,
  loadSupabaseJsForProfile,
  loadSupabaseJs,
  ensureSupabaseJsInstall,
  supabaseJsClientCacheDir,
  supaliteProfileCacheDir,
  type LoadedSupabaseClientFactory,
} from "./shared/package-cache.js";
export {
  SUPABASE_JS_CLIENTS,
  SUPABASE_JS_2_97_0,
  SUPABASE_JS_2_114_0,
  DEFAULT_SUPABASE_JS_CLIENT,
  resolveSupabaseJsClient,
  resolveClientContract,
  ClientProfileError,
  type SupabaseJsClientProfile,
} from "./shared/supabase-js-client.js";
export {
  SUPALITE_PROFILES,
  SUPALITE_PROFILE_0_9_0,
  SUPALITE_PROFILE_0_10_0,
  DEFAULT_SUPALITE_PROFILE,
  resolveSupaliteProfile,
  supaliteProfileCacheKey,
  SupaliteProfileError,
  type SupalitePackageProfile,
} from "./supalite/package-profile.js";
export { createWorkdir, type Workdir } from "./shared/workdir.js";
export { leasePort } from "./shared/ports.js";

// L7: real `supabase-local` target (pinned `supabase` CLI + Docker Compose).
export {
  createSupabaseLocalDriver,
  type SupabaseLocalDriverOptions,
} from "./supabase-local/driver.js";
export {
  DEFAULT_ROUTE_PREFIXES as SUPABASE_LOCAL_DEFAULT_ROUTE_PREFIXES,
  type SupabaseLocalTargetConfig,
} from "./supabase-local/types.js";
export { declareSupabaseLocalCapabilities } from "./supabase-local/capabilities.js";
export {
  SUPABASE_CLI_PACKAGE,
  SUPABASE_LOCAL_PINNED_IMAGES,
  ensureSupabaseCli,
} from "./shared/supabase-cli-cache.js";
export {
  scaffoldSupabaseLocalProject,
  startStack,
  stopStack,
  forceCleanupProject,
  type SupabaseLocalProvisionedProject,
} from "./supabase-local/provision.js";
export { SupabaseLocalTargetSession } from "./supabase-local/session.js";

// L13: real `supabase-hosted` target (public API + Supabase Management API, explicit opt-in).
export {
  createSupabaseHostedDriver,
  type SupabaseHostedDriverOptions,
} from "./supabase-hosted/driver.js";
export {
  defaultHostedConfig,
  DEFAULT_HOSTED_ROUTE_PREFIXES,
  type SupabaseHostedTargetConfig,
  type HostedProjectIdentity,
} from "./supabase-hosted/types.js";
export { declareSupabaseHostedCapabilities } from "./supabase-hosted/capabilities.js";
export {
  HOSTED_ENV,
  readHostedCredentials,
  hostedSecretLiterals,
  type HostedCredentials,
} from "./supabase-hosted/credentials.js";
export {
  enforceHostedSafety,
  estimateHostedCostUsd,
  type HostedSafetyDecision,
} from "./supabase-hosted/safety.js";
export {
  RequestBudget,
  HttpManagementClient,
  type ManagementClient,
  type HostedProjectInfo,
  type HostedApiKeys,
} from "./supabase-hosted/management.js";
export {
  HostedSafetyError,
  HostedBudgetError,
  HostedRateLimitError,
  HostedCredentialsMissingError,
  HostedResidentResourcesError,
  HostedProjectDriftError,
  ManagementApiError,
} from "./supabase-hosted/errors.js";
export {
  provisionHostedProject,
  cleanupHostedProject,
  recoverHostedNamespace,
  hostedServiceClient,
  type HostedProvisionedProject,
  type HostedResourceSnapshot,
  type HostedCleanupResult,
} from "./supabase-hosted/provision.js";
export { SupabaseHostedTargetSession } from "./supabase-hosted/session.js";
export { newHostedEvidence, type HostedEvidence } from "./supabase-hosted/evidence.js";

// L8: Supalite → real `lite upgrade` → Supabase-local upgrade verification (§12).
export {
  verifyUpgrade,
  type VerifyUpgradeOptions,
  type VerifyUpgradeReport,
  type UpgradeCheck,
  type UpgradeCheckStatus,
  type UpgradeTargetIdentity,
} from "./supabase-local/upgrade.js";
