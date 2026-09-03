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

1. **Field coverage is one level deep.** `computeCoverage`
   (`@supadiff/engine`) accounts for top-level response-body keys only, not
   arbitrary nesting. A field two levels deep that a projector doesn't
   consume will not be flagged `unassessed` unless it happens to be a
   top-level key. §7.3's fail-closed guarantee is real but shallower than
   an arbitrary-depth walk would give.

2. **Known-divergence matching is selector-exact, not predicate-evaluated.**
   `matchKnownDivergence` matches on id/version/path/rule/target-kind/
   scenario/step exactly, but does not yet evaluate `expectedFailure`
   (a `PredicateAst`) against the actual failure. An entry currently excuses
   any failure at its exact selector, not only one matching its stated
   condition. See `docs/DIVERGENCES.md`.

3. **`token-claims`, `temporal-invariant`, `url-redemption`, and
   `state-readback` rule kinds are implemented but thinly exercised.** All
   13 `RuleExpression` kinds type-check and evaluate correctly on their own
   terms (verified by direct unit coverage of `exact`, `object`,
   `ordered-collection`, `unordered-collection`, `subset`, `error-category`,
   `relationship`, `invariant`, `explicit-ignore` in
   `comparison-honesty` tests), but the four listed here have no dedicated
   test beyond type-checking, because no fixture in this delivery emits
   decoded JWT claims, a bounded timestamp fact, or a stateful before/after
   readback pair.

4. **Operation catalog IDs use a distinct, case-permitting identifier
   pattern** from every other `StableId` in the system, to reconcile a
   direct contradiction between §2.1 and §2.4's literal examples. See
   `docs/adr/0001-operation-id-casing.md`.

5. **Artifacts are directory trees, not ZIP files**, per the contract's own
   "or" in §9.1. See `docs/adr/0002-artifact-directory-format.md`.

6. **`compareCommand`'s single-artifact re-render mode** does not
   distinguish a "run" artifact (no `comparison/results.json` content) from
   a "comparison" artifact — both currently contain a `comparison/
results.json` file (empty for a run artifact), so pointing `compare` at
   a bare run artifact returns an empty result set rather than a distinct
   error.

7. **CLI `--policy` is a required-in-practice flag** for a meaningful `run`;
   the contract's CLI contract (§14.1) does not specify how the comparison
   policy file is located, only that a scenario references one by
   `policyId`/`policyVersion`. This delivery requires the operator to pass
   `--policy <path>` explicitly (default: an empty-rules policy, which
   makes every observable path `inconclusive` for lack of a matching rule).

8. **Hosted safety flags are parsed, not enforced.** `--allow-hosted`,
   `--allow-hosted-create`, `--allow-hosted-destructive`,
   `--max-hosted-cost-usd` are accepted by the CLI argument parser but have
   no effect, because no hosted or local-Supabase driver exists to gate.

9. **`verify-upgrade`, `replay`, and `reduce`** are wired into the CLI's
   command dispatch and explicitly return "not implemented" (exit 30) —
   they do not pretend to have any capability, per the task's explicit
   instruction.

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
