# Limitations

This document exists to prevent overclaiming. Read it before citing any
result from this repository.

## Scope: L0-L14

Implemented and tested against real evidence: the deterministic comparison
core (L0-L5, proven against fake targets), the Supalite target family (L6,
all four backends, real `@supabase/lite@0.9.0`), the real `supabase-local`
target driver and Supalite ↔ Supabase-local peer comparison (L7), Supalite →
real `lite upgrade` → Supabase-local upgrade verification (L8, `supadiff
verify-upgrade`), the dogfood fault lab and `replay` command (L9), the state-aware reducer and `reduce`
command (L10), Storage peer comparison including Supalite ↔ Supabase-local
(L11), seeded scenario generation (L12), the real `supabase-hosted` target
(L13, `SUPADIFF_HOSTED=1 pnpm test:integration:hosted-smoke` against a real
hosted project), and the documentation/release-evidence gate (L14, `pnpm
docs:verify` + `pnpm release:acceptance` + `pnpm release:evidence` — the
last refuses to emit a manifest unless every acceptance gate has a recorded,
passing, digest-consistent result).

**Accommodated / not exercised within L13:** `supabase-hosted`
`create-ephemeral` mode is implemented and safety-gated but has no real CI
gate (needs an org id + billing); `auth.signUp` on hosted uses the real
GoTrue admin API + password grant rather than the public mailer flow (see
`docs/adr/0003-hosted-signup-via-admin-api.md`); hosted `lite upgrade
--target hosted` transitions are not exercised. The hosted cleanup gate
proves that the measured owned-resource census (public tables, auth users,
Storage buckets, SupaDiff ownership schema) returns to the pre-run empty
state — not that the hosted project is byte-for-byte identical to its
initial image. Realtime, Edge Functions, a
dashboard/UI, a generic fuzzing framework, and a generic database reducer
were never in scope for any layer (see the Architecture Contract's own
non-goals, §20).

## L7/L8: implemented on a real Docker host

L7 (a real `supabase-local` target) and L8 (`verify-upgrade`) were blocked in
the original Claude Code Web sandbox purely because that sandbox's egress
proxy refused every Docker registry blob download (`docker pull hello-world`
→ 403). They were implemented in this sprint on a local Fedora host where
Docker works normally (`docker pull hello-world` → PASS).

- **L7** (`packages/targets/src/supabase-local/`,
  `pnpm test:integration:peer-data-auth-rls`): a `supabase-local`
  `TargetDriver`/`TargetSession` pair — same SPI shape as the Supalite
  drivers, importing only `@supadiff/engine/spi` — provisioned by a
  reproducibly pinned `supabase` CLI (**2.116.0**) over Docker Compose.
  Pinning the CLI pins the whole service image set. Data + Auth + native RLS
  - Storage all `exact`; failure modes (container death → `target-lost` →
    inconclusive; port collision → bounded retry; identity mismatch →
    inconclusive; cleanup/recovery) all covered. The peer scenario
    `scn.peer-data-auth-rls-smoke` runs to completion on
    `supalite-sqlite-postgres` (reference) and `supabase-local` (candidate)
    against both real stacks, and every compared observable path agrees.
- **L8** (`packages/targets/src/supabase-local/upgrade.ts`, `supadiff
verify-upgrade`, `pnpm test:integration:upgrade-local`): a mandatory
  dry-run, then the real Architecture Contract §12 transition — a file-backed
  `supalite-sqlite-postgres` project cloned into a retained **baseline B**
  and an **upgrade-source U**, then the real `lite upgrade --target local`
  (`@supabase/lite@0.9.0`, driven at the pinned `supabase` CLI 2.116.0 via
  `LITE_SUPABASE_CLI`) migrating U into a **fresh Supabase-local stack C**.
  Verified: source workdir untouched, baseline retained, row IDs + Auth
  logical subject preserved, deliberate corruption detected, no session
  preservation (the pre-upgrade token is rejected), the actor
  **re-authenticates** for the same subject, RLS behavior lockstep B vs C.
  The serial-sequence position is **not** carried by `lite upgrade` from a
  file-backed source (`div.lite-upgrade-local-sequence-not-reset`, reported
  `sequence-next-use = divergence`); Storage preservation is `unsupported`
  and is **rejected before any mutation** when `--require-storage` is passed.
  The old Postgres 15→17 `pg_dump` helper was **removed** — it was never §12.

