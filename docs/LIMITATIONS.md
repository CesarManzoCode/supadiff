# Limitations

This document exists to prevent overclaiming. Read it before citing any
result from this repository.

## Scope: L0-L6, L9-L12

Implemented and tested against real evidence: the deterministic comparison
core (L0-L5, proven against fake targets), the Supalite target family (L6,
all four backends, real `@supabase/lite@0.9.0`), the dogfood fault lab and
`replay` command (L9), the state-aware reducer and `reduce` command (L10),
Storage peer comparison (L11), and seeded scenario generation (L12).

**Not implemented: L7 (Supabase-local), L8 (upgrade verification), L13
(hosted target), L14 (documentation/release evidence gate).** Realtime,
Edge Functions, a dashboard/UI, a generic fuzzing framework, and a generic
database reducer were never in scope for any layer in this sprint (see the
Architecture Contract's own non-goals, §20).

## L7/L8: blocked by environment, not by design

L7 (a real `supabase-local` target, normally provisioned via Docker
Compose) and L8 (Docker-based local upgrade verification) require running a
real Docker container. This sandbox's egress proxy returns `403 Forbidden`
on the Docker registry's blob-CDN download for **every** image pull:

```
$ docker pull hello-world
failed to copy: httpReadSeeker: failed open: failed to do request:
Get "https://production.cloudfront.docker.com/registry-v2/...": Forbidden

$ docker pull alpine:3.20
failed to copy: httpReadSeeker: failed open: failed to do request:
Get "https://production.cloudfront.docker.com/registry-v2/...": Forbidden
```

`docker ps` and the daemon itself work; registry authentication and
manifest resolution succeed; only the blob-CDN download that a real `pull`
needs is refused. This makes any real Docker container unusable here,
regardless of image. Per this sprint's explicit instruction to stop a
layer precisely rather than fake it, **no `supabase-local` driver, no
`TargetTransitionDriver`, and no `verify-upgrade` implementation were
written** — writing driver code that has never actually run against the
thing it claims to drive, with no way to verify it in this environment,
would be exactly the overclaiming this project exists to prevent.
`verify-upgrade` remains wired into the CLI's command dispatch and returns
exit 30 ("not implemented"), unchanged from before this sprint.

This is an environment fact, not a permanent one: a session with real
Docker registry access could implement L7/L8 using the same architecture
already proven for L6 (a `TargetDriver`/`TargetSession` pair in
`@supadiff/targets`, importing only `@supadiff/engine/spi`).

## What L6-L12 actually proved, precisely

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
- **L11** (`packages/targets/test/integration/storage.test.ts`,
  `pnpm test:integration:peer-storage`): bucket creation, upload/download/
  copy byte-identity (real SHA-256 digests of real bytes, not metadata),
  list, remove, move, and signed-URL creation/redemption, compared for
  real between two independently provisioned real Supalite backends
  (`supalite-sqlite-postgres`, `supalite-pglite`) — **not** Supalite vs.
  Supabase-local, because L7 is blocked (see above); this substitution is
  documented in the test itself, not silently presented as the contract's
  literal ask. This testing found a real, reproduced Supalite bug — see
  "The signedUrl/signedURL divergence" below.
- **L12** (`packages/generators/`, `pnpm test:generators` +
  `pnpm test:generated-smoke`): a `fast-check@4.9.0`-backed generator for
  the Data+Auth+RLS domain (owner-scoped RLS schema, precondition-checked
  insert/select/update/delete sequences), byte-identical seed replay,
  10,000 validation-only generations, and 5 generated scenarios run to
  completion against a real `supalite-sqlite-postgres` target.

## The signedUrl/signedURL divergence

Found during L11 testing, not fabricated: `@supabase/lite@0.9.0`'s
`POST /storage/v1/object/sign/:bucket/*path` response uses the JSON key
`signedUrl` (lowercase "rl"). The real Supabase Storage REST API contract —
and the official `@supabase/storage-js@2.97.0` client bundled inside
`supabase-js`, verified directly against its bundled source this sprint —
reads `signedURL` (capital "URL") to build `createSignedUrl()`'s returned
URL. The mismatch leaves the client-constructed URL as
`${baseUrl}/storage/v1undefined`; redeeming it through the official client
returns Supalite's admin-dashboard HTML with HTTP 200, not the uploaded
object's bytes. Reproduced directly against the raw HTTP API (bypassing
the client) to confirm the server's own redemption endpoint serves the
correct bytes when given the correctly key-cased path — isolating the bug
to this one response field name. Recorded as `storage.signed-url.redeem =
unsupported` with full evidence in `packages/targets/src/supalite/
capabilities.ts`, deliberately left out of the L11 scenario's capability
requirements so the rest of the Storage surface still runs and the
comparator can verify the (shared, deterministic) broken behavior is at
least identical across backends — see `docs/DIVERGENCES.md`.

## Scoped simplifications inside L0-L5 (unchanged by this sprint)

These are deliberate, documented choices, not oversights — each is called
out at its point of implementation with a contract section reference:

1. **Operation catalog IDs use a distinct, case-permitting identifier
   pattern** from every other `StableId` in the system, to reconcile a
   direct contradiction between §2.1 and §2.4's literal examples. See
   `docs/adr/0001-operation-id-casing.md`.

2. **Artifacts are directory trees, not ZIP files**, per the contract's own
   "or" in §9.1. See `docs/adr/0002-artifact-directory-format.md`.

3. **Hosted safety flags are parsed, not enforced.** `--allow-hosted`,
   `--allow-hosted-create`, `--allow-hosted-destructive`,
   `--max-hosted-cost-usd` are accepted by the CLI argument parser but have
   no effect, because no hosted driver exists to gate (L13, not started).

4. **`verify-upgrade`** is wired into the CLI's command dispatch and
   explicitly returns "not implemented" (exit 30) — see L7/L8 above.

5. **Target identity mismatch detection is exact-match only.** §2.7 allows
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
fault lab/replay, reducer, Storage peer comparison, and scenario generation
are implemented and proven with real evidence. Supabase-local (L7),
upgrade verification (L8), and a hosted target (L13) are not implemented —
the first two because this environment cannot run Docker, the third
because it was out of scope for this sprint.**
