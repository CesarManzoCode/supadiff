import type { TargetSpec } from "@supadiff/spec";
import { HostedBudgetError, HostedSafetyError } from "./errors.js";
import { HOSTED_ENV } from "./credentials.js";
import type { SupabaseHostedTargetConfig } from "./types.js";

/**
 * Rough hourly cost the driver assumes a `create-ephemeral` project incurs, by plan. The
 * free plan is $0; `pro` is priced from the published $25/mo compute-inclusive floor
 * spread over 730h, rounded up so the estimate is never optimistic. Only used to *refuse*
 * a run whose estimate exceeds `safety.maxHostedCostUsd` — never to bill anything.
 */
const PLAN_HOURLY_USD: Record<SupabaseHostedTargetConfig["plan"], number> = {
  free: 0,
  pro: 0.05,
};

/** Assumed wall-clock a create-ephemeral project is alive, for the pre-flight estimate. */
const EPHEMERAL_PROJECT_HOURS = 1;

export function estimateHostedCostUsd(config: SupabaseHostedTargetConfig): number {
  if (config.attachMode === "attach-explicit") return 0;
  return Math.ceil(PLAN_HOURLY_USD[config.plan] * EPHEMERAL_PROJECT_HOURS * 100) / 100;
}

export interface HostedSafetyDecision {
  estimatedUsd: number;
  attachMode: SupabaseHostedTargetConfig["attachMode"];
  allowDestructive: boolean;
}

/**
 * Enforces every hosted safety gate *before* any provisioning side effect (§ hosted safety
 * gates, explicit opt-in only):
 *
 *  1. `SUPADIFF_HOSTED=1` must be set in the environment — a hosted run is never implicit.
 *  2. `spec.safety.allowHosted` must be `true` — a second, independent opt-in in the spec.
 *  3. `create-ephemeral` additionally requires `spec.safety.allowHostedCreate`.
 *  4. The estimated cost must not exceed `spec.safety.maxHostedCostUsd`.
 *
 * `allowHostedDestructive` is not a gate here — it is threaded through to provisioning,
 * where it controls whether the driver will run against a project that already holds
 * resources it did not create.
 */
export function enforceHostedSafety(
  spec: TargetSpec,
  config: SupabaseHostedTargetConfig,
  env: NodeJS.ProcessEnv,
): HostedSafetyDecision {
  if (env[HOSTED_ENV.optIn] !== "1") {
    throw new HostedSafetyError(
      "opt-in",
      `hosted targets run only when ${HOSTED_ENV.optIn}=1 is set in the environment`,
    );
  }
  if (spec.safety.allowHosted !== true) {
    throw new HostedSafetyError(
      "allowHosted",
      "the target spec must set safety.allowHosted = true to run against a hosted project",
    );
  }
  if (config.attachMode === "create-ephemeral" && spec.safety.allowHostedCreate !== true) {
    throw new HostedSafetyError(
      "allowHostedCreate",
      "attachMode 'create-ephemeral' requires safety.allowHostedCreate = true",
    );
  }
  const estimatedUsd = estimateHostedCostUsd(config);
  if (estimatedUsd > spec.safety.maxHostedCostUsd) {
    throw new HostedBudgetError(estimatedUsd, spec.safety.maxHostedCostUsd);
  }
  return {
    estimatedUsd,
    attachMode: config.attachMode,
    allowDestructive: spec.safety.allowHostedDestructive === true,
  };
}
