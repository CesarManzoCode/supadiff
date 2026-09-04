# Changelog

All notable changes to SupaDiff. This project follows the Architecture
Contract's Implementation DAG; each entry names the layers it delivers.

## 1.0.0 — 2026-09-03

First tagged release. Implements Architecture Contract Implementation DAG
layers **L0 through L14**.

### L13 — `supabase-hosted` target

- Real `supabase-hosted` `TargetDriver` / `TargetSession`
  (`packages/targets/src/supabase-hosted/`): runs a scenario against a real
  hosted Supabase project over its public API and the Supabase Management
  API, sharing the same `@supabase/supabase-js@2.97.0` per-operation
  dispatch as every other driver.
- **Explicit opt-in only.** `SUPADIFF_HOSTED=1` and
  `spec.safety.allowHosted` are both required; `create-ephemeral`
  additionally requires `safety.allowHostedCreate`; the cost estimate is
  checked against `safety.maxHostedCostUsd` — all before the first
  management-plane call.
- **`attach-explicit`** mode runs against the pre-existing project named by
  `SUPADIFF_HOSTED_PROJECT_REF`. `create-ephemeral` mode (driver creates and
  deletes a throwaway project) is implemented and safety-gated.
- **No accidental destruction.** An attached project holding pre-existing
  `public` tables / Storage buckets / auth users is refused
  (`HostedResidentResourcesError`) unless `safety.allowHostedDestructive` is
  set. Project identity is recorded and a `projectRef` / Postgres-major /
  region mismatch aborts before any side effect (`HostedProjectDriftError`).
- **Request/cost/rate safety.** Every management- and data-plane request is
  counted against `config.maxRequests`; the cap aborts the run.
- **Deterministic cleanup + crash recovery.** Teardown removes exactly the
  `public` tables, Storage buckets and auth users that appeared during the
  run — diffed against a persisted pre-run census — and nothing else. A
  crash is recoverable from the non-secret `hosted-namespace:<ref>:<ns>`
  handle alone (`recoverHostedNamespace`, idempotent).
- **Secret-safe evidence.** The hosted evidence log carries no credential,
  key, token or signed URL and is redacted against the run's secret
  literals.
- Closed, spec-validated `supabase-hosted` config schema
  (`SUPABASE_HOSTED_CONFIG_SCHEMA`) — no credential literal is a config
  field.
- Acceptance gate: `SUPADIFF_HOSTED=1 pnpm test:integration:hosted-smoke`
  runs the canonical Data + Auth + owner-scoped RLS scenario end to end on
  the real hosted project, plus opt-in / budget / resident-resource
  refusals and cleanup / recovery — never mocked, never skipped when the
  project secrets are present.
- `docs/adr/0003-hosted-signup-via-admin-api.md` records the one
  environment-forced accommodation: `auth.signUp` on hosted goes through the
  real GoTrue admin API + password grant (the dedicated smoke project has no
  SMTP and the scoped token cannot toggle mailer autoconfirm).

### L14 — documentation & release-evidence gate

- `pnpm docs:verify` (`scripts/docs-verify.mjs`): fails on any broken
  repo-path link, any cited `pnpm`/`supadiff` command that does not exist,
  any stale pre-L13/L14 claim, version inconsistency, a capability without
  evidence, an unparseable divergence entry, or secret material in the docs.
- `pnpm release:evidence` (`scripts/release-evidence.mjs`): (re)generates
  and verifies `release-evidence/v1.0.0.json` — exact tool/target versions,
  the per-target capability matrix (straight from the driver
  `declare*Capabilities()` functions), the active divergence registry, the
  acceptance-gate command list, the explicit unproven surfaces, and a stable
  content hash. Refuses to let a committed manifest's stable content drift
  silently; verifies no secret material and no fake-target result presented
  as real Supabase/Supalite evidence.
- Both gates run in CI's `check` job; a new `hosted-smoke` CI job runs L13.
- Documentation (`README.md`, `CONTRIBUTING.md`, `docs/`) brought to the
  truthful L0-L14 state.

### v1.0.0 packaging

- All workspace package versions set to `1.0.0`.
- `release-evidence/v1.0.0.json` + `release-evidence/v1.0.0.md` are the
  versioned release manifest.

## 0.x — L0-L12 (see git history)

- `#1` Foundation: deterministic differential core (L0-L5), fake targets.
- `#2` L6-L12: real Supalite target family, real `supabase-local` driver +
  peer comparison, Supalite → `lite upgrade` → Supabase-local upgrade
  verification, dogfood fault lab + `replay`, state-aware reducer +
  `reduce`, Storage peer comparison, seeded scenario generation.
