# SupaDiff

SupaDiff is a deterministic, capability-aware runner for comparing observable
application behavior across stateful scenario executions. It is not a request
diff, a schema diff, an upstream-suite replacement, or a generic fuzzer.

## What is proven right now

This repository currently implements **Implementation DAG layers L0-L5** of
`docs/adr/../SupaDiff_Architecture_Contract.md`: the deterministic comparison
core, proven end-to-end against controlled **fake targets** only.

```
ScenarioSpec → validation → canonical ExecutionPlan
             → deterministic execution on fake targets
             → raw observations → redaction → semantic observations
             → semantic comparison → divergence classification
             → deterministic artifact
             → offline compare / inspect via CLI
```

**Real Supabase and Supalite target integration has not been implemented.**
Nothing in this repository has been run against real Supabase, Supalite, or
any hosted service. See `docs/LIMITATIONS.md` for the full list of what is
not yet proven.

## One real command

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
  targets/     concrete target drivers — placeholder, not implemented (L6+)
  reducer/     state-aware reduction — placeholder, not implemented (L10)
  generators/  scenario generation — placeholder, not implemented (L12)
  cli/         supadiff CLI: run / compare / inspect
scenarios/, policies/, divergences/   fixtures and registries
test/fixtures/                        the L5 acceptance fixtures
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

- Supabase comparison works
- Supalite comparison works
- Upgrade verification works
- Storage is verified
- A reducer exists
- A scenario generator exists

All of the above are later Implementation DAG layers (L6-L14), not started.
