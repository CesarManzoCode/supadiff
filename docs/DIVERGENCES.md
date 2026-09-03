# Divergence registry governance

## Taxonomy (§8)

```
match-exact | match-semantic | accepted-approximation | unsupported
  | known-divergence | new-divergence | inconclusive
```

Implemented exactly as this closed set in `@supadiff/spec`'s
`ComparisonOutcome` type; there is no `EXPECTED_DIFFERENCE` bucket.

## Entry schema

One JSON file per entry (`packages/spec/src/divergence/types.ts` and
`schema.ts`), validated by `parseKnownDivergence`:

- `id`, `title`, `status` (`active` | `fixed-pending-verification` |
  `resolved` | `wont-fix`)
- `referenceSelector` / `candidateSelector` (target kind, optional
  backend/versionRange — **`"*"` is rejected** for `versionRange`)
- `scenarioSelector`, `stepSelector`, `observableSelector` (**`"*"` is
  rejected** for `observableSelector`)
- `rule` (id + version of the comparison rule this entry excuses)
- `expectedFailure` (a `PredicateAst`)
- `rationale`, `evidence` (at least one), `owner`
- `verifiedAt` / `expiresAt` (`expiresAt` must be after `verifiedAt`)

## Matching (`@supadiff/engine`'s `matchKnownDivergence`)

An entry matches a failed comparison only when **every** selector and the
rule id/version match exactly, `status === "active"`, and the current time
is before `expiresAt`. Implemented outcomes:

- Zero matching active entries → `new-divergence`.
- Exactly one → `known-divergence` (the result carries `divergenceId`).
- More than one matching active entry → `inconclusive` (registry error,
  never picked arbitrarily — this is a first-class test, see
  `packages/engine/test/comparison-honesty/mutation-and-benign.test.ts`).
- All matching entries expired → treated as no match (`new-divergence`).

## Scope limit on failure-predicate matching

`expectedFailure.predicate` (a `PredicateAst`) is part of the persisted,
validated entry shape, but this delivery's matcher does not yet evaluate it
against the actual failure's facts — matching is selector-exact (id/version/
path/rule/target-kind/scenario/step), not predicate-evaluated. A registry
entry therefore currently excuses _any_ failure at its exact selector, not
only one matching its stated `expectedFailure` condition. This is recorded
here and in `docs/LIMITATIONS.md`; the predicate schema and evaluator
(`@supadiff/engine`'s `evaluatePredicate`) already exist and are used
elsewhere (`invariant`/`temporal-invariant` rules) — wiring them into
divergence matching is a bounded follow-up, not a redesign.

## Directory convention

`divergences/active/*.json` — loaded by the CLI (`--divergences <dir>`,
default `./divergences/active`) via `loadKnownDivergences`.
`divergences/resolved/` is provided for entries moved out of active status;
nothing currently reads it automatically (resolved entries never classify
new runs per the contract; keeping them out of the active-loaded directory
achieves the same effect today).
