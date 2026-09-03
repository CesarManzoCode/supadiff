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

An entry matches a failed comparison only when **all** of the following
hold: reference/candidate target selector (kind, backend, bounded semver
version range — real `semver` range matching, not string equality),
scenario selector (including `revisionRange` when declared), step selector,
observable path, rule id/version, `capability` (when declared, against the
capability actually resolved for this comparison), `status === "active"`,
the current time is before `expiresAt`, **and** `expectedFailure` (a
`PredicateAst`) evaluates `true` against the real observed failure facts
(`{reference: {...}, candidate: {...}}` over each side's contract fields —
reusing the same `evaluatePredicate` the `invariant`/`temporal-invariant`
rule kinds use). An entry can never match on error text alone, and a
registry entry registered for one failure never reclassifies a structurally
similar but factually different failure on the same selector. Implemented
outcomes:

- Zero matching entries (structural or predicate) → `new-divergence`.
- Exactly one predicate-matching active, non-expired entry →
  `known-divergence` (the result carries `divergenceId`).
- More than one matching active entry → `inconclusive` (registry error,
  never picked arbitrarily — this is a first-class test, see
  `packages/engine/test/comparison-honesty/mutation-and-benign.test.ts` and
  `target-selector-and-capability.test.ts`).
- A structurally matching entry that has expired → `new-divergence` plus an
  `expired-registry-entry` diagnostic transformation on the explanation,
  rather than silently falling through to a plain new-divergence with no
  trace that a now-expired entry once covered this failure.

## A real finding this sprint did not register as a `KnownDivergence` entry

L11's Storage testing found and reproduced a real bug: `@supabase/lite@
0.9.0`'s sign-URL endpoint returns JSON key `signedUrl`, but the real
Supabase Storage API contract — and the official `@supabase/storage-js`
client bundled in `supabase-js` — reads `signedURL`. See
`docs/LIMITATIONS.md` ("The signedUrl/signedURL divergence") for the full
reproduction, and `storage.signed-url.redeem` in `packages/targets/src/
supalite/capabilities.ts` for the capability-level record.

This is **not** entered here as a `KnownDivergence` JSON file, deliberately:
a `KnownDivergence` entry excuses a specific, already-classified
**cross-target** `new-divergence` — a real discrepancy between a reference
and a candidate target's observed behavior on the same comparison. This bug
is not that. It is the same Supalite server behaving identically broken on
both sides of the only real peer comparison this sprint could run
(`supalite-sqlite-postgres` vs. `supalite-pglite` — Supabase-local, the
literal reference this bug is really a divergence _against_, is blocked by
this environment's Docker access; see `docs/LIMITATIONS.md`). SupaDiff's
comparator correctly reports it as `match-exact` (both sides agree), not
`new-divergence` — there is nothing to excuse in this system's own terms
until a working Supabase-local peer exists to actually surface the
discrepancy. Registering a `KnownDivergence` entry with a `supabase-local`
`referenceSelector` today would assert a match against a target this sprint
never ran, which is exactly the kind of unverifiable claim this document's
matching semantics exist to prevent. Once L7 unblocks, this bug is the
first real candidate for a genuine `KnownDivergence` entry.

## Directory convention

`divergences/active/*.json` — loaded by the CLI (`--divergences <dir>`,
default `./divergences/active`) via `loadKnownDivergences`.
`divergences/resolved/` is provided for entries moved out of active status;
nothing currently reads it automatically (resolved entries never classify
new runs per the contract; keeping them out of the active-loaded directory
achieves the same effect today).