Exact versions: `@supabase/lite` 0.9.0; supabase CLI 2.116.0; the CLI stack
`lite upgrade --target local` brings up pins postgres 15.8.1.085 (its own
`db.major_version = 15`), gotrue v2.196.0, postgrest v16.1, plus studio and
postgres-meta.

## What L6-L12 actually proved, precisely

- **L7** (`packages/targets/src/supabase-local/`,
  `pnpm test:integration:peer-data-auth-rls`): a real `supabase-local` stack
  (pinned `supabase` CLI 2.116.0 over Docker Compose — postgres 17.6.1.165,
  gotrue v2.196.0, postgrest v16.1, storage-api v1.70.3, kong 2.8.1) driven
  by the same `@supabase/supabase-js@2.97.0` client as the Supalite family
  through a shared REST dispatch. The peer scenario `scn.peer-data-auth-rls-
smoke` (schema+RLS, signup, owner-authorized insert, session read,
  post-insert readback, owner select, anon select) runs to completion on
  `supalite-sqlite-postgres` (reference) and `supabase-local` (candidate);
  every compared observable path agrees (owner sees own row, anon sees none
  — the RLS behavior compared for real), with target-local UUIDs/timestamps
  excluded per §9.3. Failure modes covered: killing the container stack →
  `target-lost` → the engine finalizes `inconclusive`; a wrong requested CLI
  version → identity mismatch → `inconclusive` with no plan frozen; two
  concurrent provisions get distinct project ids and ports; teardown +
  `forceCleanupProject` remove every container and network.
- **L8** (`packages/targets/src/supabase-local/upgrade.ts`, `supadiff
verify-upgrade`, `pnpm test:integration:upgrade-local`): the real
  Architecture Contract §12 transition. Mandatory dry-run first (workflow
  plan, nothing provisioned). Then: a file-backed `supalite-sqlite-postgres`
  project bootstrapped (fixture schema + owner + owned rows + `bigserial`
  counter), probe **P0** (row ids, counters max id, owner uuid/email), the
  workdir **cloned** into a retained **baseline B** and an **upgrade-source
  U**, S0 closed. Real `lite upgrade --target local --dry-run` (readiness +
  PGlite rehearsal), then real `lite upgrade --target local --local-dir <C>
  --force --no-migrate-sessions` into a **fresh Supabase-local stack C**.
  Verified — U's `config.toml` byte-identical / no `.bak` (source not
  mutated in place); baseline B retained and still serving the pre-upgrade
  rows; migrated `auth.users` rebound to the CLI GoTrue schema (zero
  `instance_id`, empty token sentinels — no password/token bytes touched);
  the pre-upgrade token is **rejected** by C (no session preservation); the
  owner **re-authenticates** on C with the same credentials for the **same
  logical subject**; destination row ids preserved and a deliberately
  corrupted id set detected; RLS behavior lockstep on B and C (owner sees own
  rows, anon denied). **Divergence found:** `lite upgrade` from a file-backed
  source migrates row ids but not the serial-sequence position, so the first
  post-upgrade insert on C collides while the same insert on B advances
  cleanly (`div.lite-upgrade-local-sequence-not-reset`, reported
  `sequence-next-use = divergence`, not a failure). Storage preservation is
  `unsupported` — **rejected before any mutation** when `--require-storage`
  is passed, never run-then-skipped.
- **L6** (`packages/targets/src/supalite/`, `pnpm test:integration:supalite`):
  a real `lite start` subprocess, real `@supabase/supabase-js@2.97.0`
  traffic, on all four `supalite-*` backends. Found and reproduced a real
  gap in `@supabase/lite@0.9.0`: the bare `driver = "sqlite"` backend's
  declarative Postgres-dialect schema/RLS pipeline rejects `CREATE POLICY`/
  `ENABLE ROW LEVEL SECURITY`, and its Auth system-schema bootstrap never
  runs (`auth.signUp` returns 500, "no such table: auth.users") through any
  CLI path this sprint exercised. Recorded as `unsupported` capabilities
  with exact reproduction evidence in `packages/targets/src/supalite/
capabilities.ts` — capability preflight resolves the whole
  Auth/RLS scenario to `unsupported` on this one backend, never a false
  pass. See `docs/TARGETS.md` for the full per-backend matrix.
