# Limitations

This document exists to prevent overclaiming. Read it before citing any
result from this repository.

## Scope: L0-L5 only

Nothing below has been implemented or tested: concrete Supalite/Supabase
drivers (L6-L7), upgrade verification (L8), the fault lab and replay (L9),
the state-aware reducer (L10), Storage peer comparison (L11), scenario
generation (L12), a hosted target (L13), or the documentation/release
evidence gate (L14). Every mention of "Supabase" or "Supalite" in this
repository's code and docs is either (a) a target _kind_ enum value with no
driver behind it, correctly rejected by `parseTargetSpec` with
`unsupported-target-kind`, or (b) a citation of the Architecture Contract /
Technical Ground Truth documents. Nothing has been run against a real
backend.

## Scoped simplifications inside L0-L5

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
   no effect, because no hosted or local-Supabase driver exists to gate.

4. **`verify-upgrade`, `replay`, and `reduce`** are wired into the CLI's
   command dispatch and explicitly return "not implemented" (exit 30) —
   they do not pretend to have any capability, per the task's explicit
   instruction.

5. **Target identity mismatch detection is exact-match only.** §2.7 allows
   "unless the target policy explicitly permits a range" as an exception to
   a requested-vs-observed version mismatch producing an inconclusive
   outcome; no such range-permitting policy field is modeled yet in
   `TargetSpec`/`TargetLifecyclePolicy`, so `buildExecutionPlan` currently
   requires an exact string match between a declared
   `TargetSpec.package.version` and the observed
   `TargetIdentity.implementationVersion` whenever a package version is
   declared at all. This is strictly more conservative than the contract
   requires (an exact-only check can never silently pass a real drift), not
   a gap in the fail-closed guarantee itself.

### Previously tracked simplifications closed in this hardening pass

The following gaps were tracked here in an earlier revision of this
document and are now closed (kept here, not deleted, so the history of what
changed and why is auditable):

- Field coverage now walks the full JSON tree recursively (was: top-level
  keys only), with an explicit "contractual atomic subtree" rule so a
  projector-declared opaque field's children are never spuriously
  `unassessed`. See `docs/OBSERVABLE_CONTRACT.md`.
- `matchKnownDivergence` now evaluates `expectedFailure` against real
  observed failure facts, not selector-exact-only matching. See
  `docs/DIVERGENCES.md`.
- All 13 `RuleExpression` kinds now have dedicated adversarial test
  coverage, and the previously presence-only kinds (`relationship`,
  `url-redemption`, `state-readback`) now judge real semantic content
  (subject/object correspondence, `RedemptionContract`, `DeltaContract`
  respectively). `subset` and keyed `unordered-collection` use the
  declared item rule with one-to-one multiplicity instead of raw/canonical
  equality. `object`/array rule kinds never coerce a type mismatch into an
  accidental empty-value match. See `docs/OBSERVABLE_CONTRACT.md`.
- `selectRule` now matches real target `backend` and a bounded `semver`
  `versionRange`, and capability-scoped rule selection is driven by the
  frozen capability resolution rather than being unreachable. See
  `docs/OBSERVABLE_CONTRACT.md`.
- `compareCommand`'s single-artifact mode now distinguishes a "run"
  artifact from a "comparison" artifact via `manifest.artifactKind` and
  refuses a bare run artifact with an explicit error, instead of returning
  an empty result set as if it were a real (if trivial) comparison.
- The CLI no longer synthesizes a silent empty-rules comparison policy for
  a multi-target `run` when `--policy` is omitted; it fails validation,
  before any target is provisioned, and validates that a supplied
  `--policy` agrees with the scenario's declared `comparison` ref.
- `ExecutionPlan` (§2.3) is now a real, separately built, frozen value
  object (`buildExecutionPlan`, `@supadiff/engine`) rather than only a
  named FSM state — see `docs/ARCHITECTURE.md`.
- The plan is now the actual scheduling authority, not just a recorded
  artifact alongside a re-planning executor. `ResolvedStep` (§2.3) carries
  everything execution needs per step — actor, `dependsOn`, `capture`,
  `observe`, `timeoutMs`/`retry`, `onUnsupported`, and a per-target
  `targetRequirements[].unsupported` decision resolved once during planning
  from that target's declared/probed capabilities. `runScenario`'s
  execution loop now iterates `plan.orderedSteps` and reads that frozen
  decision; it no longer iterates `scenario.steps` or calls
  `resolveCapability` again to decide whether a step runs.
  `ResolvedStep.input` still keeps `$ref`/capture placeholders exactly as
  authored — captured values are, by design (§2.6), resolved at runtime as
  earlier steps produce them, never during planning; that laziness was
  mischaracterized here before as an unresolved gap.

## What is proven, precisely

- Untrusted scenario/target/policy/divergence JSON either becomes one
  immutable, hash-stable, canonically-serializable AST, or is rejected
  before any effect (L1).
- The same execution plan against the same fake-target scripts produces the
  same event order, every time, and cleanup runs after every terminal path
  including target loss, timeout, capability-unsupported, and cleanup
  failure itself (L2).
- Raw and semantic observations for 11 representative operations carry
  useful, attributable evidence with zero secret leakage across raw,
  semantic, event, lifecycle, cleanup, error-message, and artifact surfaces,
  proven with injected high-entropy literals per secret class (L3).
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

**SupaDiff's deterministic comparison core is implemented and proven
against controlled fake targets. Real Supabase/Supalite target integration
has not yet been implemented.**
