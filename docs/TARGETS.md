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
- `supabase-local`, `supabase-hosted` — **no driver.** `parseTargetSpec`
  still rejects both with `unsupported-target-kind`. `supabase-local` is
  blocked by this environment's Docker access (see `docs/LIMITATIONS.md`);
  `supabase-hosted` (L13) was out of scope for this sprint.

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

## What L7/L8 would need to add (not started — see `docs/LIMITATIONS.md`)

- A `supabase-local` `TargetDriver`/`TargetSession` in `@supadiff/targets`,
  Docker Compose-provisioned, importing only `@supadiff/engine/spi` — same
  shape as the Supalite drivers above, blocked only by this sandbox's
  Docker registry access.
- A `TargetTransitionDriver` for L8's upgrade workflow (§12), with
  `--local-dir`/dry-run safety mechanics per §12.6.
- `verify-upgrade` CLI wiring beyond the current "not implemented" stub.
