import semver from "semver";
import type {
  CapabilityRequirement,
  CapabilityResolutionStatus,
  TargetCapability,
} from "@supadiff/spec";

export interface CapabilityResolution {
  requirement: CapabilityRequirement;
  status: CapabilityResolutionStatus;
  matchedCapability?: TargetCapability;
}

/**
 * Resolves one requirement against a target's declared/probed capabilities (§2.8).
 * A requirement is `satisfied` only at level `exact`; `accepted-approximation` requires
 * the requirement to explicitly accept `approximation`/`experimental`. Runtime probes
 * may only downgrade a declared level, never upgrade it silently.
 */
export function resolveCapability(
  requirement: CapabilityRequirement,
  declared: TargetCapability[],
  probed: TargetCapability[] | undefined,
): CapabilityResolution {
  const declaredCap = declared.find((c) => c.id === requirement.capability);
  if (!declaredCap) return { requirement, status: "unsupported" };

  const probedCap = probed?.find((c) => c.id === requirement.capability);
  let effective = declaredCap;
  if (probedCap) {
    const rank = { exact: 3, approximation: 2, experimental: 1, unsupported: 0 } as const;
    // Runtime probes may only downgrade; never silently upgrade a declared level.
    effective = rank[probedCap.level] <= rank[declaredCap.level] ? probedCap : declaredCap;
  }

  if (!semver.satisfies(effective.version, requirement.range, { includePrerelease: true })) {
    return { requirement, status: "identity-mismatch", matchedCapability: effective };
  }

  if (effective.level === "exact") {
    return { requirement, status: "satisfied", matchedCapability: effective };
  }
  if (
    (effective.level === "approximation" || effective.level === "experimental") &&
    requirement.accept.includes(effective.level)
  ) {
    return { requirement, status: "accepted-approximation", matchedCapability: effective };
  }
  return { requirement, status: "unsupported", matchedCapability: effective };
}

export function collectRequirements(
  scenarioRequirements: CapabilityRequirement[],
  stepRequirements: CapabilityRequirement[][],
): CapabilityRequirement[] {
  return [...scenarioRequirements, ...stepRequirements.flat()];
}