- **L9** (`test/fault-lab/`, `pnpm test:fault-lab:replay`): six deliberately
  incompatible `FakeTargetDriver` variants (one per required fault class,
  §15.5) each proven caught as `new-divergence` and each benign counterpart
  proven not misclassified; `supadiff replay` rebuilds a comparison
  artifact from a stored recipe and reproduces the same classification.
  `FakeTargetDriver` here is the contract's own sanctioned self-test
  mechanism (§15.2/§15.5), not evidence about Supabase or Supalite.
- **L10** (`packages/reducer/`, `pnpm test:fault-lab:reduce`): a
  dependency-graph-aware ddmin pass over a multi-step artifact, gated by a
  3x flake-check before any reduction and a signature-identity oracle that
  correctly excludes `scenarioDigest` itself (§9.3) so a shrunk scenario is
  still recognized as reproducing the same divergence.
- **L11** (`packages/targets/test/integration/storage.test.ts` +
  `peer-storage-local.test.ts`, `pnpm test:integration:peer-storage`): bucket
  creation, upload/download/copy byte-identity (real SHA-256 of real bytes,
  not metadata), list, remove, move, metadata readback, and signed-URL
  creation/redemption — compared for real (a) between two independently
  provisioned real Supalite backends and (b) between a real `supabase-local`
  stack (reference) and a real `supalite-sqlite-postgres` backend (candidate).
  The Supalite ↔ Supabase-local run confirms byte-identity everywhere except
  signed-URL redemption, which genuinely diverges — see "The signedUrl/
  signedURL divergence" below.
- **L12** (`packages/generators/`, `pnpm test:generators` +
  `pnpm test:generated-smoke`): a `fast-check@4.9.0`-backed generator for
  the Data+Auth+RLS domain (owner-scoped RLS schema, precondition-checked
  insert/select/update/delete sequences), byte-identical seed replay,
  10,000 validation-only generations, and 5 generated scenarios run to
  completion against a real `supalite-sqlite-postgres` target.

## The signedUrl/signedURL divergence

Found during L11 testing and now **confirmed against both real targets** as a
genuine cross-target divergence:

- `@supabase/lite@0.9.0`'s `POST /storage/v1/object/sign/:bucket/*path`
  response uses the JSON key `signedUrl` (lowercase "rl").
- `supabase/storage-api@v1.70.3` (the real service image the pinned CLI
  brings up) returns `signedURL` (capital "URL") — which is exactly what the
  official `@supabase/storage-js@2.97.0` client bundled inside `supabase-js`
  reads to build `createSignedUrl()`'s returned URL.

So against `supabase-local`, `createSignedUrl()` works end to end — redeeming
the returned URL returns the uploaded object's bytes with HTTP 200. Against
Supalite, the client leaves its URL undefined, the scenario redeems
`${baseUrl}/storage/v1undefined`, and Supalite serves that as its
admin-dashboard HTML with HTTP 200: a successful-looking response carrying
the wrong content.

`peer-storage-local.test.ts` proves the comparator reports this as
`new-divergence` at `step.redeem` `/bytesDigest` and `/contentLength` without
a registry, and as `known-divergence` with it. It is registered as
`div.supalite-signed-url-key-name` / `div.supalite-signed-url-key-name-length`
in `divergences/active/` — the first genuine `KnownDivergence` entries in
this repository, exactly as `docs/DIVERGENCES.md` predicted once L7 unblocked.
The Supalite capability record `storage.signed-url.redeem = unsupported` (in
`packages/targets/src/supalite/capabilities.ts`) is unchanged.

## Scoped simplifications inside L0-L5 (unchanged by this sprint)

These are deliberate, documented choices, not oversights — each is called
out at its point of implementation with a contract section reference:

