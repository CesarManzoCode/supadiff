# Targets

## Target kinds known to the system

`packages/spec/src/target/types.ts` declares all six `TargetKind` values
from §2.7 (`supabase-hosted`, `supabase-local`, `supalite-sqlite`,
`supalite-sqlite-postgres`, `supalite-pglite`, `supalite-postgres`), plus a
seventh, `fake`, used only for test infrastructure (§15.2).

## What has a driver

- `fake` — `FakeTargetDriver` (`@supadiff/engine`'s `testing/fake-target.ts`).
  Test infrastructure only (§15.2); never evidence about Supabase or
  Supalite.
- `supalite-sqlite`, `supalite-sqlite-postgres`, `supalite-pglite`,
  `supalite-postgres` — real drivers in `@supadiff/targets/src/supalite/`,
  backed by a real `lite start` subprocess (the exact-pinned published
  `@supabase/lite@0.9.0` package) and the real `@supabase/supabase-js@2.97.0`
  client. `packages/targets/test/integration/*.test.ts`
  (`pnpm test:integration:supalite`, `pnpm test:integration:peer-storage`)
  exercise all four end to end — never scripted.
- `supabase-local` — real driver in `@supadiff/targets/src/supabase-local/`
  (L7), a full Supabase stack provisioned by the reproducibly pinned
  `supabase` CLI **2.116.0** over Docker Compose. `packages/targets/test/
integration/peer-data-auth-rls.test.ts` and `peer-storage-local.test.ts`
  exercise it end to end against the Supalite family. See "Supabase-local
  driver architecture" below.
- `supabase-hosted` — **no driver.** `parseTargetSpec` still rejects it with
  `unsupported-target-kind`; L13 was out of scope for this sprint.

## Supalite driver architecture

Each provisioned Supalite target gets its own isolated workdir
(`createWorkdir`), a leased ephemeral port, and a symlinked `node_modules`
into a single shared, exactly-pinned package install (`ensureSupaliteInstall`/
`linkSupaliteInstall` in `packages/targets/src/shared/package-cache.ts`) —
one real `npm install` of `@supabase/lite@0.9.0` + `@supabase/supabase-js@
2.97.0` + `postgres@3.4.8` per process, not per target, so provisioning many
targets stays fast without ever floating a version. `TargetIdentity.
packageIntegrity` reports the real npm-registry integrity hash recorded in
`packages/targets/src/shared/package-cache.ts`; `sourceRevision` is
deliberately `undefined` with `unknownSourceRevisionReason` set, because the
npm registry exposes no `gitHead`/provenance for this package version
(Architecture Contract Decision D-006) — never a fabricated commit hash.

`provision()` starts the server immediately (system schema only) so
`identify()`/`probeCapabilities()` observe a live target before any
scenario step runs; a `schema.apply`/`migration.apply` step stops the
server, applies the scenario's schema (`lite db diff -f` + `lite db reset`
for the three declarative backends, hand-authored timestamped migrations
under `lite migration up` for bare `sqlite`), and restarts it — file-backed
SQLite/PGlite cannot be mutated by the CLI while the server holds the
database open, and both the RLS-emulation and native-RLS backends need the
server to re-read schema/policy metadata on restart. Storage
(`EXPERIMENTAL_STORAGE=1`) must be set on every invocation that touches the
project, not just `lite start` — this sprint found the storage system
schema (`storage.buckets`, `storage.objects`) is only provisioned when the
flag was present at schema-reconciliation time (`db diff`/`db reset`/
`migration up`), not merely at server start.

## Capability matrix (declared, `packages/targets/src/supalite/capabilities.ts`)

| Capability                                                                                                          | `supalite-sqlite`                                                                                          | `supalite-sqlite-postgres`                                                                                                                                                                                                                                 | `supalite-pglite`                              | `supalite-postgres`    |
| ------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- | ---------------------- |
| `data.select`/`insert`/`update`/`delete`/`upsert`, `schema.apply`, `migration.apply`, `data.seed`, `http.preflight` | exact                                                                                                      | exact                                                                                                                                                                                                                                                      | exact                                          | exact                  |
| `schema.apply.declarative-pg-dialect`                                                                               | **unsupported** (reproduced: `db diff -f`/`lite dev` reject Postgres-dialect DDL)                          | n/a (not declared; declarative pipeline works)                                                                                                                                                                                                             | n/a                                            | n/a                    |
| `auth.password.signup`/`signin`, `auth.session.read`/`refresh`/`revoke`, `auth.user.update`                         | **unsupported** (reproduced: `auth.signUp` → 500 "no such table: auth.users" through every CLI path tried) | exact                                                                                                                                                                                                                                                      | exact                                          | exact                  |
| `rls.native`                                                                                                        | unsupported (no native RLS in SQLite)                                                                      | unsupported (SQLite storage; RLS is AST-rewrite emulated)                                                                                                                                                                                                  | exact (reproduced: owner-scoped SELECT/INSERT) | exact                  |
| `rls.emulated.with-check`                                                                                           | unsupported (depends on the declarative pipeline above)                                                    | approximation (reproduced: SELECT/INSERT authorization works end-to-end; documented gaps: subqueries in INSERT WITH CHECK, upsert checked primarily as insert, FORCE ROW LEVEL SECURITY ignored, RETURNING without a second SELECT-policy check — GT §2.5) | unsupported (not applicable — native RLS path) | unsupported            |
| `storage.bucket.create`/`object.write`/`object.read`/`signed-url.create`                                            | unsupported (not exercised; likely shares the Auth bootstrap gap)                                          | experimental                                                                                                                                                                                                                                               | experimental                                   | experimental           |
| `storage.signed-url.redeem`                                                                                         | unsupported (not exercised)                                                                                | **unsupported** (reproduced: the `signedUrl`/`signedURL` JSON-key mismatch — see `docs/DIVERGENCES.md` — breaks redemption through the official client on every non-sqlite backend identically)                                                            | unsupported (same bug)                         | unsupported (same bug) |

