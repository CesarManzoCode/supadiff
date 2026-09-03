# Contributing

This repository implements Implementation DAG layers L0-L6 and L9-L12 of
the Architecture Contract. L7 (Supabase-local) and L8 (upgrade
verification) are not implemented — blocked in this environment by Docker
registry access, not by design; L13/L14 were out of scope. Read
`docs/LIMITATIONS.md` before assuming any capability beyond what it lists.

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

## Adding a target driver

The Supalite family (`packages/targets/src/supalite/`) is the worked
example: `TargetDriver`/`TargetSession` (`@supadiff/engine/spi`) in
`@supadiff/targets`, importing only the `spi` entrypoint — never
`@supadiff/engine`'s main entrypoint. The boundary checker
(`scripts/boundary-check.mjs`) will reject the wrong import. A
`supabase-local` driver would follow the same shape (Docker Compose-
provisioned instead of `lite start`-provisioned) — not started in this
sprint because this environment cannot run Docker (see
`docs/LIMITATIONS.md`), not because the design is undecided.

Never write driver code for a target you cannot actually run and verify in
this environment. A driver that has never executed against the real thing
it claims to drive is not evidence of anything, and claiming a layer
complete on the strength of unexecuted code is exactly the overclaiming
this project exists to prevent. Precisely document the blocker instead
(`docs/LIMITATIONS.md`) and continue with other, unblocked work.

## Required evidence for any change

- A failing test before the fix, passing after, for bug fixes.
- Updated `docs/LIMITATIONS.md` if the change narrows or widens a
  documented gap.
- An ADR under `docs/adr/` only for a genuinely new interpretation of an
  ambiguous contract point — never to casually override a closed decision.
  If a change would supersede a contract decision, it is a `CONTRACT_CONFLICT`
  to raise for review, not something to implement.
