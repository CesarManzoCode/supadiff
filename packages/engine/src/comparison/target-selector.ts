import semver from "semver";
import type { TargetSelector } from "@supadiff/spec";

/** The minimal identity facts a `TargetSelector` is matched against (§7.2, §2.12). */
export interface TargetSelectionIdentity {
  kind: string;
  backend?: string;
  /** Implementation/backend version matched against `TargetSelector.versionRange`. */
  version: string;
}

/**
 * Matches one `TargetSelector` against a concrete target identity. A selector's `kind`
 * MUST match exactly. `backend`, when the selector declares it, MUST match exactly — a
 * selector for `supalite-sqlite` MUST NOT match a `supalite-postgres` identity even when
 * both carry the same `kind` discriminant elsewhere in the system (§4.1, §7.2). A bounded
 * `versionRange`, when declared, is evaluated with real semver range semantics (never
 * hand-rolled) — an out-of-range or unparsable version fails closed (no match), never a
 * silent pass.
 */
export function targetSelectorMatches(
  selector: TargetSelector,
  identity: TargetSelectionIdentity,
): boolean {
  if (selector.kind !== identity.kind) return false;
  if (selector.backend !== undefined && selector.backend !== identity.backend) return false;
  if (selector.versionRange !== undefined) {
    if (!semver.valid(identity.version)) return false;
    if (!semver.satisfies(identity.version, selector.versionRange, { includePrerelease: true })) {
      return false;
    }
  }
  return true;
}
