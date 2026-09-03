# ADR-0001: Operation catalog IDs use a case-permitting pattern distinct from author StableIds

## Context

§2.1 of the Architecture Contract states persisted IDs MUST match
`^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$` — strictly lowercase. §2.4's own
operation catalog listing, however, literally names operations
`auth.signUp`, `auth.signInWithPassword`, `storage.createSignedUrl`,
`storage.redeemUrl`, `storage.createBucket`, `observe.dataReadback`,
`observe.authSession`, `observe.storageObject`, `observe.schemaSurface`,
`observe.projectTree` — all containing uppercase letters, and these names
mirror `supabase-js` method names on purpose. Applying §2.1's pattern
literally to these names, as first implemented, made every scenario
referencing them fail schema validation.

## Decision

Operation catalog IDs (`OperationDefinition.id`, and every `{id, version}`
reference to a catalog operation: `StepSpec.kind`, `RuleSelector.operationId`,
`ObservationRequest.operation.id`, `CleanupSpec.operation.id`) are validated
against a separate pattern: `^[a-zA-Z][a-zA-Z0-9]*(?:[._-][a-zA-Z0-9]+)*$`.
Every other `StableId` (scenario id, step id, actor id, capture name,
comparison rule id, known-divergence id, target id, credential recipe id)
keeps the strict lowercase pattern from §2.1 unchanged.

## Alternatives considered

1. **Lowercase the catalog** (`auth.signup`, `storage.createsignedurl`, ...).
   Rejected: this contradicts the contract's own literal listing in §2.4 and
   would silently diverge from `supabase-js` method names, which is the
   stated design intent of naming operations after them.
2. **Loosen `StableId` globally** to allow mixed case. Rejected: this weakens
   §2.1's guarantee for every author-chosen identifier (scenario/step/actor
   ids), which the contract clearly intends to be lowercase-normalized.

## Evidence

- §2.1: `Persisted IDs MUST match ^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$`
- §2.4: literal operation catalog listing with camelCase names.

## Consequences

Two identifier grammars now exist in the spec package instead of one. This is
documented here and in the schema source (`comparison/schema.ts`,
`scenario/schema.ts`) rather than silently applied. If a future contract
revision resolves this conflict explicitly, this ADR should be superseded
rather than the code silently drifting further from either reading.
