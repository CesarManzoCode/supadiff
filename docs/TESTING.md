# Testing

## What actually exists

| Layer                    | Location                                                                           | Test files | Tests | Real target?                             |
| ------------------------ | ---------------------------------------------------------------------------------- | ---------- | ----- | ---------------------------------------- |
| L1 spec                  | `@supadiff/spec`                                                                   | 5          | 36    | n/a                                      |
| L2-L5 engine             | `@supadiff/engine`                                                                 | 10         | 131   | fake only                                |
| L5 CLI                   | `supadiff` (cli)                                                                   | 4          | 24    | fake only                                |
| L6 Supalite family       | `packages/targets/test/integration/supalite.test.ts`                               | 1          | 8     | **real** `@supabase/lite`                |
| L7 supabase-local + peer | `packages/targets/test/integration/peer-data-auth-rls.test.ts`                     | 1          | 5     | **real** Supalite + supabase-local       |
| L8 verify-upgrade        | `packages/targets/test/integration/upgrade-local.test.ts`                          | 1          | 4     | **real** Docker + real `lite upgrade`    |
| L9 fault lab + replay    | `test/fault-lab/fault-lab.test.ts`, `replay.test.ts`                               | 2          | 18    | fake (deliberately, §15.2)               |
| L10 reducer              | `test/fault-lab/reduce.test.ts`                                                    | 1          | 2     | fake (deliberately, §15.2)               |
| L11 Storage peer         | `packages/targets/test/integration/storage.test.ts` + `peer-storage-local.test.ts` | 2          | 2     | **real**, Supalite×2 and Supalite↔local |
| L12 generators           | `packages/generators/test/generation.test.ts`                                      | 1          | 6     | n/a (validation-only)                    |
| L12 generated smoke      | `packages/generators/test/live-smoke/generated-smoke.test.ts`                      | 1          | 1     | **real** `@supabase/lite`                |

All numbers above are reproducible by running the commands below; they are
not claimed from memory.

## Exact acceptance commands

```bash
corepack pnpm install --frozen-lockfile
pnpm check                                              # boundary + lint + build + typecheck + format + test (all L0-L5, L12 validation, no real targets)

pnpm --filter @supadiff/spec test                        # L1
pnpm --filter @supadiff/engine test -- execution          # L2
pnpm test:observations                                    # L3 (packages/engine/test/observation)
pnpm test:secret-corpus                                   # L3 (packages/engine/test/secret-corpus)
pnpm test:comparison-honesty                               # L4 (packages/engine/test/comparison-honesty)

pnpm --filter @supadiff/spec build && \
pnpm --filter @supadiff/engine build && \
pnpm --filter supadiff build && \
node packages/cli/dist/bin.js run test/fixtures/basic.json \
  --target test/fixtures/fake-reference.json \
  --target test/fixtures/fake-match.json \
  --policy test/fixtures/basic-policy.json \
  --output json                                           # L5

pnpm test:integration:supalite                            # L6 — real, ~1 min, spawns real lite processes
pnpm test:integration:peer-data-auth-rls                  # L7 — real, ~2 min, Supalite + supabase-local (Docker); Data+Auth+RLS peer + failure modes
pnpm test:integration:upgrade-local                       # L8 — real, ~4 min, Supalite -> real `lite upgrade` -> supabase-local (Docker)
pnpm test:fault-lab:replay                                # L9 — dogfood fault lab + supadiff replay
pnpm test:fault-lab:reduce                                # L10 — supadiff reduce
pnpm test:integration:peer-storage                        # L11 — real, ~1 min, Supalite×2 + Supalite↔supabase-local Storage
pnpm test:generators                                      # L12 — byte-identical replay, preconditions, 10,000 validation-only generations (~1 min)
pnpm test:generated-smoke                                 # L12 — 5 generated scenarios against a real Supalite target (~30s)
```

