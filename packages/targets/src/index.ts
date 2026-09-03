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
