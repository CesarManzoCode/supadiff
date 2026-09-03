# Observable contract

What SupaDiff judges, and how — as implemented for the 11 representative
operations this delivery projects and compares.

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

| Operation                   | Contractual fields                          | Diagnostic fields                                   | Notes                                                                                           |
| --------------------------- | ------------------------------------------- | --------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `auth.signUp@1`             | `/status`, `/user/id`, `/user/email`        | —                                                   | session presence as a state fact; `session.belongs-to-actor` relationship, never token equality |
| `auth.signInWithPassword@1` | same shape as `auth.signUp@1`               | —                                                   |                                                                                                 |
| `auth.refreshSession@1`     | same shape                                  | —                                                   |                                                                                                 |
| `data.select@1`             | `/status`, `/rows`                          | —                                                   | `/count` is explicitly ignored (receipt-backed), not silently dropped                           |
| `data.insert@1`             | `/status`, `/rows`                          | —                                                   |                                                                                                 |
| `observe.dataReadback@1`    | `/status`, `/rows`                          | —                                                   |                                                                                                 |
| `storage.createSignedUrl@1` | `/path`, `/expiresAt`                       | `/signedUrl` (redacted marker only — never the URL) | `storage.signedurl-issued-for-path` relationship                                                |
| `storage.redeemUrl@1`       | `/status`, `/bytesDigest`, `/contentLength` | —                                                   | judges redemption behavior, never the URL string                                                |
| `cli.invoke@1`              | `/exitCode`                                 | `/stdout`, `/stderr`                                | raw text is diagnostic unless the scenario declares structured output                           |
| `observe.authSession@1`     | `/active`, `/subject`, `/role`              | —                                                   |                                                                                                 |
| `assert.invariant@1`        | `/satisfied`                                | `/detail`                                           |                                                                                                 |

Every other catalog operation (§2.4) is known to the catalog (validated,
capability-gated) but has no projector wired in this delivery — a step using
one still executes against a fake target, but produces no semantic
observation and therefore is not compared. This is a scope limit, not a
silent behavior: `docs/LIMITATIONS.md` records it.

## Field coverage and fail-closed behavior

`computeCoverage` classifies every top-level key of a raw response body into
exactly one of: `contractualFields`, `diagnosticFields`, `ignoredFields`, or
`unassessedFields`. A key not accounted for by the first three becomes
`unassessedFields`, and `compareStep` (`@supadiff/engine`) turns every
unassessed field into its own `inconclusive` `ComparisonResult` — it never
silently drops it. Coverage is computed one level deep (top-level response
keys); this is a scoped simplification recorded in `docs/LIMITATIONS.md`,
not arbitrary-depth accounting.

## Redaction policy implemented

See `docs/SECURITY.md` for the full secret-class table and threat model.

## Comparison rule algebra

All 13 `RuleExpression` kinds from §7.1 are implemented in
`@supadiff/engine`'s `comparison/rule-engine.ts`: `exact`, `object`,
`ordered-collection`, `unordered-collection`, `subset`, `error-category`,
`relationship`, `invariant`, `token-claims`, `temporal-invariant`,
`url-redemption`, `state-readback`, `explicit-ignore`. Depth of test
coverage varies — see `docs/TESTING.md` and `docs/LIMITATIONS.md`.

## Rule selection

`selectRule` (`@supadiff/engine`) matches on
`service + operationId + operationVersion + observablePath + reference/candidate
target kind (+ optional backend/versionRange) + optional capabilityContext`,
and picks the most specific match by counting how many optional selector
fields are pinned. Two equally specific matches throw
`AmbiguousRuleSelectionError` rather than picking one — this is enforced at
comparison time in this delivery (the contract frames it as a compile-time
guarantee; a static policy linter that runs at "compile" time before any run
is a natural extension, not yet built).