L7/L8/L11's supabase-local suites need a working Docker host (`docker pull
hello-world` must succeed) and the pinned `supabase` CLI's images
(~5-8 GB on first run). They are not part of `pnpm check`.

`pnpm check` deliberately does **not** run L6/L9-L12's real-target or
fault-lab suites — they spawn real subprocesses/npm installs and are
excluded from the default gate via dedicated `vitest.integration.config.ts`/
`vitest.live-smoke.config.ts` files and `test/integration/**`/
`test/live-smoke/**` exclusions in each package's default `vitest.config.ts`,
so routine work stays fast and hermetic. They are never silently skipped in
CI either — see "Continuous integration" below.

## What each suite actually proves

- **L1** (`packages/spec/test`): a corpus of valid and invalid scenarios,
  comparison policies, target specs, and known-divergence entries; RFC 8785
  canonicalization characterization; builder-vs-hand-JSON digest equality.
- **L2** (`packages/engine/test/execution`): exact event ordering across two
  targets in lockstep, capture resolution, secret capture to vault,
  capability unsupported-before-mutation, runtime capability downgrade,
  identity-mismatch, timeout, target death, comparable-prefix preservation,
  retry legality (valid idempotent retry vs. rejected illegal retry),
  cleanup after every failure class, and recovery-journal tombstoning.
- **L3** (`packages/engine/test/observation`, `.../secret-corpus`):
  projector purity/determinism, token relationship without token equality,
  null-vs-missing preservation, unaccounted-field fail-closed behavior, and
  the secret corpus described in `docs/SECURITY.md`.
- **L4** (`packages/engine/test/comparison-honesty`): one mutation per
  contractual field must produce `new-divergence`; benign differences (key
  order, unordered rows) must not; known-divergence expiry, overlap, and
  per-dimension isolation (version/backend/path/rule/predicate/scenario/
  step/direction/capability each independently block a match); ambiguous
  rule selection throws rather than picking a winner; target-selector
  backend/semver-range matching and capability-context selection
  (`target-selector-and-capability.test.ts`); and dedicated adversarial
  coverage for all 13 `RuleExpression` kinds — type safety, subset/keyed
  multiplicity, relationship subject/object correspondence,
  `RedemptionContract`, `DeltaContract` — in `rule-algebra.test.ts`.
- **`ExecutionPlan`** (`packages/engine/test/execution/execution-plan.test.ts`):
  a plan cannot be frozen before every target's runtime identity/capability
  probe genuinely completed; a target identity mismatch refuses to produce
  a plan and the enclosing run finalizes `inconclusive`; capability
  resolution is present and populated; identical inputs produce identical
  plan content (`planId`, digests, target slots, capability resolution)
  across two builds differing only in `createdAt`; a different observed
  identity changes the content-derived `planId`; and the serialized plan
  contains no secrets or live endpoint URLs, including one built from a
  real run with actor secrets in play.
- **L5** (`packages/engine/test/artifact`, `packages/cli/test`): byte-
  identical bundle assembly, artifactId changes on payload change, blocked
  artifact on an unexplained secret leak, checksums covering every payload
  plus manifest excluding itself, malicious-path rejection (`../`,
  absolute, nested traversal), checksum-corruption detection via `inspect
artifact`, exact exit codes (0/10/20/30) under different `--fail-on`
  configurations, JSON-stdout purity (exactly one document), NDJSON event
  ordering, human stdout/stderr separation, and offline `compare` producing
  the same outcome as a live two-target `run` on identical fixtures.
- **L6** (`packages/targets/test/integration/supalite.test.ts`): the same
  ordinary scenario runs to completion on all four `supalite-*` target
  kinds against the real published `@supabase/lite@0.9.0` package — real
  process spawn, real HTTP, real `@supabase/supabase-js@2.97.0` client;
  owner-scoped RLS proven on the three RLS-capable backends; the bare
  `sqlite` backend's Auth/RLS gap proven to resolve `unsupported` (never a
  false pass or false failure) rather than being special-cased around.
- **L7** (`packages/targets/test/integration/peer-data-auth-rls.test.ts`):
  `scn.peer-data-auth-rls-smoke` (schema+RLS, signup, session read,
  owner-authorized insert, post-insert readback, owner select, anon select)
  runs to completion on `supalite-sqlite-postgres` (reference) and a real
  `supabase-local` stack (candidate); every compared observable path agrees,
  with target-local UUIDs/timestamps excluded per §9.3. Plus: killing the
  container stack mid-run → `target-lost` → `inconclusive`; a wrong requested
  CLI version → identity mismatch → `inconclusive` with no plan; two
  concurrent provisions get distinct project ids and ports; `forceCleanupProject`
  is idempotent.
- **L8** (`packages/targets/test/integration/upgrade-local.test.ts`, 4
  tests): the dry-run plans the §12 workflow without provisioning anything;
  `--require-storage` is **rejected before S0 is bootstrapped**; a transition
  failure after a real dry-run cleans up and leaks no containers; and
  `--execute` runs the real transition — a file-backed
  `supalite-sqlite-postgres` source, cloned into a retained baseline B and an
  upgrade-source U, then the real `lite upgrade --target local --dry-run` and
  real `lite upgrade --target local --local-dir <C>` into a fresh
  Supabase-local stack. Every property holds: source workdir untouched,
  baseline retained, row IDs + Auth logical subject preserved, deliberate
  corruption detected, pre-upgrade token rejected by C, the actor
  re-authenticates for the same subject, RLS behavior lockstep B vs C. The
  `sequence-next-use` check is a `divergence` (registered:
  `div.lite-upgrade-local-sequence-not-reset` — `lite upgrade` from a
  file-backed source does not carry the serial-sequence position), which the
  test accepts as `pass` or `divergence`.
- **L9** (`test/fault-lab/`): all six deliberately incompatible fault
  classes (§15.5: RLS leak, partial write, RETURNING leak, Auth subject
  swap, Storage owner loss, normalization trap) proven caught as
  `new-divergence`, and every benign counterpart proven not misclassified;
  `supadiff replay` rebuilds a comparison from a stored recipe and
  reproduces the identical classification.
- **L10** (`test/fault-lab/reduce.test.ts`): a multi-step scenario with
  provably prunable "noise" steps shrinks to the minimal reproducing set
  via `supadiff reduce`'s dependency-graph-aware ddmin pass; a flaky
  reproduction (fails the 3x pre-reduction stability check) is refused
  rather than reduced.
- **L11** (`packages/targets/test/integration/storage.test.ts` +
  `peer-storage-local.test.ts`): bucket creation, upload/download/copy
  byte-identity (real SHA-256 of real bytes, not metadata), list, remove,
  move, ownership, and signed-URL creation/redemption compared for real (a)
  between two independently provisioned real Supalite backends and (b)
  between a real `supabase-local` stack (reference) and a real
  `supalite-sqlite-postgres` backend (candidate). The Supalite ↔
  Supabase-local run shows byte-identity everywhere except signed-URL
  redemption — a genuine `new-divergence` without the registry, a
  `known-divergence` with it (`div.supalite-signed-url-key-name` /
  `-length`), asserted both through the comparator and directly against raw
  evidence (`docs/DIVERGENCES.md`).
- **L12** (`packages/generators/test/`): two independent generator runs
  with the same `{seed, count}` produce byte-identical canonical scenarios
  (`computeScenarioDigest` equality); a structural sweep over 200 generated
  scenarios proves no `data.update`/`data.delete` step ever targets a table
  without a prior tracked insert, and that the model's precondition check
  actually rejects at least one raw draw (not vacuously true); 10,000
  generations across 100 seeds all parse and canonicalize without
  throwing; 5 generated scenarios run to completion against a real
  `supalite-sqlite-postgres` target.

## Continuous integration

`.github/workflows/ci.yml` runs `pnpm install --frozen-lockfile` then
`pnpm check` on Node 22 with Corepack pinned to the exact `packageManager`
version in the root `package.json`, on every pull request targeting `main`
and every push to `main` — the safe, local, no-credentials gate. A second
job, `real-targets`, runs `pnpm test:integration:supalite`,
`pnpm test:fault-lab:replay`, `pnpm test:fault-lab:reduce`,
`pnpm test:generators`, and `pnpm test:generated-smoke` — no hosted
credentials, no Cartesian target matrix, no Docker. A third job,
`docker-targets` (GitHub's `ubuntu-latest` runners ship Docker), runs
`pnpm test:integration:peer-data-auth-rls`,
`pnpm test:integration:upgrade-local`, and
`pnpm test:integration:peer-storage` — L7/L8/L11 against a real
`supabase-local` stack brought up by the pinned `supabase` CLI. All jobs use
`concurrency` to cancel superseded runs on the same ref.

## Honesty gates actually enforced

- Boundary checker (`scripts/boundary-check.mjs`) fails the build on any
  forbidden cross-package import — verified by a self-test in an earlier
  session (a deliberately introduced violation was caught, then reverted).
- An ESLint `no-restricted-imports` rule fails the build if `fast-check` is
  imported anywhere outside `packages/generators/src/model/arbitraries.ts`
  (§10.1) — a real, mechanically enforced boundary, not just a comment.
- `pnpm check` runs boundary check, lint, build, typecheck, format check,
  and every package's default (fake-target/validation-only) tests in one
  command; it is the safe/local acceptance gate and passes cleanly as
  committed. The real-target suites above are a separate, explicit gate —
  never silently folded into `pnpm check` and never silently skipped.
- No test in this repository claims conformance with **hosted** Supabase
  (L13 is not implemented; `parseTargetSpec` rejects `supabase-hosted`).
  `FakeTargetDriver` is explicitly test infrastructure (§15.2) and every doc
  in `docs/` that mentions it says so; every L6/L7/L8/L11/L12-live-smoke test
  file says, in its own comments, exactly which real package/CLI/image
  version it is driving and why.

## Explicitly not built in this delivery

- `supabase-hosted` driver, and everything depending on it (L13) — out of
  scope for this sprint.
- L8 covers the **local** `lite upgrade --target local` transition (Supalite
  → Supabase-local); the hosted `--target hosted` path is not exercised.
  Storage byte preservation across the upgrade is `unsupported` (rejected
  before mutation when required), and `lite upgrade` from a file-backed
  source does not carry the serial-sequence position (a registered
  divergence, not a bug in `verify-upgrade`).
- Driver contract test suite generalized across arbitrary future drivers
  (§15.1 item 5) — only the Supalite family and `supabase-local` are
  exercised.
- Realtime, Edge Functions, a dashboard/UI, a generic fuzzing framework, or
  a generic database reducer — never in scope (Architecture Contract §20).
