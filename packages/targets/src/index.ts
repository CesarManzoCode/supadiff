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
} from "./shared/package-cache.js";
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

// L8: local Supabase upgrade verification (§12).
export {
  verifyUpgrade,
  type VerifyUpgradeOptions,
  type VerifyUpgradeReport,
  type UpgradeCheck,
  type UpgradeCheckStatus,
} from "./supabase-local/upgrade.js";