1. **Operation catalog IDs use a distinct, case-permitting identifier
   pattern** from every other `StableId` in the system, to reconcile a
   direct contradiction between §2.1 and §2.4's literal examples. See
   `docs/adr/0001-operation-id-casing.md`.

2. **Artifacts are directory trees, not ZIP files**, per the contract's own
   "or" in §9.1. See `docs/adr/0002-artifact-directory-format.md`.

3. **Hosted safety flags are enforced by the `supabase-hosted` driver
   (L13).** `SUPADIFF_HOSTED=1` and `spec.safety.allowHosted` are both
   required before any management-plane call; `create-ephemeral` also
   requires `allowHostedCreate`; the cost estimate is checked against
   `maxHostedCostUsd`; an attached project holding pre-existing `public`
   tables / Storage buckets / auth users is refused unless
   `allowHostedDestructive` is set. `create-ephemeral` itself has no real CI
   gate (it needs `SUPADIFF_HOSTED_ORG_ID` + billing); only `attach-explicit`
   has a passing real acceptance gate.

4. **`supabase-local` schema application and Data-API grants.** The
   `supabase-local` driver applies the scenario's schema over the direct
   superuser Postgres connection and then runs a fixed set of
   `anon`/`authenticated`/`service_role` grants (the same effect the Supabase
   cloud default `auto_expose_new_tables = true` has), plus permissive
   `authenticated` policies on `storage.buckets`/`storage.objects`, so one
   scenario authored against Supalite runs identically here. This is a
   documented driver normalization, called out in `docs/TARGETS.md`; it does
   not change any compared observable behavior.

5. **Storage `list` entry-name shape differs by design** between Supalite
   (full object path in `name`) and real Supabase Storage (name relative to
   the listed prefix). The L11 Supalite ↔ Supabase-local peer test treats
   `/entries` as an `explicit-ignore` with a rationale; it is a real,
   documented behavioral difference, not the byte-identity/redemption
   behavior that test measures.

6. **Target identity mismatch detection is exact-match only.** §2.7 allows
   "unless the target policy explicitly permits a range" as an exception to
   a requested-vs-observed version mismatch producing an inconclusive
   outcome; no such range-permitting policy field is modeled yet in
   `TargetSpec`/`TargetLifecyclePolicy`.

## What is proven, precisely (L0-L5 core, unchanged)

- Untrusted scenario/target/policy/divergence JSON either becomes one
  immutable, hash-stable, canonically-serializable AST, or is rejected
  before any effect (L1).
- The same execution plan against the same fake-target scripts produces the
  same event order, every time, and cleanup runs after every terminal path
  including target loss, timeout, capability-unsupported, and cleanup
  failure itself (L2).
- Raw and semantic observations for 19 representative operations (the
  original 11 plus 8 added for L11's Storage surface) carry useful,
  attributable evidence with zero secret leakage across raw, semantic,
  event, lifecycle, cleanup, error-message, and artifact surfaces, proven
  with injected high-entropy literals per secret class (L3).
- Every equality or difference in a compared observable path is explained
  by exactly one selected rule; a deliberate one-field mutation in a
  compared row is caught as `new-divergence`; a benign difference (key
  order, row order under an unordered rule) is never misclassified as a
  divergence; ambiguous or overlapping registry/policy configurations fail
  closed rather than picking arbitrarily (L4).
- A comparison run produces a byte-identical (payload-wise), checksum-
  verifiable, secret-scanned evidence bundle; offline `compare` reproduces
  the same classification from two independently produced run artifacts
  without contacting any target (L5).

## Honest bottom line

**SupaDiff's deterministic comparison core, real Supalite target family,
real `supabase-local` target driver, Supalite ↔ Supabase-local peer
comparison (Data + Auth + RLS + Storage), Supalite → real `lite upgrade` →
Supabase-local upgrade verification, fault lab/replay, reducer, scenario
generation, the real `supabase-hosted` target (attach-explicit, against a
real hosted project), and the documentation/release-evidence gate are all
implemented and proven with real evidence (L0-L14). The accommodations and
not-yet-exercised surfaces above are the complete list — read them before
citing any hosted result.**
