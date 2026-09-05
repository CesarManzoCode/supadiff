/**
 * L13 hosted-target failure classes. These are all raised *before or during* provisioning
 * — never mid-scenario — so the engine finalizes the run `inconclusive` (an infrastructure
 * outcome) and never a behavioral result. None of their messages carry a credential, a
 * project ref, an API key or a signed URL.
 */

/** A hosted safety gate refused the run (opt-in absent, create not permitted, …). */
export class HostedSafetyError extends Error {
  readonly gate: string;
  constructor(gate: string, detail: string) {
    super(`hosted safety refusal [${gate}]: ${detail}`);
    this.name = "HostedSafetyError";
    this.gate = gate;
  }
}

/** The estimated cost of the run exceeds `safety.maxHostedCostUsd`. */
export class HostedBudgetError extends Error {
  readonly estimatedUsd: number;
  readonly budgetUsd: number;
  constructor(estimatedUsd: number, budgetUsd: number) {
    super(
      `hosted budget refusal: estimated cost $${estimatedUsd.toFixed(2)} exceeds ` +
        `safety.maxHostedCostUsd $${budgetUsd.toFixed(2)}`,
    );
    this.name = "HostedBudgetError";
    this.estimatedUsd = estimatedUsd;
    this.budgetUsd = budgetUsd;
  }
}

/** This target may issue only `config.maxRequests` requests per run; that cap was hit. */
export class HostedRateLimitError extends Error {
  constructor(max: number) {
    super(`hosted rate limit: this target's per-run request cap (${max}) was reached`);
    this.name = "HostedRateLimitError";
  }
}

/** Required hosted environment variables are missing. `missing` names exactly which. */
export class HostedCredentialsMissingError extends Error {
  readonly missing: readonly string[];
  constructor(missing: readonly string[]) {
    super(
      `hosted target: missing required environment variable(s): ${missing.join(", ")}. ` +
        `See docs/TARGETS.md "supabase-hosted driver".`,
    );
    this.name = "HostedCredentialsMissingError";
    this.missing = missing;
  }
}

/**
 * `attach-explicit` was pointed at a project that already holds user resources (tables in
 * `public`, or Storage buckets) and `safety.allowHostedDestructive` is not set. The driver
 * refuses rather than risk touching resources it did not create.
 */
export class HostedResidentResourcesError extends Error {
  constructor(kind: string, names: readonly string[]) {
    super(
      `hosted target: the attached project already has ${kind}: ` +
        `${names.slice(0, 8).join(", ")}${names.length > 8 ? ", …" : ""}. Refusing to run against a ` +
        `project with pre-existing resources — use a dedicated throwaway project, or set ` +
        `safety.allowHostedDestructive to acknowledge the risk.`,
    );
    this.name = "HostedResidentResourcesError";
  }
}

/**
 * The attached project's observed identity does not match the identity the run expected
 * (`projectRef`, Postgres major, or region). Raised before any side effect: a hosted run
 * never proceeds against a project it cannot positively identify (§2.7).
 */
export class HostedProjectDriftError extends Error {
  readonly field: string;
  constructor(field: string, expected: string, observed: string) {
    super(
      `hosted project drift [${field}]: expected ${JSON.stringify(expected)}, ` +
        `observed ${JSON.stringify(observed)}. Refusing to run against a project whose identity ` +
        `does not match what was configured.`,
    );
    this.name = "HostedProjectDriftError";
    this.field = field;
  }
}

/**
 * A hosted `schema.apply` applied the schema but the PostgREST Data API never converged on
 * it: repeated probes still reported the schema-cache-not-ready condition (PGRST205 /
 * equivalent "missing relation") after the bounded attempt budget (issue #6). `schema.apply`
 * must fail closed rather than return success while the applied schema is still unusable.
 */
export class HostedSchemaReadinessError extends Error {
  readonly table: string;
  readonly attempts: number;
  constructor(table: string, attempts: number) {
    super(
      `hosted schema readiness: table "${table}" was still not visible through the Data API ` +
        `after ${attempts} attempt(s) — the PostgREST schema cache did not converge in time.`,
    );
    this.name = "HostedSchemaReadinessError";
    this.table = table;
    this.attempts = attempts;
  }
}

/** The Supabase Management API returned a non-2xx or was unreachable. */
export class ManagementApiError extends Error {
  readonly status: number;
  readonly endpoint: string;
  constructor(endpoint: string, status: number, detail: string) {
    super(`management API ${endpoint} → ${status}: ${detail}`);
    this.name = "ManagementApiError";
    this.status = status;
    this.endpoint = endpoint;
  }
}
