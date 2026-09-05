# SupaDiff

[Supalite](https://github.com/supabase-community/lite) promises to behave
like real Supabase, but "compatible" is a claim, not a guarantee. SupaDiff
checks that claim directly: it runs the same scenario against two real
targets — Supalite and a real Supabase stack (local via Docker, or a real
hosted Supabase project) — and compares their _observable_ behavior
(HTTP responses, redacted payloads, byte-for-byte storage content) instead of
comparing source code or specs. It is a deterministic, capability-aware
runner, not a request diff, a schema diff, an upstream-suite replacement, or
a generic fuzzer.

This isn't hypothetical: SupaDiff has already found real cross-target bugs.

- **Signed URL incompatibility.** Supalite 0.9.0's storage sign endpoint
  returns the JSON key `signedUrl` (lowercase) where the real Supabase
  Storage API returns `signedURL`. The official `@supabase/supabase-js`
  client only reads the capitalized key, so redeeming a signed URL through
  Supalite silently serves the wrong content with a `200 OK` instead of
  failing (`docs/DIVERGENCES.md`, `div.supalite-signed-url-key-name*`).
- **`lite upgrade` doesn't preserve the serial sequence**
  ([dswbx/lite-projects#69](https://github.com/dswbx/lite-projects/issues/69)).
  Migrating a file-backed Supalite project to a real Supabase-local stack
  moves the rows correctly but leaves the destination's serial sequence at
  its start value, so the first unqualified insert after upgrade collides on
  a duplicate key (`div.lite-upgrade-local-sequence-not-reset`).

Both are registered, reproducible known-divergences — not papered over, not
guessed from reading source.

## Quick example

```bash
supadiff verify-upgrade
```

This dry-runs the real Architecture Contract §12 transition — Supalite →
`lite upgrade` → Supabase-local — against Docker without mutating anything,
and prints exactly what a real upgrade would do (add `--execute` to run it
for real). See "`verify-upgrade`: reproduce a real Supalite → Supabase-local
investigation" below for the full command and the "Quick start" section for
a fake-target example that needs no Docker at all.

## What is proven right now

This repository implements Implementation DAG layers **L0-L14** of the
Architecture Contract: the deterministic comparison core (L0-L5, proven
against fake targets), a real Supalite target family (L6), a real
`supabase-local` target driver + Supalite ↔ Supabase-local peer comparison
(L7), Supalite → real `lite upgrade` → Supabase-local upgrade verification
(L8, `supadiff verify-upgrade`), a dogfood fault lab and replay (L9), a state-aware reducer (L10), Storage peer
comparison including Supalite ↔ Supabase-local (L11), seeded scenario
generation (L12), a real `supabase-hosted` target run against a real hosted
Supabase project (L13, opt-in), and a documentation/release-evidence gate
(L14, `pnpm docs:verify` + `pnpm release:evidence`). "Real" throughout this
document means the exact-pinned `@supabase/lite@0.9.0` package, a real
Supabase stack brought up by the pinned `supabase` CLI 2.116.0 over Docker,
or a real hosted Supabase project reached over its public API + the Supabase
Management API — never a fake target.

```
ScenarioSpec → validation → canonical ExecutionPlan
             → deterministic execution on fake, real Supalite, real
               supabase-local (Docker), OR real supabase-hosted targets
             → raw observations → redaction → semantic observations
             → semantic comparison → divergence classification
             → deterministic artifact
             → offline compare / inspect / replay / reduce / verify-upgrade
```

`docs/LIMITATIONS.md` is the authoritative, current list of what is and is
not proven — including the explicit accommodations inside L13 (hosted
`create-ephemeral` has no CI gate; hosted `auth.signUp` uses the real GoTrue
admin API — see `docs/adr/0003-hosted-signup-via-admin-api.md`).

## L7/L8: implemented on a real Docker host

L7 and L8 were blocked in the original Claude Code Web sandbox purely because
its egress proxy refused every Docker registry blob download (`docker pull
hello-world` → 403). On a real Docker host (`docker pull hello-world` → PASS)
they were implemented in full:

- **`supabase-local` driver** (`packages/targets/src/supabase-local/`): a
  full Supabase stack — Postgres + GoTrue + PostgREST + Storage API + Kong —
  provisioned by the reproducibly pinned `supabase` CLI 2.116.0 over Docker
  Compose. Pinning the CLI pins the image set. Same SPI shape as the Supalite
  drivers, sharing the entire `@supabase/supabase-js@2.97.0` per-operation
  dispatch with them.
- **`supadiff verify-upgrade`** (`packages/targets/src/supabase-local/
upgrade.ts`): mandatory dry-run, then the real Architecture Contract §12
  transition — a file-backed `supalite-sqlite-postgres` project is cloned
  into a retained **baseline B** and an **upgrade-source U**, then the real
  `lite upgrade --target local` migrates U into a **fresh Supabase-local
  stack C**. `--supalite-version <version>` selects which registered
  `SupalitePackageProfile` (`@supabase/lite` + its paired
  `@supabase/supabase-js` client, `packages/targets/src/supalite/
package-profile.ts`) governs the whole Supalite side of the run — omitted,
  it defaults to the historical `@supabase/lite@0.9.0` baseline; an
  unregistered version fails closed. Verifies: source workdir untouched,
  baseline retained, row IDs + Auth logical subject preserved, deliberate
  corruption detected, sessions _not_ preserved + the actor re-authenticates
  for the same subject, RLS behavior lockstep B vs C. The serial-sequence
  position is **not** carried by `lite upgrade` from a file-backed source
  (registered divergence `div.lite-upgrade-local-sequence-not-reset`);
  Storage preservation is unsupported and is **rejected before any mutation**
  when required. The old Postgres 15→17 `pg_dump` helper is removed — it was
  never §12.

## Requirements

- Node 22 (`>=22.0.0 <23.0.0`)
- pnpm 9.15.0 (pinned in `packageManager`; `corepack enable` gets you the
  pinned version automatically)
- Docker, for anything that touches `supabase-local` or `verify-upgrade`
  (L7, L8, L11) — not needed for `supadiff run` against fake targets or for
  the Supalite-only acceptance tests

## Setup

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm build

# make the `supadiff` command available on PATH (one-time; standard pnpm
# workspace mechanism, not an installer):
pnpm setup            # only if `pnpm link --global` below can't find a global bin dir yet
cd packages/cli && pnpm link --global && cd ../..

supadiff --help
```

`pnpm link --global` symlinks this workspace's `packages/cli` (whose
`package.json` declares `"bin": { "supadiff": "./dist/bin.js" }`) into
pnpm's global bin directory. From here on, every example below is the real
`supadiff` command — never `node packages/cli/dist/bin.js`.

## Quick start: one command against a fake target

```bash
supadiff run test/fixtures/basic.json \
  --target test/fixtures/fake-reference.json \
  --target test/fixtures/fake-match.json \
  --policy test/fixtures/basic-policy.json \
  --output json
```

This runs a two-step scenario (`auth.signUp` then `data.select`) against two
scripted fake targets in lockstep, redacts and projects every observation,
compares them under a real (if small) semantic rule policy, and writes a
deterministic evidence bundle to `./supadiff-artifacts/<run-id>.supadiff/`.

## `verify-upgrade`: reproduce a real Supalite → Supabase-local investigation

`supadiff verify-upgrade` is L8's public surface (see "L7/L8" above) — the
real Architecture Contract §12 transition, against Docker. Dry-run is
mandatory; nothing is provisioned or mutated without `--execute`.

```bash
# L8 dry-run against the default profile (@supabase/lite@0.9.0) — prints the
# §12 workflow, mutates nothing
supadiff verify-upgrade

# Reproduce the div.lite-upgrade-local-sequence-not-reset investigation
# against @supabase/lite@0.10.0 + @supabase/supabase-js@2.114.0 — the exact
# registered profile in packages/targets/src/supalite/package-profile.ts
supadiff verify-upgrade --supalite-version 0.10.0 --execute --output json
```

An unregistered `--supalite-version` fails closed with a clear error rather
than running an unpinned combination. See `docs/DIVERGENCES.md` for the
known-divergence registry and `docs/TARGETS.md` for the capability matrix
and the `supabase-local` driver architecture.

## Development / acceptance tests

These are the acceptance gates this repository is built against, not the
product's normal interface — a maintainer investigating or reproducing
behavior should reach for `supadiff <command>` above, not these.

```bash
# Real @supabase/lite@0.9.0 subprocesses, no Docker
pnpm test:integration:supalite            # L6: all 4 Supalite backends
pnpm test:generators && pnpm test:generated-smoke   # L12: generated scenarios + one live sample
pnpm test:fault-lab:replay                # L9: dogfood fault lab + `supadiff replay`
pnpm test:fault-lab:reduce                # L10: state-aware reducer

# Real supabase-local stack (pinned `supabase` CLI 2.116.0 over Docker) — needs Docker
pnpm test:integration:peer-data-auth-rls  # L7: Supalite <-> supabase-local (Data+Auth+RLS) + failure modes
pnpm test:integration:upgrade-local       # L8: verify-upgrade, real Supalite -> lite upgrade -> supabase-local
pnpm test:integration:peer-storage        # L11: Supalite x2 and Supalite <-> supabase-local Storage

# Real hosted Supabase project (opt-in) — needs SUPADIFF_HOSTED_ACCESS_TOKEN + SUPADIFF_HOSTED_PROJECT_REF
SUPADIFF_HOSTED=1 pnpm test:integration:hosted-smoke   # L13: real supabase-hosted Data+Auth+RLS + refusals + cleanup/recovery

# Documentation + release-evidence gate (no network, no credentials)
pnpm docs:verify                    # L14: docs <-> implementation <-> acceptance-command consistency
pnpm release:acceptance            # L14: run every acceptance gate, record real exit codes + sanitized logs
pnpm release:evidence               # L14: verify the recorded results + (re)generate release-evidence/v1.0.0.json
```

Every one of these talks to a real target over real HTTP via the real
`@supabase/supabase-js@2.97.0` client — none of it is scripted. See
`docs/TESTING.md` for what each command proves.

## Artifact example

```
supadiff-artifacts/run-scn.basic-1.supadiff/
  manifest.json                  # artifactId, content inventory, secret-scan receipt
  scenario/scenario.json
  policy/comparison-policy.json
  policy/known-divergences.json
  targets/{reference,candidate}.recipe.json
  targets/observed-identities.json
  targets/capabilities.json
  runs/{reference,candidate}/events.ndjson
  runs/{reference,candidate}/raw/*.json
  runs/{reference,candidate}/semantic/*.json
  comparison/results.json        # authoritative
  comparison/divergence-signature.json
  report/report.md               # derived, human-readable
  provenance/{toolchain,recovery-summary,secret-scan}.json
  checksums.sha256
```

Artifacts are written as deterministic directory trees (the contract's
alternate accepted format alongside a ZIP — see `docs/REPRODUCIBILITY.md`).

## Repository layout

```
packages/
  spec/        canonical types, JSON Schemas, RFC 8785 canonicalization, operation catalog
  engine/      planning, lockstep execution, redaction, comparator, artifact assembly
  targets/     concrete target drivers — real Supalite family (L6), real supabase-local (L7),
               real supabase-hosted (L13), shared REST dispatch,
               Supalite -> lite upgrade -> supabase-local verification (L8)
  reducer/     state-aware reduction (L10) — ddmin over the dependency graph, acceptance oracle
  generators/  seeded scenario generation (L12) — fast-check adapter, Data+Auth+RLS domain model
  cli/         supadiff CLI: run / compare / inspect / replay / reduce / verify-upgrade
scripts/docs-verify.mjs, release-evidence.mjs, release-acceptance.mjs   L14 documentation + release-evidence gates
release-evidence/v1.0.0.json                    versioned, self-verifying release manifest (L14)
release-evidence/acceptance/                    recorded acceptance-gate results + sanitized per-gate logs (L14)
scenarios/deterministic/              canonical L6/L7/L11 scenario fixtures (L13 reuses the L7 peer scenario)
divergences/active/                   known-divergence registry (signedUrl/signedURL + the L8 lite-upgrade sequence entry)
test/fixtures/, test/fault-lab/       the L0-L5 acceptance fixtures and the L9 dogfood fault lab
docs/                                  see below
```

## Documentation map

- `docs/ARCHITECTURE.md` — system boundaries and data flow
- `docs/TRACE_FORMAT.md` — scenario/plan/trace format contract
- `docs/OBSERVABLE_CONTRACT.md` — what SupaDiff judges, and how
- `docs/DIVERGENCES.md` — known-divergence registry governance
- `docs/REPRODUCIBILITY.md` — determinism, seeds, artifacts
- `docs/SECURITY.md` — secret handling and redaction threat model
- `docs/TESTING.md` — test pyramid and exact acceptance commands
- `docs/LIMITATIONS.md` — what is explicitly **not** proven yet
- `docs/adr/` — architecture decision records for interpretations this
  delivery had to make where the contract left room

## Explicit non-claims

SupaDiff's README **does not** claim:

- Hosted `create-ephemeral` project provisioning is covered by a real
  acceptance gate — it is implemented and safety-gated, but only
  `attach-explicit` against a real hosted project has a passing gate (L13).
  Hosted `auth.signUp` is exercised through the public mailer flow — the
  driver uses the real GoTrue admin API instead (see
  `docs/adr/0003-hosted-signup-via-admin-api.md`)
- The full Architecture Contract §12 upgrade surface is covered — L8 runs the
  real `lite upgrade --target local` transition (Supalite → Supabase-local)
  and verifies row-ID + Auth-subject preservation, session non-preservation +
  actor reauthentication, and RLS behavior lockstep. The serial-sequence
  position is **not** carried by `lite upgrade` from a file-backed source
  (registered divergence, not papered over); Storage byte preservation is
  `unsupported` and is rejected before any mutation when required; hosted
  (`--target hosted`) upgrades are not exercised
- A generic fuzzing framework or generic database reducer exists — L10's
  reducer and L12's generator are both scoped to SupaDiff's own domain model
  (Data+Auth+RLS scenarios), not general-purpose tools
- Realtime, Edge Functions, or a dashboard/UI are covered — never in scope

`docs/LIMITATIONS.md` is the authoritative, current list of what is and is
not proven — read it before citing any result from this repository.
