// The canonical SupaDiff v1 acceptance gates (L14).
//
// One entry per command that actually proves a layer of the Implementation DAG. Shared
// verbatim by the release-evidence manifest gate (`release-evidence.mjs`, which asserts
// each `command` is a real package.json script and each has a recorded result) and by the
// acceptance recorder (`release-acceptance.mjs`, which executes each `command` and records
// its real exit code + sanitized output). This is not a CI framework: it is the fixed,
// bounded list of release gates.

/** @typedef {{ id: string, command: string, proves: string, limitations: string }} AcceptanceGate */

/** @type {AcceptanceGate[]} */
export const ACCEPTANCE_GATES = [
  {
    id: "core",
    command: "pnpm check",
    proves: "L0-L5 deterministic core + boundary/lint/build/typecheck/format/unit",
    limitations: "Hermetic; no real target, no network. Includes the management-plane fault suite.",
  },
  {
    id: "L6",
    command: "pnpm test:integration:supalite",
    proves: "real Supalite family, all four backends",
    limitations:
      "`supalite-postgres` runs only when a local admin PostgreSQL is reachable at " +
      "SUPADIFF_TEST_POSTGRES_ADMIN_URL; otherwise that one backend self-skips (recorded in the log).",
  },
  {
    id: "L7",
    command: "pnpm test:integration:peer-data-auth-rls",
    proves: "Supalite ↔ supabase-local Data + Auth + native RLS + failure modes",
    limitations: "Requires Docker; brings up the pinned supabase-local stack.",
  },
  {
    id: "L8",
    command: "pnpm test:integration:upgrade-local",
    proves: "real Supalite → lite upgrade --target local → supabase-local verification",
    limitations: "Requires Docker. `--target hosted` transitions are out of scope.",
  },
  {
    id: "L9",
    command: "pnpm test:fault-lab:replay",
    proves: "dogfood fault lab + supadiff replay",
    limitations: "Hermetic.",
  },
  {
    id: "L10",
    command: "pnpm test:fault-lab:reduce",
    proves: "state-aware reducer / ddmin",
    limitations: "Hermetic. Scoped to SupaDiff's own Data+Auth+RLS domain model.",
  },
  {
    id: "L11",
    command: "pnpm test:integration:peer-storage",
    proves: "Storage byte-identity peer comparison (Supalite×2 and Supalite ↔ supabase-local)",
    limitations: "Requires Docker for the Supalite ↔ supabase-local pair.",
  },
  {
    id: "L12",
    command: "pnpm test:generators",
    proves: "seeded scenario generation domain model",
    limitations:
      "Hermetic. Scoped to SupaDiff's own domain model, not a general-purpose generator.",
  },
  {
    id: "L12-smoke",
    command: "pnpm test:generated-smoke",
    proves: "one generated scenario executed live",
    limitations: "Runs a single generated scenario against a real Supalite target.",
  },
  {
    id: "L13",
    command: "SUPADIFF_HOSTED=1 pnpm test:integration:hosted-smoke",
    proves:
      "real hosted Supabase project: Data + Auth + RLS end to end, opt-in/budget refusals, " +
      "deterministic cleanup + crash recovery",
    limitations:
      "Requires the dedicated throwaway smoke project's credentials (SUPADIFF_HOSTED_ACCESS_TOKEN, " +
      "SUPADIFF_HOSTED_PROJECT_REF). Fail-closed: with SUPADIFF_HOSTED=1 and no credentials the " +
      "command exits non-zero rather than skipping. Cleanup proves the measured owned-resource " +
      "census returns to the pre-run empty state, not a byte-for-byte project image. " +
      "`create-ephemeral` and `--target hosted` upgrades are not exercised. Runs entirely over " +
      "the live hosted API/Management API, so a transient upstream fault during runtime " +
      "capability probing can finalize a single attempt `unsupported` (infrastructure outcome, " +
      "not a behavioral result); the recorded result is from an attempt that completed cleanly.",
  },
  {
    id: "L14-docs",
    command: "pnpm docs:verify",
    proves: "documentation ↔ implementation ↔ acceptance-command consistency",
    limitations: "Hermetic; reads committed files + built dist only.",
  },
  {
    id: "L14-evidence",
    command: "pnpm release:evidence",
    proves: "this manifest — versioned, secret-free, invariant-checked, acceptance-result-backed",
    limitations:
      "Verifies the recorded acceptance results for consistency, non-failure, and freshness " +
      "against the release inputs digest; it does not itself re-execute the gates.",
  },
];
