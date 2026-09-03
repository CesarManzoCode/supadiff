# Architecture

This document summarizes what is actually implemented (L0-L5) and how it maps
to the Architecture Contract. It does not restate the contract; see the
contract itself for the normative design.

## Thesis

Given one validated logical scenario, two explicitly identified target
environments, and an explicit semantic comparison policy: do the resulting
observable behaviors satisfy the same application contract?

## Components implemented

| Component                                         | Package                               | Status                                                                                                                                                  |
| ------------------------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ScenarioSpec` parse/validate/canonicalize/digest | `@supadiff/spec`                      | Implemented                                                                                                                                             |
| Operation catalog (§2.4)                          | `@supadiff/spec`                      | Implemented, all IDs known; fake fixtures for 11 representative ops                                                                                     |
| Declarative TS builder                            | `@supadiff/spec`                      | Implemented (pure data constructors, no callbacks)                                                                                                      |
| Target SPI (`TargetDriver`/`TargetSession`)       | `@supadiff/engine/spi`                | Implemented                                                                                                                                             |
| Capability preflight/probe/resolution             | `@supadiff/engine`                    | Implemented                                                                                                                                             |
| `ExecutionPlan` (frozen, §2.3)                    | `@supadiff/spec` + `@supadiff/engine` | Implemented: built once after runtime capability probing via `buildExecutionPlan`, deterministic content (aside from `createdAt`), no secrets/endpoints |
| Target lifecycle state machine                    | `@supadiff/engine`                    | Implemented, illegal transitions rejected                                                                                                               |
| Lockstep scheduler                                | `@supadiff/engine`                    | Implemented                                                                                                                                             |
| SecretVault / CapturedValueStore                  | `@supadiff/engine`                    | Implemented                                                                                                                                             |
| Recovery journal                                  | `@supadiff/engine`                    | Implemented (write-before-allocate, tombstone-on-teardown)                                                                                              |
| Redaction (typed + structural)                    | `@supadiff/engine`                    | Implemented for the secret classes and operations exercised in L0-L5                                                                                    |
| Semantic projectors                               | `@supadiff/engine`                    | Implemented for 11 representative operations                                                                                                            |
| Comparator (rule algebra)                         | `@supadiff/engine`                    | Implemented, all 13 `RuleExpression` kinds                                                                                                              |
| Known-divergence registry                         | `@supadiff/spec` + `@supadiff/engine` | Implemented: schema, expiry, overlap detection                                                                                                          |
| Artifact bundle assembly                          | `@supadiff/engine`                    | Implemented as a deterministic directory tree                                                                                                           |
| CLI `run`/`compare`/`inspect`                     | `supadiff` (cli)                      | Implemented                                                                                                                                             |
| `FakeTargetDriver`                                | `@supadiff/engine`                    | Implemented, test infrastructure only (§15.2)                                                                                                           |
| Concrete Supalite/Supabase drivers                | `@supadiff/targets`                   | **Not implemented** (L6+)                                                                                                                               |
| Reducer                                           | `@supadiff/reducer`                   | **Not implemented** (L10)                                                                                                                               |
| Generators                                        | `@supadiff/generators`                | **Not implemented** (L12)                                                                                                                               |

## Package boundaries

Enforced mechanically by `scripts/boundary-check.mjs` (run as part of
`pnpm check`), per §13.2:

- `@supadiff/spec` imports nothing but pure libraries.
- `@supadiff/engine` imports only `@supadiff/spec`.
- `@supadiff/targets` imports only `@supadiff/spec` and `@supadiff/engine/spi`
  (never `@supadiff/engine`'s main entrypoint — that would reach comparison
  and scheduling internals).
- `@supadiff/reducer` imports `@supadiff/spec` and `@supadiff/engine`.
- `@supadiff/generators` imports only `@supadiff/spec`.
- `supadiff` (CLI) may import all of the above.

## Execution flow (as implemented)

```
parseScenarioSpec (spec)
  → runScenario (engine): declared-capability preflight
      → provision (write recovery intent first) → identify → probe capabilities
      → buildExecutionPlan (engine/planning): freeze ExecutionPlan — target
        identity mismatch here yields `inconclusive`, never a silent plan
      → actors opened → lockstep step execution (raw observation + redaction
        + semantic projection per step) → cleanup (reverse order) → teardown
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
