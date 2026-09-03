# Targets

## Target kinds known to the system

`packages/spec/src/target/types.ts` declares all six `TargetKind` values
from §2.7 (`supabase-hosted`, `supabase-local`, `supalite-sqlite`,
`supalite-sqlite-postgres`, `supalite-pglite`, `supalite-postgres`), plus a
seventh, `fake`, used only for test infrastructure (§15.2).

## What has a driver

Only `fake` has a driver in this delivery: `FakeTargetDriver`
(`@supadiff/engine`'s `testing/fake-target.ts`). `parseTargetSpec`
(`@supadiff/spec`) rejects every other kind with
`unsupported-target-kind: target kind "..." has no driver in this build
(L6+)` — this is enforced at validation time, not just documented.

## `fake` target config

```json
{
  "id": "target.reference",
  "kind": "fake",
  "runtime": { "runtime": "node", "version": "22.10.0" },
  "config": {
    "scriptId": "some-id",
    "script": { "identity": ..., "declaredCapabilities": [...], "steps": {...}, "teardownStatus": "complete" }
  },
  "credentialRefs": [],
  "lifecycle": { ... },
  "safety": { ... }
}
```

`config.script` is a `FakeScript` (`@supadiff/engine`): per-step scripted
responses (status/body/category), declared and runtime-probed capabilities,
and a teardown status. It is **not** a durable driver contract — its shape
is intentionally not closed-schema-validated beyond `{type: "object"}`,
because it exists only so this delivery's CLI acceptance command and test
suite have something real to execute (§15.2: "Fake targets are test
infrastructure only and never accepted as evidence about Supabase or
Supalite").

## What L6+ will need to add (not started)

- Concrete `TargetDriver`/`TargetSession` implementations per §2.9 for each
  real kind, in `@supadiff/targets`, importing only `@supadiff/engine/spi`.
- Real capability declaration tied to measured package/backend versions
  (§2.8), not scripted fixtures.
- Real identity collection (§2.7's `TargetIdentity`), including the
  `sourceRevision`/`unknownSourceRevisionReason` handling described in
  Decision D-006 of the Architecture Contract.
- Deterministic naming and Docker/process lifecycle ownership per §4.3-§4.6.

This document intentionally says nothing more, because nothing more is
implemented.
