# Security

## Threat model

The primary threat this layer defends against: a secret value (password,
API key, session token, signed URL, ...) touched during a scenario run
leaking into any persisted or logged artifact — the plan, the trace, the
comparison artifact, a log line, an error message, a filename, or the
recovery journal (§1.2 invariant 12, §6.4).

## What "raw" means

"Raw" does **not** mean secrets are persisted. A `RawObservation` is
structurally faithful _after_ mandatory security redaction (§6.1's pipeline
critical rule), never before.

## Redaction — implemented secret classes

| Secret class                                      | Where redacted                                                                                                                            | Persisted form                                                                                                  |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Password                                          | Request body (`redactRequestBody`, keyed by field-name heuristic on the resolved `{$secretRef}` marker)                                   | `{"$secret":"password","handle":"sec-..."}`                                                                     |
| JWT access token                                  | Response body, declared per-operation in `RESPONSE_SECRET_FIELDS` (`auth.signUp@1`, `auth.signInWithPassword@1`, `auth.refreshSession@1`) | `{"$secret":"jwt-access-token","handle":"sec-..."}`                                                             |
| Refresh token                                     | Same table                                                                                                                                | `{"$secret":"refresh-token","handle":"sec-..."}`                                                                |
| Signed URL                                        | `storage.createSignedUrl@1` response `/signedUrl`                                                                                         | `{"$secret":"signed-url","handle":"sec-..."}` — the projector never emits the URL string as a contractual field |
| Generic API key / other request secret-ref fields | Request body, via the operation catalog's `secretBearingInputFields` + resolveRefs normalization                                          | `{"$secret":"api-key" or field-derived class,"handle":"sec-..."}`                                               |

Secret bytes live only in `InMemorySecretVault`, addressed by opaque
handles, and are wiped (`destroy()`) at the end of `runScenario`. Only
driver-internal dispatch code calls `vault.reveal()`.

Password, JWT-access-token, refresh-token, and signed-URL redaction are now
also exercised against a real target: L6/L11's integration tests run real
`auth.signUp`/`storage.createSignedUrl` calls against a real
`@supabase/lite@0.9.0` server, and the redaction pipeline above (not a fake-
target substitute) processes every real response.

**Still not exercised end to end** (no OTP/recovery-code flow). The
`supabase-hosted` driver (L13) holds a Supabase Management API access token
and the project's anon/service_role keys; they go straight into the
`SecretVault`, never appear in a `RawOperationResult`, the recovery handle
is the non-secret `hosted-namespace:<ref>:<runNamespace>` string, and the
hosted evidence log is redacted against the run's known secret literals
before it is surfaced. The `supabase-local` driver (L7/L8) does hold real DB
passwords and JWT secrets
in memory; they are put into the `SecretVault` and never appear in a
`RawOperationResult`, but a dedicated config-redaction corpus for them is
not yet part of the secret-corpus suite.

## Structural secret detector (secondary defense)

`observation/detectors.ts`: JWT shape, `sb_publishable_`/`sb_secret_`
prefixes, `Authorization: Bearer`, signed query parameters, PEM blocks,
configured secret literals, and a high-entropy heuristic. The detector
explicitly excludes:

- content-hash digests (`sha256:<64 hex>`, pure hex strings ≥16 chars) —
  these are pervasive by design (`sourceRawDigest`, checksums, artifact
  content refs) and are not secrets;
- opaque vault/capture/resource handles (`sec-...`, `cap-...`, `res-...`);
- the `handle` field of a `{"$secret", "handle"}` redaction receipt marker.

A detector hit not explained by typed redaction is fail-closed: `buildBundle`
sets `secretScanPassed: false` and the CLI refuses to write a successful
artifact (exit 20), per §6.4 and the L5 "DO NOT WRITE SUCCESSFUL ARTIFACT"
requirement.

## Secret corpus tests

`packages/engine/test/secret-corpus/no-leak.test.ts` injects distinct
high-entropy literals per secret class into fake responses and asserts none
of them appear anywhere in raw observations, semantic observations, events,
lifecycle records, cleanup results, or thrown error messages — for a
successful run and for one caught runtime error. `packages/engine/test/artifact/bundle.test.ts`
proves a deliberately unredacted PEM leak is caught (`secretScanPassed: false`)
before it would reach a written artifact.

## Recovery journal

Recovery-journal entries carry only `resourceType`, `nonSecretIdentifier`
(the target slot name in this delivery's fake provider), `creationIntent`,
and `cleanupAction` — never a credential. Tested directly in the secret
corpus suite.

## What remains out of scope

- Hosted safety flags (`--allow-hosted*`) are enforced by the
  `supabase-hosted` driver (L13): `SUPADIFF_HOSTED=1` and
  `spec.safety.allowHosted` are both required, `create-ephemeral` also
  requires `allowHostedCreate`, the cost estimate is checked against
  `maxHostedCostUsd`, and an attached project holding pre-existing `public`
  tables / Storage buckets / auth users is refused unless
  `allowHostedDestructive` is set — all before any side effect.
- Real HTTP transport exists for the Supalite family (L6/L11), for
  `supabase-local` (L7/L8/L11), and for `supabase-hosted` (L13), so
  header/query-string redaction is exercised for real against all three,
  not only against fake-target fixtures (see `docs/LIMITATIONS.md`).
