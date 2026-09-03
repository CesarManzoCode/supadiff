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

## Active entries: the Supalite `signedUrl`/`signedURL` sign-URL bug

`divergences/active/supalite-signed-url-key-name.json` and
`...-length.json` — the first genuine `KnownDivergence` entries in this
repository. L11's Storage testing found that `@supabase/lite@0.9.0`'s
sign-URL endpoint returns the JSON key `signedUrl` (lowercase), while
`supabase/storage-api@v1.70.3` returns `signedURL` (capital) — which is what
the official `@supabase/storage-js@2.97.0` client reads to build
`createSignedUrl()`'s URL. Confirmed against **both real targets** once L7
unblocked:

- **reference** `supabase-local`: `createSignedUrl()` → the client redeems
  the real uploaded bytes, HTTP 200.
- **candidate** `supalite-sqlite-postgres`: the client's URL is undefined,
  the scenario redeems `${baseUrl}/storage/v1undefined`, and Supalite serves
  its admin HTML with HTTP 200 — a successful-looking response carrying the
  wrong content.

So it is a genuine cross-target `new-divergence` at `scn.supalite-storage-
smoke` `step.redeem` on `/bytesDigest` and `/contentLength`: identical
inputs, both HTTP 200, different bytes. Each entry's `expectedFailure`
predicate asserts exactly that shape (`/candidate/status == 200 &&
/reference/status == 200 && /candidate/<field> != /reference/<field>`), so it
never reclassifies a structurally similar but factually different failure.
`packages/targets/test/integration/peer-storage-local.test.ts` proves the
comparator reports `new-divergence` without the registry and
`known-divergence` (with `divergenceId`) with it. The same bug reproduces
identically on `supalite-pglite`/`supalite-postgres` (see `docs/TARGETS.md`);
a separate entry would be added if a scenario exercises those as the
candidate. The Supalite capability record `storage.signed-url.redeem =
unsupported` is unchanged.

## Directory convention

`divergences/active/*.json` — loaded by the CLI (`--divergences <dir>`,
default `./divergences/active`) via `loadKnownDivergences`.
`divergences/resolved/` is provided for entries moved out of active status;
nothing currently reads it automatically (resolved entries never classify
new runs per the contract; keeping them out of the active-loaded directory
achieves the same effect today).
