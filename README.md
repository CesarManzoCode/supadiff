# SupaDiff

SupaDiff is a deterministic, capability-aware runner for comparing observable
application behavior across stateful scenario executions. It is not a request
diff, a schema diff, an upstream-suite replacement, or a generic fuzzer.

## What is proven right now

This repository implements Implementation DAG layers **L0-L6, L9-L12** of
the Architecture Contract: the deterministic comparison core (L0-L5, proven
against fake targets), a real Supalite target family (L6), a dogfood fault
lab and replay (L9), a state-aware reducer (L10), Storage peer comparison
(L11), and seeded scenario generation (L12) — all exercised against the
real, exact-pinned `@supabase/lite@0.9.0` package, never a fake target,
wherever this document says "real."

```
ScenarioSpec → validation → canonical ExecutionPlan
             → deterministic execution on fake OR real Supalite targets
             → raw observations → redaction → semantic observations
             → semantic comparison → divergence classification
             → deterministic artifact
             → offline compare / inspect / replay / reduce via CLI
```

**L7 (Supabase-local) and L8 (upgrade verification) are not implemented.**
Both require running a real Docker container, and this environment's egress
proxy returns `403 Forbidden` on the Docker registry's blob CDN for every
image pull, including `hello-world` — confirmed, not assumed. See
"Supabase-local: blocked" below and `docs/LIMITATIONS.md`.

Nothing in this repository claims Supabase-local, hosted Supabase, or
Supabase's own upgrade behavior has been observed. See `docs/LIMITATIONS.md`
for the full, current list of what is and is not proven.

## Supabase-local: blocked

```
$ docker pull hello-world
Using default tag: latest
latest: Pulling from library/hello-world
failed to copy: httpReadSeeker: failed open: failed to do request: Get
"https://production.cloudfront.docker.com/registry-v2/...": Forbidden
```

`docker ps` and registry auth/manifest endpoints work; only the blob-CDN
download itself is refused by this sandbox's network policy. Every attempt
to pull any image (including `alpine:3.20`) fails identically. This blocks
L7 (a real `supabase-local` target, normally Docker Compose-provisioned)
and L8 (Docker-based local upgrade verification) at the execution level —
not a design gap, an environment one. `verify-upgrade` remains wired into
the CLI and returns exit 30 ("not implemented"), same as before this
sprint; no `supabase-local` driver was written, because writing one that
has never actually run against the thing it claims to drive would be
exactly the overclaiming this project exists to prevent.

## One real command against a fake target

```bash
corepack pnpm install --frozen-lockfile
pnpm --filter @supadiff/spec build
pnpm --filter @supadiff/engine build
pnpm --filter supadiff build

node packages/cli/dist/bin.js run test/fixtures/basic.json \
  --target test/fixtures/fake-reference.json \
  --target test/fixtures/fake-match.json \
  --policy test/fixtures/basic-policy.json \
  --output json
```

This runs a two-step scenario (`auth.signUp` then `data.select`) against two
scripted fake targets in lockstep, redacts and projects every observation,
compares them under a real (if small) semantic rule policy, and writes a
deterministic evidence bundle to `./supadiff-artifacts/<run-id>.supadiff/`.

## One real command against a real target

```bash
corepack pnpm install --frozen-lockfile
pnpm test:integration:supalite          # L6: real @supabase/lite@0.9.0, all 4 backends
pnpm test:integration:peer-storage      # L11: real Storage peer comparison
pnpm test:generators && pnpm test:generated-smoke   # L12: generated scenarios, one live sample
pnpm test:fault-lab:replay              # L9: dogfood fault lab + `supadiff replay`
pnpm test:fault-lab:reduce              # L10: state-aware reducer
```

Every one of these spawns a real `lite start` subprocess and talks to it
over real HTTP via the real `@supabase/supabase-js@2.97.0` client — none of
this is scripted. See `docs/TESTING.md` for what each command actually
proves and `docs/TARGETS.md` for the per-backend capability matrix.

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
  targets/     concrete target drivers — real Supalite family (L6); no supabase-local (L7, blocked)
  reducer/     state-aware reduction (L10) — ddmin over the dependency graph, acceptance oracle
  generators/  seeded scenario generation (L12) — fast-check adapter, Data+Auth+RLS domain model
  cli/         supadiff CLI: run / compare / inspect / replay / reduce (verify-upgrade: not implemented)
scenarios/deterministic/              canonical L6/L11 scenario fixtures
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

- Supabase-local comparison works (L7 — blocked by this environment's Docker
  registry access, see above; no driver was written)
- Supabase-local upgrade verification works (L8 — same blocker)
- Real Supabase (hosted) comparison works (L13 — out of scope for this sprint)
- Real Supalite ↔ Supabase-local Storage comparison works — L11's Storage
  evidence is real Supalite-vs-Supalite (two independent backends), not
  Supalite-vs-Supabase-local, because L7 is blocked; see `docs/DIVERGENCES.md`
  for the one genuine, reproduced Supalite bug this sprint's testing found
  along the way (a Storage signed-URL response field-name mismatch)
- A generic fuzzing framework or generic database reducer exists — L10's
  reducer and L12's generator are both scoped to SupaDiff's own domain model
  (Data+Auth+RLS scenarios), not general-purpose tools

`docs/LIMITATIONS.md` is the authoritative, current list of what is and is
not proven — read it before citing any result from this repository.
