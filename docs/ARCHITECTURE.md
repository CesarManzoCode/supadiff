# Architecture

This document summarizes what is actually implemented (L0-L12) and how it
maps to the Architecture Contract. It does not restate the contract; see the
contract itself for the normative design. L7 (Supabase-local) and L8 (upgrade
verification) were implemented on a real Docker host after being blocked in
the original sandbox — see `docs/LIMITATIONS.md`.

## Thesis

Given one validated logical scenario, two explicitly identified target
environments, and an explicit semantic comparison policy: do the resulting
observable behaviors satisfy the same application contract?

## Components implemented

| Component                                                        | Package                                 | Status                                                                                                                                                  |
| ---------------------------------------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ScenarioSpec` parse/validate/canonicalize/digest                | `@supadiff/spec`                        | Implemented                                                                                                                                             |
| Operation catalog (§2.4)                                         | `@supadiff/spec`                        | Implemented, all IDs known; 19 representative ops have a semantic projector (11 original + 8 for L11 Storage)                                           |
| Declarative TS builder                                           | `@supadiff/spec`                        | Implemented (pure data constructors, no callbacks)                                                                                                      |
| Target SPI (`TargetDriver`/`TargetSession`)                      | `@supadiff/engine/spi`                  | Implemented                                                                                                                                             |
| Capability preflight/probe/resolution                            | `@supadiff/engine`                      | Implemented                                                                                                                                             |
| `ExecutionPlan` (frozen, §2.3)                                   | `@supadiff/spec` + `@supadiff/engine`   | Implemented: built once after runtime capability probing via `buildExecutionPlan`, deterministic content (aside from `createdAt`), no secrets/endpoints |
| Target lifecycle state machine                                   | `@supadiff/engine`                      | Implemented, illegal transitions rejected                                                                                                               |
| Lockstep scheduler                                               | `@supadiff/engine`                      | Implemented                                                                                                                                             |
| SecretVault / CapturedValueStore                                 | `@supadiff/engine`                      | Implemented                                                                                                                                             |
| Recovery journal                                                 | `@supadiff/engine`                      | Implemented (write-before-allocate, tombstone-on-teardown)                                                                                              |
| Redaction (typed + structural)                                   | `@supadiff/engine`                      | Implemented for the secret classes and operations exercised in L0-L5                                                                                    |
| Semantic projectors                                              | `@supadiff/engine`                      | Implemented for 19 representative operations                                                                                                            |
| Comparator (rule algebra)                                        | `@supadiff/engine`                      | Implemented, all 13 `RuleExpression` kinds                                                                                                              |
| Known-divergence registry                                        | `@supadiff/spec` + `@supadiff/engine`   | Implemented: schema, expiry, overlap detection                                                                                                          |
| Artifact bundle assembly                                         | `@supadiff/engine`                      | Implemented as a deterministic directory tree                                                                                                           |
| CLI `run`/`compare`/`inspect`/`replay`/`reduce`/`verify-upgrade` | `supadiff` (cli)                        | Implemented; `verify-upgrade` runs the real §12 local-upgrade flow (L8), no longer a stub                                                               |
| `FakeTargetDriver`                                               | `@supadiff/engine`                      | Implemented, test infrastructure only (§15.2), also backs the L9 dogfood fault lab                                                                      |
| Concrete Supalite drivers (4 backends)                           | `@supadiff/targets`                     | Implemented, real `@supabase/lite@0.9.0` (L6)                                                                                                           |
| Shared Supabase REST dispatch                                    | `@supadiff/targets/src/shared`          | Implemented: one `@supabase/supabase-js@2.97.0` per-operation translation shared by the Supalite family and `supabase-local`                            |
| `supabase-local` driver                                          | `@supadiff/targets`                     | Implemented (L7): pinned `supabase` CLI 2.116.0 over Docker Compose; Data/Auth/native-RLS/Storage `exact`; `supabase-hosted` (L13) out of scope         |
| `verifyUpgrade` (local upgrade verification)                     | `@supadiff/targets`, `supadiff` (cli)   | Implemented (L8): mandatory dry-run, pg 15→17, new dest workdir, no session preservation, ID/sequence/Auth/RLS preservation, Storage unsupported        |
| Fault lab + `replay`                                             | `test/fault-lab/`, `supadiff` (cli)     | Implemented (L9)                                                                                                                                        |
| Reducer + `reduce`                                               | `@supadiff/reducer`, `supadiff` (cli)   | Implemented: dependency graph, ddmin, 3x flake gate, signature-identity oracle excluding `scenarioDigest` (L10)                                         |
| Storage peer comparison                                          | `@supadiff/targets`, `@supadiff/engine` | Implemented: 8 new operations/projectors, real byte-identity across two Supalite backends AND Supalite ↔ `supabase-local` (L11)                        |
| Known-divergence registry (populated)                            | `divergences/active/`                   | Two active entries: the Supalite `signedUrl`/`signedURL` sign-URL bug (`/bytesDigest`, `/contentLength`) vs `supabase-local` (L11)                      |
| Generators                                                       | `@supadiff/generators`                  | Implemented: `fast-check@4.9.0` adapter isolated to one module, Data+Auth+RLS domain model (L12)                                                        |

## Package boundaries

Enforced mechanically by `scripts/boundary-check.mjs` (run as part of
`pnpm check`), per §13.2:

- `@supadiff/spec` imports nothing but pure libraries.
- `@supadiff/engine` imports only `@supadiff/spec`.
- `@supadiff/targets` imports only `@supadiff/spec` and `@supadiff/engine/spi`
  (never `@supadiff/engine`'s main entrypoint — that would reach comparison
  and scheduling internals).
- `@supadiff/reducer` imports `@supadiff/spec` and `@supadiff/engine`.
- `@supadiff/generators` imports only `@supadiff/spec` and the pinned
  property adapter (`fast-check@4.9.0`), isolated to one module
  (`src/model/arbitraries.ts`) by an ESLint `no-restricted-imports` rule.
- `supadiff` (CLI) may import all of the above.

## Execution flow (as implemented)

```
parseScenarioSpec (spec)
  → runScenario (engine): declared-capability preflight
      → provision (write recovery intent first) → identify → probe capabilities
      → buildExecutionPlan (engine/planning): freeze ExecutionPlan — target
        identity mismatch here yields `inconclusive`, never a silent plan;
        each step's own capability requirements are also resolved once here
        into `ResolvedStep.targetRequirements`
      → actors opened → lockstep execution of `plan.orderedSteps` (not
        `scenario.steps` — the frozen plan is the scheduling authority; raw
        observation + redaction + semantic projection per step; captured
        values/`$ref`s are still resolved at runtime, never during
        planning) → cleanup (reverse order) → teardown
  → compareStep (engine, per step/path): rule selection (target selector +
      capability context, resolved from the frozen plan's capability
      resolution) → rule evaluation → known-divergence match (selector +
      expectedFailure predicate) → taxonomy classification
  → buildBundle (engine): assemble deterministic files, secret scan, artifactId
  → writeBundleDirectory (cli): write to disk
```

## Where this delivery required interpretation

See `docs/adr/` for the two points where the contract's own text was
internally ambiguous or silent and a decision had to be made without
superseding the contract:

- `docs/adr/0001-operation-id-casing.md`
- `docs/adr/0002-artifact-directory-format.md`