"Reproduced" means this sprint observed it directly against the real
published package, not inferred from documentation. Levels are `observed:
true` at runtime — `probeCapabilities()` downgrades every declared
capability to `unsupported` if the target's own health check fails, never
upgrades one.

## Canonical scenarios

`scenarios/deterministic/supalite-data-smoke.json` (L6, all four backends),
`supalite-auth-rls-smoke.json` (L6, Auth+RLS, `unsupported` resolution
proven on bare `sqlite` — never a false pass), and
`supalite-storage-smoke.json` (L11, Storage peer comparison across two real
backends).

## Supabase-local driver architecture (L7)

`packages/targets/src/supabase-local/`. Same SPI shape as the Supalite
drivers — imports only `@supadiff/engine/spi` — and shares the entire
Data/Auth/Storage per-operation translation with them
(`src/shared/rest-dispatch.ts`, one `@supabase/supabase-js@2.97.0` client),
so the peer comparison measures the target, not the driver.

- **Reproducibility anchor:** the `supabase` npm package is pinned to
  **2.116.0** (integrity recorded in `src/shared/supabase-cli-cache.ts`) and
  installed once per process into a shared cache. A CLI release hard-codes
  its service image tags, so pinning the CLI pins the stack: postgres
  `17.6.1.165` (and `15.8.1.085` as the L8 upgrade source), gotrue
  `v2.196.0`, postgrest `v16.1`, storage-api `v1.70.3`, kong `2.8.1`.
  `TargetIdentity` reports `cliVersion`, `serviceVersions`, and the real
  `sha256:` `containerDigests` observed after `supabase start`.
- **Isolation:** each stack gets a fresh workdir, a unique `project_id`
  (container/network name prefix), and per-project leased ports written into
  a generated `config.toml`. Services outside the compared surface (studio,
  realtime, imgproxy, analytics, …) are excluded via `supabase start -x`.
- **Schema + grants:** the scenario's schema is applied over the direct
  superuser Postgres URL, followed by a fixed set of
  `anon`/`authenticated`/`service_role` grants (the same effect as the cloud
  default `auto_expose_new_tables = true`) and, when Storage is enabled,
  permissive `authenticated` policies on `storage.buckets`/`storage.objects`
  — a documented normalization so a Supalite-authored scenario runs
  identically here (`docs/LIMITATIONS.md`).
- **Failure modes:** a dead container stack → `harnessFailureReason:
target-lost` (engine finalizes `inconclusive`); a transient host-port
  collision on `supabase start` → bounded retry with fresh ports; a
  requested `package.version` that does not match the observed CLI version
  → identity mismatch → `inconclusive` with no plan frozen; teardown runs
  `supabase stop --no-backup` then `forceCleanupProject` (a substring
  `docker rm`/`network rm` scoped to the project id only, never a broad
  sweep).

`supabase-local` capabilities (`src/supabase-local/capabilities.ts`): Data,
Auth, native RLS, and Storage are all `exact` — it runs the actual
production service images, not an embedded re-implementation.
`storage.signed-url.redeem` is `exact` here (the server emits the
capital-`signedURL` key the official client expects) — the exact opposite of
Supalite 0.9.0; see `docs/DIVERGENCES.md`.

## Local upgrade verification (L8)

`packages/targets/src/supabase-local/upgrade.ts` + `supadiff verify-upgrade`.
A mandatory dry-run prints the 19-step §12 flow and exits without
provisioning anything. With `--execute`: a source stack at Postgres `--from`
(default 15), fixture schema + owner + rows + sequence, a pre-upgrade
snapshot (row ids, sequence `last_value`, `auth.users`, `pg_policies`), a
`pg_dump`, then a **fresh destination workdir** with a stack at Postgres
`--to` (default 17) and a restore. Source and destination run sequentially.
Verified: the pre-upgrade access token is rejected (no session preservation),
re-authentication with the same credentials yields a new session, and row
IDs / sequence values / `auth.users` / RLS policies are preserved
structurally and functionally. Storage preservation is recorded `skipped`
(unsupported) before any Storage mutation. Exit codes: 0 (verified/dry-run),
10 (a preservation check failed), 20 (the flow aborted).
