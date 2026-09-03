# Observable contract

What SupaDiff judges, and how — as implemented for the 19 representative
operations this delivery projects and compares (the original 11, plus 8
added for L11's Storage surface). All 19 are exercised for real against
`@supabase/lite@0.9.0` where a real driver exists (L6/L11); every other
catalog operation still executes but produces no semantic observation.

## Pipeline

```
transport capture → typed secret redaction → structural secret detection
  → immutable raw observation → operation-specific semantic projector
  → field-coverage validation → immutable semantic observation
```

Implemented in `@supadiff/engine`:
`observation/redact.ts` (typed + structural), `observation/raw.ts`
(`RawObservation` assembly), `observation/projectors/*.ts` (pure
projectors), `observation/coverage.ts` (field accounting).

## Projectors implemented

| Operation                   | Contractual fields                                             | Diagnostic fields                                   | Notes                                                                                                        |
| --------------------------- | -------------------------------------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `auth.signUp@1`             | `/status`, `/user/id`, `/user/email`                           | —                                                   | session presence as a state fact; `session.belongs-to-actor` relationship, never token equality              |
| `auth.signInWithPassword@1` | same shape as `auth.signUp@1`                                  | —                                                   |                                                                                                              |
| `auth.refreshSession@1`     | same shape                                                     | —                                                   |                                                                                                              |
| `data.select@1`             | `/status`, `/rows`                                             | —                                                   | `/count` is explicitly ignored (receipt-backed), not silently dropped                                        |
| `data.insert@1`             | `/status`, `/rows`                                             | —                                                   |                                                                                                              |
| `observe.dataReadback@1`    | `/status`, `/rows`                                             | —                                                   |                                                                                                              |
| `storage.createSignedUrl@1` | `/path`, `/expiresAt`                                          | `/signedUrl` (redacted marker only — never the URL) | `storage.signedurl-issued-for-path` relationship                                                             |
| `storage.redeemUrl@1`       | `/status`, `/bytesDigest`, `/contentLength`                    | —                                                   | judges redemption behavior, never the URL string; L11 found a real Supalite bug here (`docs/DIVERGENCES.md`) |
| `storage.createBucket@1`    | `/status`, `/name`                                             | —                                                   | L11                                                                                                          |
| `storage.upload@1`          | `/status`, `/path`, `/bytesDigest`, `/contentLength`, `/owner` | —                                                   | L11; digest/length from real uploaded bytes, not metadata                                                    |
| `storage.download@1`        | `/status`, `/bytesDigest`, `/contentLength`                    | —                                                   | L11; digest/length from real downloaded bytes                                                                |
| `storage.list@1`            | `/status`, `/entries`                                          | —                                                   | L11                                                                                                          |
| `storage.remove@1`          | `/status`, `/removed`                                          | —                                                   | L11                                                                                                          |
| `storage.move@1`            | `/status`                                                      | —                                                   | L11                                                                                                          |
| `storage.copy@1`            | `/status`, `/bytesDigest`                                      | —                                                   | L11; digest of the copy, from real downloaded bytes                                                          |
| `observe.storageObject@1`   | `/owner`, `/bytesDigest`, `/contentLength`                     | —                                                   | L11; `storage.owner-equals` relationship                                                                     |
| `cli.invoke@1`              | `/exitCode`                                                    | `/stdout`, `/stderr`                                | raw text is diagnostic unless the scenario declares structured output                                        |
| `observe.authSession@1`     | `/active`, `/subject`, `/role`                                 | —                                                   |                                                                                                              |
| `assert.invariant@1`        | `/satisfied`                                                   | `/detail`                                           |                                                                                                              |

Every other catalog operation (§2.4) is known to the catalog (validated,
capability-gated) but has no projector wired in this delivery — a step using
one still executes (against a fake target, or a real Supalite target where
one of L6/L11's operations is used), but produces no semantic observation
and therefore is not compared. This is a scope limit, not a silent
behavior: `docs/LIMITATIONS.md` records it.

## Field coverage and fail-closed behavior

`computeCoverage` walks the full JSON tree of a raw response body,
recursively, and classifies every field at every depth into exactly one of:
`contractualFields`, `diagnosticFields`, `ignoredFields`, or
`unassessedFields` (RFC 6901 `~0`/`~1` escaping applied to composed
pointers). A field not accounted for by the first three — at any nesting
depth, inside objects or arrays — becomes `unassessedFields`, and
`compareStep` (`@supadiff/engine`) turns every unassessed field into its own
`inconclusive` `ComparisonResult` — it never silently drops it.

**Contractual atomic subtree rule:** when a path is declared exactly (in
`contractual`, `diagnostic`, or `ignored`), traversal stops there — its
children are never individually walked and therefore can never become
`unassessed`. This is intentional: a projector that declares e.g. `/rows` or
`/session` as one opaque contractual value is delegating that subtree's
internal judgment to a downstream comparison rule (an `unordered-collection`
over `/rows`, for example), not asking field coverage to also police its
internals field-by-field.

## Redaction policy implemented

See `docs/SECURITY.md` for the full secret-class table and threat model.

## Comparison rule algebra

All 13 `RuleExpression` kinds from §7.1 are implemented in
`@supadiff/engine`'s `comparison/rule-engine.ts`: `exact`, `object`,
`ordered-collection`, `unordered-collection`, `subset`, `error-category`,
`relationship`, `invariant`, `token-claims`, `temporal-invariant`,
`url-redemption`, `state-readback`, `explicit-ignore` — each with dedicated
adversarial test coverage in `comparison-honesty` (see `docs/TESTING.md`).
Type safety is real: `object`/`ordered-collection`/`unordered-collection`/
`subset` never coerce a non-object to `{}` or a non-array to `[]`; a type
mismatch fails rather than risking an accidental match. `subset` and keyed
`unordered-collection` use the declared `item` sub-rule (not raw canonical
equality) with one-to-one multiplicity, and a duplicate key on either side
fails closed instead of an ambiguous pick. `relationship` requires the same
subject _and_ object on both sides, not just predicate presence.
`url-redemption` applies `RedemptionContract` (`expectStatusCategory`,
`bytesMustMatch`) and never touches a URL string. `state-readback` uses the
declared `before`/`after` pointers and `DeltaContract`
(`expectedChangedPaths`/`expectedUnchangedPaths`) to judge an actual delta.

## Rule selection

`selectRule` (`@supadiff/engine`) matches on
`service + operationId + operationVersion + observablePath + reference/candidate
target kind + backend + bounded semver versionRange + capabilityContext`
(the target-selector dimensions are real matches against
`TargetSelectionIdentity`, using the `semver` library for range checks — a
rule scoped to `supalite-sqlite@0.9.x` does not match
`supalite-postgres@0.9.x` or a version outside `0.9.x`), and picks the most
specific match by counting how many optional selector fields are pinned. A
capability-scoped rule (`selector.capabilityContext`) is only selectable
when that capability actually resolved (declared+probed, gated by the
requirement's `accept` list) to something other than `unsupported` for the
comparison in play — never inferred from error-message strings. Two equally
specific matches throw `AmbiguousRuleSelectionError` rather than picking
one — this is enforced at comparison time in this delivery (the contract
frames it as a compile-time guarantee; a static policy linter that runs at
"compile" time before any run is a natural extension, not yet built).
