# Contributing

This repository implements Implementation DAG layers L0-L5 of the
Architecture Contract. Read `docs/LIMITATIONS.md` before assuming any
capability beyond what it lists.

## Before changing anything

1. Read the relevant section of the Architecture Contract. Package
   boundaries, `ScenarioSpec`/`ExecutionPlan` semantics, the target SPI,
   scheduling, redaction, the comparison rule algebra, the artifact format,
   the CLI contract, and exit codes are closed decisions — do not
   reinterpret them locally. See the repository-root task instructions for
   the exact list.
2. Run `pnpm check` before and after your change (boundary check, lint,
   typecheck, format check, tests for every package).

## Adding an operation to the catalog

Edit `packages/spec/src/operation/catalog.ts`: add an `OperationDefinition`
with `id`, `version`, `service`, `inputSchema` (closed JSON Schema),
`secretBearingInputFields`, `outputRawCategory`, `projectorId`,
`idempotency`, and `capabilitiesRequired`. Add the same ID to
`STEP_KINDS` in `packages/spec/src/scenario/schema.ts`. A catalog entry
without a wired projector (`@supadiff/engine`'s `observation/registry.ts`)
is valid — it will execute and validate but produce no semantic observation
or comparison result; document that gap in `docs/OBSERVABLE_CONTRACT.md`
if you add one.

## Adding a projector

Add a pure `Projector` function (`raw: RawObservation) => SemanticObservation`)
under `packages/engine/src/observation/projectors/`, register it in
`registry.ts`, and update the table in `docs/OBSERVABLE_CONTRACT.md`. A
projector must not query a target or access another target's result
(§6.1). Add both a false-match mutation test and a benign-difference test
in `packages/engine/test/comparison-honesty/` for any comparison rule that
exercises it.

## Adding a comparison rule usage

Rules live in comparison-policy JSON files (see
`test/fixtures/basic-policy.json` for a worked example), not in code. If
you need a new rule _kind_, that is a change to the closed algebra in §7.1
and requires a contract change first — do not add one locally.

## Adding a known-divergence entry

One JSON file per entry under `divergences/active/`, validated by
`parseKnownDivergence`. `*` is rejected for `versionRange` and
`observableSelector` — always name the exact path and range. See
`docs/DIVERGENCES.md` for the matching semantics this delivery actually
implements (selector-exact, not yet predicate-evaluated).

## Adding a target driver (L6+, not started in this delivery)

Out of scope for the current layer. When it begins: implement
`TargetDriver`/`TargetSession` (`@supadiff/engine/spi`) in
`@supadiff/targets`, importing only the `spi` entrypoint — never
`@supadiff/engine`'s main entrypoint. The boundary checker
(`scripts/boundary-check.mjs`) will reject the wrong import.

## Required evidence for any change

- A failing test before the fix, passing after, for bug fixes.
- Updated `docs/LIMITATIONS.md` if the change narrows or widens a
  documented gap.
- An ADR under `docs/adr/` only for a genuinely new interpretation of an
  ambiguous contract point — never to casually override a closed decision.
  If a change would supersede a contract decision, it is a `CONTRACT_CONFLICT`
  to raise for review, not something to implement.
