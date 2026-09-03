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

**Not yet implemented against real backends** (no OTP/recovery-code flow,
client-secret/JWT-secret/DB-password config redaction, or hosted-project-
identifier aliasing exist yet, because none of those flows exist without a
real Supabase/Supalite target — see `docs/LIMITATIONS.md`).

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

## What is out of scope for L0-L5

- Hosted safety flags (`--allow-hosted*`) are parsed but not enforced
  against anything real, because no hosted driver exists.
- No real HTTP transport exists, so header/query-string redaction is only
  exercised against fake-target fixtures, not a live client.
