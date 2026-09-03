# Trace format

This is the author/replay contract for what exists today: `ScenarioSpec`,
the operation catalog, reference resolution, and execution/failure
semantics as implemented in `@supadiff/spec` and `@supadiff/engine`.

## Format versions

| Format               | `format` string                 | Current version | Owner                                               |
| -------------------- | ------------------------------- | --------------- | --------------------------------------------------- |
| Scenario             | `supadiff.scenario`             | `1.0`           | `@supadiff/spec`                                    |
| Comparison policy    | `supadiff.comparison-policy`    | `1.0`           | `@supadiff/spec`                                    |
| Known divergence     | `supadiff.known-divergence`     | `1.0`           | `@supadiff/spec`                                    |
| Raw observation      | `supadiff.raw-observation`      | n/a (type only) | `@supadiff/spec` types, `@supadiff/engine` producer |
| Semantic observation | `supadiff.semantic-observation` | n/a (type only) | same                                                |
| Artifact manifest    | `supadiff.artifact`             | `1.0`           | `@supadiff/engine`                                  |

A scenario's `formatVersion` major component MUST be `1`; any other major
version is rejected at parse time (`unknown-major-version`).

## Scenario shape

See `packages/spec/src/scenario/types.ts` and
`packages/spec/src/scenario/schema.ts` for the authoritative shape (closed
JSON Schema, `additionalProperties: false` throughout). Summary:

```
ScenarioSpec { id, revision, seed, client, requirements, resources, actors,
               steps, cleanup, comparison, expectedOutcomes, limits, provenance }
StepSpec     { id, kind, phase, actor?, requires?, dependsOn?, input,
               capture?, observe?, timeoutMs?, retry?, onUnsupported? }
```

`kind` is a member of the operation catalog (`packages/spec/src/operation/catalog.ts`).
The catalog knows every operation ID listed in Architecture Contract §2.4;
only 11 representative operations have a semantic projector and are
exercised by fake-target fixtures in this delivery (see
`docs/OBSERVABLE_CONTRACT.md`).

## Operation ID casing

Operation IDs (`auth.signUp`, `storage.createSignedUrl`, ...) accept mixed
case, distinct from every other `StableId` in the system which is strictly
lowercase. See `docs/adr/0001-operation-id-casing.md`.

## Ordering and references

- `steps` is a total order; `dependsOn` may only reference strictly earlier
  steps (forward references are rejected).
- `{"$ref": "capture:<name>"}` may only reference a capture produced by a
  strictly earlier step (`parseScenarioSpec` rejects both unknown and
  forward capture references, and detects dependency cycles independently
  via the `dependsOn` graph as a second line of defense).
- `{"$secretRef": "<name>"}` resolves against either a generated actor
  credential recipe id or an external secret ref name, established when the
  actor is opened (`@supadiff/engine`'s `resolveRefs`).
- Secret-bearing fields are never resolved to literal strings inside a
  step's resolved input: they are normalized to `{"$secretRef": "<vault
handle>"}`, so a request payload never contains raw secret bytes even in
  memory beyond the driver dispatch boundary.

## Execution status vs. application outcome

Implemented exactly per §3.5's model:

```
StepExecutionStatus =
  "executed" | "skipped-requirement" | "blocked-dependency"
  | "unsupported-at-runtime" | "timed-out" | "cancelled"
  | "target-lost" | "harness-error"
```

An application-level error response (status ≥ 400 in this delivery's
"success"/"application-error"/"harness-failure" split) is still `executed`
and flows into raw/semantic observation and comparison. Only harness-level
failures (timeout, disconnect, process death, driver invariant violation)
change execution status away from `executed`.

## Retries

Scenario retries default to zero and are validated at plan time: a
`RetrySpec` on a non-catalog-idempotent operation without a stable
idempotency-key proof makes the whole run `invalid` before any target is
touched (`@supadiff/engine`'s `runScenario`). Every attempt is recorded
(`StepAttemptRecord`); only the final attempt participates in comparison.

## Cleanup

Scenario cleanup runs in reverse declaration order, after all steps, with an
independent timeout per item, and continues past individual cleanup
failures. A cleanup failure or leaked recovery-journal entry changes the run
terminal state to `inconclusive-cleanup`, never silently.
